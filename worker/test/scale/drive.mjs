// Drives the scale test's network from inside its container (docs/scale-test-plan.md):
//   test/scale/scale.sh drive <step> [options]
// Steps run in order the first time (setup), and each scenario can be run again on its own afterwards.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { machineOf, pool, Site, sleep, tools, toolsAddress, withCpu } from "./lib.mjs";
import { seeded } from "./social.mjs";

// A network error that isn't any request's (a connection reset between requests, say) is noted, not the end of a run
// that may have hours to go: each request's own failures still reach whoever made it. Anything else still stops it.
process.on("uncaughtException", (error) => {
  if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(/** @type {any} */ (error).code)) {
    console.error(`Network error outside a request, carrying on: ${error.message}`);
    return;
  }
  throw error;
});

const NET = JSON.parse(readFileSync("/out/net.json", "utf8"));
const STATE_FILE = "/data/drive-state.json";
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { sites: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));

// Every site, with its workerd process, machine and port.
const all = NET.processes.flatMap((p, i) => p.sites.map((s) => ({ ...s, proc: i, machine: machineOf(p), port: p.port, tools: toolsAddress(p, i) })));
// drive.mjs runs on the first machine (net.mjs --machines): it measures CPU through workerd's inspector, which only
// listens there, so the sites it measures (hubs and groups) are there too.
const HERE = machineOf(NET.processes[0]);
if ((process.env.SCALE_MACHINE ?? "127.0.0.1") !== HERE) throw new Error(`Run drive.mjs on the first machine, ${HERE}.`);
if (all.some((s) => s.role !== "leaf" && s.machine !== HERE)) throw new Error(`The hubs and groups must be on the first machine, ${HERE}.`);
const byHost = new Map(all.map((s) => [s.host, s]));
const people = all.filter((s) => !s.group);
const number = (s) => s.host.slice(1, s.host.indexOf("."));
const ownerName = (s) => s.role === "hub" ? `Sam Taylor ${Number(number(s))}` : `Ann Example ${number(s)}`;

/** The site as its signed-in owner. */
export function owner(host) {
  const info = byHost.get(host);
  const site = new Site(host, info.machine, info.port);
  for (const [k, v] of Object.entries(state.sites[host]?.cookies ?? {})) site.cookies.set(k, v);
  return site;
}

async function waitUp() {
  for (let i = 0; ; i++) {
    const answers = await Promise.all(NET.processes.map((p) => new Site(p.sites[0].host, machineOf(p), p.port).fetch("/_version").then((r) => r.status, () => 0)));
    if (answers.every((s) => s === 200)) return;
    if (i > 600) throw new Error("The sites didn't start.");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const POSTS = 30; // each site's own posts (a friend's feed sends their newest 30)
// How many at once while setting up. Each friendship waits on a chain of calls between sites, so this, not the
// servers, set the pace (a dress rehearsal on 2 servers made 86 a second with 48 at once, the servers at a load of 1).
const AT_ONCE = Number(process.env.SCALE_AT_ONCE ?? (NET.model === "social" ? 256 : 48));

/** `work`, tried up to `times` times, a little longer apart each time: what fails now often works a moment later. */
async function retry(times, work) {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (error) {
      if (i >= times) throw error;
      await sleep(1000 * i);
    }
  }
}

/**
 * Setting up carries on past a few failures (each noted), and only gives up if more than `share` of `what` failed:
 * then something's broken, and the run is better stopped (and the servers powered off) than run on half a network.
 */
function tooMany(failed, total, what, share = 0.02) {
  if (failed > total * share) throw new Error(`${failed} of ${total} ${what} failed: more than ${share * 100}%, so stopping`);
}
const PHOTO_EVERY = 4; // 1 post in 4 has a photo
// A made-up photo and its thumbnail, in KB: smaller in the social model, whose 3,000 sites would otherwise hold 4 GB of
// them (what's stored, and how, is the same whatever the size).
const PHOTO_KB = NET.model === "social" ? [60, 10] : [150, 25];

// The social model's friendships (net.mjs --model social): each site's friends, and its circles (social.mjs).
const friendsOf = new Map();
const circlesOf = new Map();
if (NET.edges) {
  for (let i = 0; i < NET.edges.length; i += 2) {
    const [a, b] = [NET.people[NET.edges[i]], NET.people[NET.edges[i + 1]]];
    if (!friendsOf.has(a)) friendsOf.set(a, []);
    if (!friendsOf.has(b)) friendsOf.set(b, []);
    friendsOf.get(a).push(b);
    friendsOf.get(b).push(a);
  }
  NET.circles.forEach((members, c) => { for (const i of members) { const h = NET.people[i]; if (!circlesOf.has(h)) circlesOf.set(h, new Set()); circlesOf.get(h).add(c); } });
}

/** A made-up photo: JPEG markers round random bytes (the site stores and hashes it, and never decodes it). */
function photo(kb) {
  const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(kb * 1024), Buffer.from([0xff, 0xd9])]);
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}

/** Writes a post as the owner of `site`, with a made-up photo if `withPhoto`. */
export async function writePost(site, text, withPhoto) {
  const photos = [];
  if (withPhoto) {
    const full = photo(PHOTO_KB[0]);
    const thumb = photo(PHOTO_KB[1]);
    for (const f of [full, thumb]) {
      const put = await site.fetch(`/_admin/import/files/${f.hash}`, { method: "PUT", body: f.body, headers: { "Content-Type": "image/jpeg" } });
      if (put.status !== 200) throw new Error(`${site.host}: photo ${put.status} ${put.text.slice(0, 200)}`);
    }
    photos.push({ hash: full.hash, thumb_hash: thumb.hash, width: 2560, height: 1920, size: full.body.length });
  }
  const r = await site.fetch("/_admin/posts", { method: "POST", body: { text, photos } });
  if (r.status !== 200) throw new Error(`${site.host}: post ${r.status} ${r.text.slice(0, 200)}`);
}

/**
 * Who is friends with whom: the social model's list (net.json edges); otherwise each hub with the first N leaves, and
 * each leaf with the 5 after it, round the ring (10 each).
 */
function friendships() {
  if (NET.edges) {
    const pairs = [];
    for (let i = 0; i < NET.edges.length; i += 2) pairs.push([NET.people[NET.edges[i]], NET.people[NET.edges[i + 1]]]);
    return pairs;
  }
  const leaves = all.filter((s) => s.role === "leaf");
  const pairs = [];
  for (const hub of all.filter((s) => s.role === "hub")) for (const leaf of leaves.slice(0, hub.friends)) pairs.push([hub.host, leaf.host]);
  if (leaves.length > 1) {
    const reach = Math.min(5, Math.floor((leaves.length - 1) / 2));
    for (let i = 0; i < leaves.length; i++) {
      for (let d = 1; d <= reach; d++) pairs.push([leaves[i].host, leaves[(i + d) % leaves.length].host]);
    }
  }
  return pairs;
}

const steps = {
  /** Each person's site gets its owner, signed in with a passkey made here. */
  async owners() {
    await waitUp();
    const todo = people.filter((s) => !state.sites[s.host]?.cookies);
    let done = 0;
    let failed = 0;
    await pool(todo, Math.max(16, AT_ONCE / 4), async (s) => {
      try {
        await retry(3, async () => {
          const { link } = await tools(s.tools, "/owner", { host: s.host, name: ownerName(s) });
          const site = new Site(s.host, s.machine, s.port);
          await site.signInWith(link);
          state.sites[s.host] = { cookies: Object.fromEntries(site.cookies) };
        });
      } catch (error) {
        failed++;
        console.error(`${s.host}: no owner: ${error.message}`);
      }
      if (++done % 50 === 0) {
        save();
        console.log(`${done}/${todo.length} owners`);
      }
    });
    save();
    console.log(`Owners: ${people.length - failed} sites signed in, ${failed} failed.`);
    tooMany(failed, people.length, "owners");
  },

  /** Each person's site gets its own posts, before it has friends (so no notes go out). */
  async posts() {
    const todo = people.filter((s) => state.sites[s.host]?.cookies && !state.sites[s.host].posted);
    let done = 0;
    let failed = 0;
    await pool(todo, Math.max(12, AT_ONCE / 4), async (s) => {
      const site = owner(s.host);
      for (let n = 1; n <= POSTS; n++) {
        try {
          await retry(3, () => writePost(site, `Post ${n} from ${ownerName(s)}: a made-up post for the scale test.`, n % PHOTO_EVERY === 0));
        } catch (error) {
          failed++;
          if (failed <= 50) console.error(`${s.host}: post ${n}: ${error.message}`);
        }
      }
      state.sites[s.host].posted = POSTS;
      if (++done % 50 === 0) {
        save();
        console.log(`${done}/${todo.length} sites posted`);
      }
    });
    save();
    console.log(`Posts: ${POSTS} each on ${todo.length} sites, ${failed} failed.`);
    tooMany(failed, todo.length * POSTS, "posts");
  },

  /**
   * Friend links made, pasted and approved, as people do it (connect.js): a block of friendships at a time, then
   * everyone who made a link in it lets in whoever's asking (Friends → Approve). Progress is kept by the block, so a
   * run that stops carries on from the block it was in: a friendship made already is simply already there.
   */
  async friends() {
    const BLOCK = 5000;
    // In a shuffled order (the same every time), so each block is spread over thousands of sites: in the list's own
    // order a block was a few people with hundreds each, and each site answers one request at a time, so it went no
    // faster however many were asked at once. A run that began in the list's own order (before this) carries on
    // shuffling only what it hadn't done.
    const listed = friendships();
    if (!state.friendOrder) {
      state.friendOrder = { from: Math.min(listed.length, (state.friendBlocks ?? 0) * BLOCK) };
      state.friendShuffledBlocks = 0;
      save();
    }
    const random = seeded(4242);
    const pairs = listed.slice(state.friendOrder.from);
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    let failed = 0;
    let approved = 0;
    const missed = []; // tried again once at the end
    const started = Date.now();
    for (let b = state.friendShuffledBlocks; b * BLOCK < pairs.length; b++) {
      const block = pairs.slice(b * BLOCK, (b + 1) * BLOCK);
      await pool(block, AT_ONCE, async ([a, other]) => {
        try {
          const made = await owner(a).fetch("/_admin/connections/link", { method: "POST", body: {} });
          if (made.status !== 200) throw new Error(`link ${made.status} ${made.text.slice(0, 120)}`);
          const { link } = made.json();
          const added = await owner(other).fetch(`/_admin/connections/new?link=${encodeURIComponent(link)}`, { method: "POST", body: {} });
          if (added.status !== 200 && !(added.status === 409 && /already/i.test(added.text))) throw new Error(`add ${added.status} ${added.text.slice(0, 120)}`);
        } catch (error) {
          failed++;
          missed.push([a, other]);
          if (failed <= 50) console.error(`${a} → ${other}: ${error.message}`);
        }
      });
      await pool([...new Set(block.map(([a]) => a))], Math.max(32, AT_ONCE / 2), async (host) => {
        const site = owner(host);
        for (;;) {
          const page = await site.fetch("/friend");
          const ids = [...new Set([...page.text.matchAll(/formaction="\/_admin\/connections\/(\d+)\/approve/g)].map((m) => m[1]))];
          if (!ids.length) break;
          for (const id of ids) {
            const r = await site.fetch(`/_admin/connections/${id}/approve`, { method: "POST", form: {} });
            if (r.status !== 303) throw new Error(`${host}: approve ${id}: ${r.status}`);
            approved++;
          }
        }
      });
      state.friendShuffledBlocks = b + 1;
      save();
      const done = Math.min((b + 1) * BLOCK, pairs.length);
      console.log(`${state.friendOrder.from + done}/${listed.length} friendships, ${failed} failed, ${approved} approved ` +
        `(${Math.round(done / ((Date.now() - started) / 1000))} a second)`);
    }
    // Those that failed (a connection dropped, a site too busy), once more, a few at a time; then let in.
    let again = 0;
    await pool(missed, 16, async ([a, other]) => {
      try {
        const made = await owner(a).fetch("/_admin/connections/link", { method: "POST", body: {} });
        if (made.status !== 200) return;
        const added = await owner(other).fetch(`/_admin/connections/new?link=${encodeURIComponent(made.json().link)}`, { method: "POST", body: {} });
        if (added.status === 200 || (added.status === 409 && /already/i.test(added.text))) again++;
      } catch {}
    });
    await pool([...new Set(missed.map(([a]) => a))], 16, async (host) => {
      const page = await owner(host).fetch("/friend");
      for (const id of new Set([...page.text.matchAll(/formaction="\/_admin\/connections\/(\d+)\/approve/g)].map((m) => m[1]))) {
        const r = await owner(host).fetch(`/_admin/connections/${id}/approve`, { method: "POST", form: {} });
        if (r.status === 303) approved++;
      }
    }).catch((error) => console.error(`Letting in the second tries: ${error.message}`));
    console.log(`Friends: ${listed.length} friendships, ${failed} failed (this run), ${again} of them made on a second try, ${approved} approved.`);
    tooMany(failed - again, pairs.length, "friendships");
  },

  /**
   * Everyone opens Home once, and their sites make their first copies of all their friends' posts (feed.js), before the
   * day: as people who've used afterwrd a while, not ones opening it for the first time, so a day's measurements are a
   * normal day's. Run without the delays (setting up), it waits until the sites have gone quiet.
   */
  async warm() {
    const since = Date.now();
    let done = 0;
    let failed = 0;
    await pool(people.filter((s) => state.sites[s.host]?.cookies), Math.max(24, AT_ONCE / 4), async (s) => {
      try {
        await retry(3, async () => {
          const r = await owner(s.host).fetch("/");
          if (r.status !== 200) throw new Error(`Home ${r.status}`);
        });
      } catch (error) {
        failed++;
        if (failed <= 50) console.error(`${s.host}: ${error.message}`);
      }
      if (++done % 200 === 0) console.log(`${done}/${people.length} opened Home`);
    });
    tooMany(failed, people.length, "first Homes", 0.05);
    console.log(`Home opened on all ${people.length} sites; waiting for their copies of friends' posts`);
    await waitQuiet([], since, { quietMs: 30_000, maxMs: 60 * 60_000 });
    console.log(`Warm: ${Math.round((Date.now() - since) / 1000)} s.`);
  },

  /**
   * Each group's site claimed by its owner (Groups → Start a group, self-hosted), and its members let in, 10 at a time.
   * A member who can't join is tried again in a later round (three times in all), then left out; a group that can't
   * be made is left out, and the others carry on.
   */
  async groups() {
    state.groups ??= {};
    let lostGroups = 0;
    // All the groups at once (each its own site and owner): a group of 2,000 lets people in 10 at a time.
    await pool(all.filter((s) => s.role === "group"), 8, async (g) => {
      try {
        const host = g.owner;
        const site = owner(host);
        const mine = (state.groups[g.host] ??= { members: {} });
        if (!mine.id) {
          await retry(3, async () => {
            const made = await site.fetch("/_groups/create/local", { method: "POST",
              body: { origin: `https://${g.host}`, setup: g.vars.GROUP_KEY, name: `Walkers ${g.members}`, about: "A made-up group for the scale test." } });
            if (made.status !== 200) throw new Error(`create ${made.status} ${made.text.slice(0, 200)}`);
            const claimed = await site.fetch("/_groups/create/claim", { method: "POST", body: { id: made.json().id } });
            if (claimed.status !== 200) throw new Error(`claim ${claimed.status} ${claimed.text.slice(0, 200)}`);
            mine.id = claimed.json().id;
          });
          save();
        }
        const tries = new Map();
        let joining = (g.memberHosts ? g.memberHosts.map((h) => byHost.get(h)) : all.filter((s) => s.role === "leaf").slice(0, g.members))
          .filter((s) => s && state.sites[s.host]?.cookies && !mine.members[s.host]);
        // Lets in everyone waiting (Members → Approve).
        const approveWaiting = () => retry(3, async () => {
          const page = await site.fetch(`/groups/${mine.id}/members`);
          const ids = [...new Set([...page.text.matchAll(new RegExp(`formaction="/_groups/${mine.id}/members/(\\d+)/approve`, "g"))].map((m) => m[1]))];
          for (const m of ids) {
            const r = await site.fetch(`/_groups/${mine.id}/members/${m}/approve`, { method: "POST", form: {} });
            if (r.status !== 303) throw new Error(`approve ${m}: ${r.status}`);
          }
        });
        // Anyone left waiting by a run that stopped part way (they'd count towards the 10).
        await approveWaiting();
        // At most 10 may wait at once (groups.js MAX_WAITING): ask, then let in, ten at a time. A link takes 100
        // requests, so each round gets a new one.
        for (let round = 0; joining.length; round++) {
          const batch = joining.slice(0, 10);
          joining = joining.slice(10);
          const { link: joinLink } = await retry(3, async () => {
            const link = await site.fetch(`/_groups/${mine.id}/link`, { method: "POST", body: {} });
            if (link.status !== 200) throw new Error(`link ${link.status} ${link.text.slice(0, 200)}`);
            return link.json();
          });
          await pool(batch, 10, async (s) => {
            try {
              const r = await owner(s.host).fetch("/_groups/join", { method: "POST", body: { link: joinLink } });
              if (r.status !== 200) throw new Error(`${r.status} ${r.text.slice(0, 120)}`);
              mine.members[s.host] = r.json().id;
            } catch (error) {
              const n = (tries.get(s.host) ?? 0) + 1;
              tries.set(s.host, n);
              if (n < 3) joining.push(s);
              else console.error(`${s.host} couldn't join ${g.host}: ${error.message}`);
            }
          });
          await approveWaiting().catch((error) => console.error(`${g.host}: letting people in: ${error.message}`));
          save();
          // A big group lets people in for a while: say how far it's got, so the watchdog knows it's not stuck.
          if (round % 20 === 19) console.log(`${g.host}: ${Object.keys(mine.members).length} of ${g.members - 1} joined so far`);
        }
        const page = await site.fetch(`/groups/${mine.id}/members`);
        console.log(`${g.host}: ${Object.keys(mine.members).length} joined; members page ${page.status}, ${(page.text.match(/\/remove"/g) ?? []).length} removable.`);
      } catch (error) {
        lostGroups++;
        console.error(`${g.host}: left out: ${error.message}`);
      }
    });
    if (lostGroups) console.log(`Groups: ${lostGroups} couldn't be made, and are left out.`);
  },
};

// --- Scenarios ------------------------------------------------------------------------------------------------------

/** What a page's Server-Timing header says (timing.js): calls out, queries, rounds, rows read, time on other sites. */
function timingOf(response) {
  const h = String(response.headers["server-timing"] ?? "");
  const num = (re) => Number(re.exec(h)?.[1] ?? NaN);
  return { calls: num(/Calls out: (\d+)/), queries: num(/Database: (\d+) quer/), rounds: num(/in (\d+) rounds?/),
    rowsRead: num(/Running them: (\d+) rows/), sitesMs: num(/sites;dur=(\d+)/), totalMs: num(/total;dur=(\d+)/) };
}

// The measuring lines (timing.js AFTERWRD_STATS), read as they come, from where the last read stopped: a big network's
// day writes gigabytes of them, too many to read again every few seconds. Only the last KEEP_MS are kept, and only
// what the scenarios look at; every scenario looks back less far than that.
const STATS = "/out/stats.log";
const KEEP_MS = 20 * 60_000;
let statsRead = existsSync(STATS) ? statSync(STATS).size : 0;
let statsPartial = Buffer.alloc(0); // the start of a line not finished yet (bytes: a piece can end mid-character)
let recent = [];
function readNewStats() {
  if (!existsSync(STATS)) return;
  const size = statSync(STATS).size;
  if (size < statsRead) statsRead = 0;
  // A piece at a time: a whole day can add gigabytes, more than one Buffer may hold (the 19 Nov run's day crashed so).
  if (size > statsRead) {
    const fd = openSync(STATS, "r");
    const buffer = Buffer.alloc(Math.min(size - statsRead, 64 << 20));
    const cutoff = Date.now() - KEEP_MS;
    try {
      while (statsRead < size) {
        const got = readSync(fd, buffer, 0, Math.min(buffer.length, size - statsRead), statsRead);
        if (!got) break;
        statsRead += got;
        const piece = Buffer.concat([statsPartial, buffer.subarray(0, got)]);
        const end = piece.lastIndexOf(10) + 1;
        statsPartial = Buffer.from(piece.subarray(end));
        for (const line of piece.toString("utf8", 0, end).split("\n")) {
          if (!line) continue;
          const r = JSON.parse(line);
          if (r.t0 >= cutoff) recent.push({ site: r.site, obj: r.obj, m: r.m, path: r.path, t0: r.t0, ms: r.ms, rw: r.rw });
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  const cutoff = Date.now() - KEEP_MS;
  const keepFrom = recent.findIndex((r) => r.t0 >= cutoff);
  if (keepFrom > 0) recent = recent.slice(keepFrom);
  else if (keepFrom < 0) recent = [];
}

/** The measuring lines for runs that started at or after `since` (and within the last KEEP_MS). */
function statsSince(since) {
  readNewStats();
  return recent.filter((r) => r.t0 >= since);
}

/** Waits until none of `hosts`' objects has finished a run for `quietMs` (at least `minMs`, at most `maxMs`). */
async function waitQuiet(hosts, since, { quietMs = 15_000, minMs = 5_000, maxMs = 15 * 60_000 } = {}) {
  const set = new Set(hosts);
  const start = Date.now();
  let said = start;
  for (;;) {
    await sleep(2000);
    // A long wait says so now and then: the watchdog (watchdog.sh) takes a quiet log for a stuck run.
    if (Date.now() - said > 5 * 60_000) {
      said = Date.now();
      console.log(`  (waiting for the sites to settle: ${Math.round((said - start) / 60_000)} minutes so far)`);
    }
    let last = since;
    for (const r of statsSince(since)) if (!set.size || set.has(r.site)) last = Math.max(last, r.t0 + r.ms);
    if (Date.now() - start >= minMs && Date.now() - last >= quietMs) return;
    if (Date.now() - start > maxMs) {
      console.log("  (still busy after the longest wait: carrying on)");
      return;
    }
  }
}

function record(name, data) {
  mkdirSync("/out/results", { recursive: true });
  writeFileSync(`/out/results/${name}.json`, JSON.stringify(data, null, 1));
  console.log(`Wrote /out/results/${name}.json`);
}

const FRIEND_POST = /<article[^>]*\bid="f(\d+)-(post-\d+-[0-9a-f]{8})"/g;
const friendPosts = (html) => [...html.matchAll(FRIEND_POST)].map((m) => ({ connection: m[1], target: m[2] }));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Opens `path` as the owner of `s`, with the CPU its site used meanwhile. */
async function visit(s, path, label) {
  const site = owner(s.host);
  const { result: r, cpuMs, wallMs } = await withCpu(s.proc, s.host, () => site.fetch(path));
  const row = { label, path, status: r.status, wallMs, cpuMs, ...timingOf(r), friendPosts: friendPosts(r.text).length,
    burst: (r.text.match(/Burst post/g) ?? []).length };
  console.log(`  ${label.padEnd(12)} ${path.padEnd(22)} ${r.status} wall ${wallMs} ms, cpu ${cpuMs} ms, calls ${row.calls}, queries ${row.queries}, rows ${row.rowsRead}, friends' posts ${row.friendPosts}`);
  return { row, html: r.text };
}

Object.assign(steps, {
  /**
   * Home with 5, 150 and 500 friends: the first visit (no stored copies yet), then after the background refreshes, a
   * few warm visits and friends' pages. On the 150 hub, a third of its friends post at once, and Home is opened
   * 10 s and 60 s later to see how many of those posts it shows.
   */
  async home(only) {
    // The social model has ten outliers, each with a couple of thousand friends to refresh: the three with most.
    const hubs = all.filter((s) => s.role === "hub" && (!only || s.host === only)).sort((a, b) => b.friends - a.friends);
    for (const hub of NET.model === "social" && !only ? hubs.slice(0, 3) : hubs) {
      console.log(`${hub.host} (${hub.friends} friends)`);
      const rows = [];
      const since = Date.now();
      rows.push((await visit(hub, "/", "first")).row);
      await waitQuiet([hub.host], since, { quietMs: 20_000 });
      let html = "";
      for (let i = 0; i < 5; i++) {
        const v = await visit(hub, "/", "warm");
        rows.push(v.row);
        html = v.html;
        await sleep(1000);
      }
      const ids = [...new Set([...html.matchAll(/data-region="\/friend\/(\d+)\/posts"/g)].map((m) => m[1]))];
      for (const id of ids.slice(0, 3)) rows.push((await visit(hub, `/friend/${id}/posts`, "friend page")).row);
      let burst = null;
      if (hub.friends >= 100 && hub.friends < 500) {
        const posters = (friendsOf.get(hub.host)?.map((h) => byHost.get(h)) ?? all.filter((s) => s.role === "leaf").slice(0, hub.friends))
          .filter((_, i) => i % 3 === 0);
        const at = Date.now();
        await pool(posters, 25, (s) => writePost(owner(s.host), `Burst post from ${ownerName(s)}.`, false));
        const posted = Date.now() - at;
        await sleep(10_000);
        rows.push((await visit(hub, "/", "burst +10s")).row);
        await sleep(50_000);
        rows.push((await visit(hub, "/", "burst +60s")).row);
        burst = { posters: posters.length, postingMs: posted };
      }
      record(`home-${hub.host}`, { hub: hub.host, friends: hub.friends, since, until: Date.now(), rows, burst });
    }
  },

  /** One post (with a photo) from the 500 hub reaching all its friends, and their sites coming back for it. */
  async fanout() {
    const hub = all.filter((s) => s.role === "hub").sort((a, b) => b.friends - a.friends)[0];
    const leaves = new Set(friendsOf.get(hub.host) ?? all.filter((s) => s.role === "leaf").slice(0, hub.friends).map((s) => s.host));
    console.log(`${hub.host} posts to ${leaves.size} friends`);
    const since = Date.now();
    const { cpuMs } = await withCpu(hub.proc, hub.host, () => writePost(owner(hub.host), "Fan-out post, with a photo.", true));
    const reached = new Map();
    for (;;) {
      await sleep(5000);
      for (const r of statsSince(since)) {
        if (leaves.has(r.site) && r.obj === "site" && r.path === "/_peer/notify" && !reached.has(r.site)) reached.set(r.site, r.t0 + r.ms - since);
      }
      console.log(`  ${Math.round((Date.now() - since) / 1000)} s: ${reached.size}/${leaves.size} told`);
      if (reached.size >= leaves.size || Date.now() - since > 15 * 60_000) break;
    }
    await waitQuiet([hub.host], since, { quietMs: 30_000 });
    const times = [...reached.values()].sort((a, b) => a - b);
    const at = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? null;
    record("fanout", { hub: hub.host, friends: leaves.size, since, until: Date.now(), postCpuMs: cpuMs, told: reached.size,
      toldMs: { p50: at(0.5), p90: at(0.9), p99: at(0.99), last: times.at(-1) ?? null } });
  },

  /**
   * A day in each group, squeezed into `minutes` (default 20): half its members each open it 4 times (evenly spread)
   * and comment twice on its newest post, and 1 in 5 of them posts. All of it lands on the group's owner's account.
   */
  async group_day(minutes = "20") {
    const span = Number(minutes) * 60_000;
    const events = [];
    const groups = [];
    for (const g of all.filter((s) => s.role === "group")) {
      const active = Object.entries(state.groups[g.host].members).filter((_, i) => i % 2 === 0);
      groups.push({ host: g.host, members: Object.keys(state.groups[g.host].members).length, active: active.length });
      active.forEach(([host, id], i) => {
        const gap = span / 4;
        const first = Math.random() * gap;
        for (let k = 0; k < 4; k++) events.push({ at: first + k * gap, host, id, group: g.host, type: "open" });
        for (let k = 0; k < 2; k++) events.push({ at: Math.random() * span, host, id, group: g.host, type: "comment" });
        if (i % 5 === 0) events.push({ at: Math.random() * span, host, id, group: g.host, type: "post" });
      });
    }
    events.sort((a, b) => a.at - b.at);
    console.log(`${groups.map((g) => `${g.host}: ${g.active} of ${g.members} active`).join("; ")}; ${events.length} actions over ${minutes} minutes`);
    const newest = new Map(); // each member's newest post seen in each group, to comment on (many are in both)
    const done = [];
    const since = Date.now();
    const act = async ({ host, id, group, type }) => {
      const site = owner(host);
      const seen = `${host} ${group}`;
      const started = performance.now();
      let status = 0;
      try {
        if (type === "open" || (type === "comment" && !newest.has(seen))) {
          const page = await site.fetch(`/groups/${id}`);
          const post = /id="gp(\d+)"/.exec(page.text)?.[1];
          if (post) newest.set(seen, post);
          if (type === "open") status = page.status;
        }
        if (type === "comment") {
          const post = newest.get(seen);
          if (!post) status = -1;
          else {
            const r = await site.fetch(`/_groups/${id}/comments`, { method: "POST", form: { post, text: "A comment for the group day.", back: `/groups/${id}` } });
            status = r.status;
          }
        } else if (type === "post") {
          const r = await site.fetch(`/_groups/${id}/posts`, { method: "POST", body: { text: "A post for the group day.", photos: [] } });
          status = r.status;
        }
      } catch (error) {
        console.error(`  ${host} ${type} in ${group}: ${error.message}`);
      }
      done.push({ host, group, type, status, ms: Math.round(performance.now() - started) });
    };
    const running = new Set();
    for (const event of events) {
      const wait = since + event.at - Date.now();
      if (wait > 0) await sleep(wait);
      while (running.size >= 32) await Promise.race(running);
      const p = act(event).finally(() => running.delete(p));
      running.add(p);
      if (done.length && done.length % 500 === 0) console.log(`  ${Math.round((Date.now() - since) / 60_000)} min: ${done.length}/${events.length}`);
    }
    await Promise.all(running);
    await waitQuiet(groups.map((g) => g.host), since, { quietMs: 30_000 });
    record("group-day", { minutes: Number(minutes), since, until: Date.now(), groups, actions: done });
  },

  /** In each group: a member posts with a photo, another comments, the owner removes someone; `close` closes them too. */
  async groups_run(close) {
    for (const g of all.filter((s) => s.role === "group")) {
      const mine = state.groups[g.host];
      const members = Object.entries(mine.members);
      console.log(`${g.host} (${members.length} members)`);
      const since = Date.now();
      const [poster, posterId] = members[0];
      const posted = await owner(poster).fetch(`/_groups/${posterId}/posts`, { method: "POST", body: { text: "Group post for the scale test.", photos: [] } });
      console.log(`  post ${posted.status}`);
      await waitQuiet([g.host], since, { quietMs: 20_000 });
      const [commenter, commenterId] = members[1];
      const page = await owner(commenter).fetch(`/groups/${commenterId}`);
      const post = /id="gp(\d+)"/.exec(page.text)?.[1];
      const commented = await owner(commenter).fetch(`/_groups/${commenterId}/comments`, { method: "POST",
        form: { post, text: "A comment for the scale test.", back: `/groups/${commenterId}` } });
      console.log(`  comment ${commented.status}`);
      await waitQuiet([g.host], since, { quietMs: 20_000 });
      const site = owner(g.owner);
      // The one post that goes to every member: @here, from an admin (notify.js notifyGroupMentions).
      const hereAt = Date.now();
      const here = await site.fetch(`/_groups/${mine.id}/posts`, { method: "POST",
        body: { text: "@here a note for everyone in the scale test.", photos: [], mentions: [{ name: "here", origin: "here" }] } });
      await waitQuiet([g.host], hereAt, { quietMs: 20_000 });
      const hereTold = new Set(statsSince(hereAt).filter((x) => x.path === "/_member/notify").map((x) => x.site)).size;
      console.log(`  @here ${here.status}: ${hereTold} of ${members.length} members told`);
      const list = await site.fetch(`/groups/${mine.id}/members`);
      const removable = [...list.text.matchAll(new RegExp(`formaction="/_groups/${mine.id}/members/(\\d+)/remove`, "g"))].map((m) => m[1]);
      const removed = await site.fetch(`/_groups/${mine.id}/members/${removable.at(-1)}/remove`, { method: "POST", form: {} });
      console.log(`  remove ${removed.status}`);
      let closed = null;
      if (close === "close") {
        const at = Date.now();
        const r = await site.fetch(`/_groups/${mine.id}/delete`, { method: "POST", body: {} });
        await waitQuiet([g.host], at, { quietMs: 20_000 });
        const told = new Set(statsSince(at).filter((x) => x.path === "/_member/removed").map((x) => x.site));
        closed = { status: r.status, told: told.size, members: members.length - 1 };
        console.log(`  close ${r.status}: ${told.size} of ${members.length - 1} members told`);
      }
      record(`group-${g.host}`, { group: g.host, members: members.length, since, until: Date.now(), closed, here: { status: here.status, told: hereTold, at: hereAt } });
    }
  },

  /**
   * A day's activity squeezed into `minutes` (default 30; 60 or more keeps Home visits over 5 minutes apart): every hub,
   * and a third of the others, each open Home 10 times, write a post (1 in 4 with a photo), comment on 5 friends' posts
   * and open 2 friends' pages.
   */
  async day(minutes = "30") {
    const span = Number(minutes) * 60_000;
    const active = people.filter((s, i) => s.role === "hub" || i % 3 === 0);
    const events = [];
    for (const s of active) {
      const add = (type, n) => { for (let i = 0; i < n; i++) events.push({ at: Math.random() * span, s, type }); };
      // Home evenly spread, as visits in a real day are hours apart: with 60 minutes or more, each one finds every
      // copy older than FRESH_SECONDS (feed.js, 5 minutes), so each refreshes all friends, as it would in a real day.
      const gap = span / 10;
      const first = Math.random() * gap;
      for (let i = 0; i < 10; i++) events.push({ at: first + i * gap, s, type: "home" });
      add(Math.random() < 0.25 ? "photo post" : "post", 1);
      add("comment", 5);
      add("friend page", 2);
    }
    events.sort((a, b) => a.at - b.at);
    console.log(`${active.length} people active, ${events.length} actions over ${minutes} minutes`);
    const lastHome = new Map();
    const done = [];
    const since = Date.now();
    const act = async ({ s, type }) => {
      const site = owner(s.host);
      const started = performance.now();
      let status = 0;
      let calls = NaN;
      try {
        if (type === "home" || ((type === "comment" || type === "friend page") && !lastHome.has(s.host))) {
          const r = await site.fetch("/");
          lastHome.set(s.host, r.text);
          if (type === "home") {
            status = r.status;
            calls = timingOf(r).calls;
          }
        }
        if (type === "post" || type === "photo post") {
          await writePost(site, `Post from ${ownerName(s)} today.`, type === "photo post");
          status = 200;
        } else if (type === "comment") {
          const target = pick(friendPosts(lastHome.get(s.host)));
          if (!target) status = -1;
          else {
            const r = await site.fetch("/_feed/comments", { method: "POST", form: { ...target, text: "A comment for the scale test.", back: "/" } });
            status = r.status;
          }
        } else if (type === "friend page") {
          const ids = [...new Set([...lastHome.get(s.host).matchAll(/data-region="\/friend\/(\d+)\/posts"/g)].map((m) => m[1]))];
          if (!ids.length) status = -1;
          else {
            const r = await site.fetch(`/friend/${pick(ids)}/posts`);
            status = r.status;
            calls = timingOf(r).calls;
          }
        }
      } catch (error) {
        status = 0;
        console.error(`  ${s.host} ${type}: ${error.message}`);
      }
      done.push({ host: s.host, type, status, ms: Math.round(performance.now() - started), calls });
    };
    const running = new Set();
    for (const event of events) {
      const wait = since + event.at - Date.now();
      if (wait > 0) await sleep(wait);
      while (running.size >= 64) await Promise.race(running);
      const p = act(event).finally(() => running.delete(p));
      running.add(p);
      if (done.length && done.length % 500 === 0) console.log(`  ${Math.round((Date.now() - since) / 60_000)} min: ${done.length}/${events.length}`);
    }
    await Promise.all(running);
    await waitQuiet([], since, { quietMs: 30_000 });
    record("day", { minutes: Number(minutes), active: active.map((s) => s.host), since, until: Date.now(), actions: done });
  },

  /**
   * What refreshing the biggest hub's stored copies writes: Home opened now, again 6 minutes later in the same hour
   * (copies older than 5 minutes are fetched again), and just after the hour turns, when friends' photo links change
   * (share.js signs them to the hour) and posts with photos are rewritten. Run it with nothing else going on.
   */
  async refresh() {
    const hub = all.filter((s) => s.role === "hub").sort((a, b) => b.friends - a.friends)[0];
    const friends = new Set(friendsOf.get(hub.host) ?? all.filter((s) => s.role === "leaf").slice(0, hub.friends).map((s) => s.host));
    const site = owner(hub.host);
    const rounds = [];
    const round = async (label) => {
      const since = Date.now();
      const r = await site.fetch("/");
      await waitQuiet([hub.host], since, { quietMs: 20_000 });
      const list = statsSince(since);
      const refreshed = new Set(list.filter((x) => friends.has(x.site) && x.obj === "site" && x.path === "/_peer/feed").map((x) => x.site)).size;
      const written = list.filter((x) => x.site === hub.host).reduce((a, x) => a + x.rw, 0);
      rounds.push({ label, since, status: r.status, refreshed, written });
      console.log(`  ${label}: ${refreshed} friends refreshed, ${written} rows written`);
    };
    const HOUR = 3_600_000;
    await round("start");
    if (HOUR - (Date.now() % HOUR) > 8 * 60_000) {
      await sleep(6 * 60_000);
      await round("same hour, 6 min later");
    }
    const last = rounds.at(-1).since;
    const turn = Date.now() + HOUR - (Date.now() % HOUR) + 60_000;
    const at = Math.max(turn, last + 6 * 60_000);
    console.log(`  waiting ${Math.round((at - Date.now()) / 60_000)} min for the hour to turn`);
    await sleep(at - Date.now());
    await round("new hour");
    record("refresh", { hub: hub.host, friends: friends.size, since: rounds[0].since, until: Date.now(), rounds });
  },
});

// --- The social model's day (net.mjs --model social) ---------------------------------------------------------------

/** A small binary heap of {at, act}, earliest first: the day's schedule, which grows as flurries start. */
class Schedule {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  peek() { return this.items[0]; }
  push(item) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (a[up].at <= a[i].at) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        if (l < a.length && a[l].at < a[m].at) m = l;
        if (r < a.length && a[r].at < a[m].at) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** What a refusal said: a JSON answer's error, or the sentence on an error page that says what went wrong. */
function saidIn(text) {
  try {
    const error = JSON.parse(text)?.error;
    if (error) return String(error).slice(0, 160);
  } catch {}
  const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");
  const m = /[^.!]*(couldn't|can't|too many|try again|not allowed|isn't|wasn't|a lot of|no longer|went wrong|refused)[^.!]*[.!]/i.exec(plain);
  return (m?.[0] ?? plain).trim().slice(0, 160);
}

/** The article on a page whose words carry `[day n]`, and its id; null if it isn't there. */
function cardWith(html, n, idPattern) {
  for (const chunk of html.split("<article").slice(1)) {
    if (!chunk.includes(`[day ${n}]`)) continue;
    const m = idPattern.exec(chunk.slice(0, 400));
    if (m) return m;
  }
  return null;
}

Object.assign(steps, {
  /**
   * A waking day (7:00 to 23:00) of the social model, squeezed NET.squeeze times (8: 16 hours in 2), as people use a
   * social site, from a seed:
   * - Most people mostly read (55% open Home 3 times a day and rarely post), some are regular (35%: 8 times, a post most
   *   days), a few are busy (10%, and every outlier: 14 times, 3 posts). More of it at lunch and in the evening.
   * - A post with a photo (40% of them) starts a flurry: 2–8 of the poster's friends, mostly from the circles they
   *   share, find it on their Home and comment over the next half hour or so; the poster often replies, those who
   *   commented are told and some come back, and some reply again. A post without one gets fewer.
   * - Group members open their groups, some post, and a post brings a few comments from other members.
   * Every action goes to /out/results/social-day.jsonl as it happens. Each Home visit also notes which friends' posts
   * from the day it already shows, and how old the ones it doesn't are (how fast posts reach friends).
   */
  async social_day(seed = "7") {
    if (!NET.edges) throw new Error("social_day needs the social model (net.mjs --model social).");
    const random = seeded(Number(seed));
    const squeeze = NET.squeeze ?? 8;
    const MINUTE = 60_000 / squeeze; // a real minute, in the test's time
    const span = 16 * 60 * MINUTE;
    const expo = (minutes) => -Math.log(1 - random()) * minutes * MINUTE;
    const poisson = (mean) => {
      let k = 0;
      for (let p = Math.exp(-mean), sum = p, u = random(); u > sum; k++) { p *= mean / (k + 1); sum += p; }
      return k;
    };
    const bump = (h, at, width) => Math.exp(-(((h - at) / width) ** 2));
    const busy = (x) => { const h = 7 + 16 * x; return 0.3 + 0.6 * bump(h, 8, 1) + 0.8 * bump(h, 12.5, 1) + 1.3 * bump(h, 20.5, 1.5); };
    const when = () => { for (;;) { const x = random(); if (random() * 2.2 < busy(x)) return x * span; } };
    const CLASSES = {
      lurker: { home: 3, posts: 0.15, comments: 0.3, groupOpens: 1, groupPosts: 0.03 },
      regular: { home: 8, posts: 0.8, comments: 1.5, groupOpens: 3, groupPosts: 0.2 },
      heavy: { home: 14, posts: 3, comments: 5, groupOpens: 6, groupPosts: 0.8 },
    };
    const classOf = (s) => {
      if (s.role === "hub") return "heavy";
      const r = parseInt(createHash("sha256").update(s.host).digest("hex").slice(0, 8), 16) / 2 ** 32;
      return r < 0.55 ? "lurker" : r < 0.9 ? "regular" : "heavy";
    };
    const persons = all.filter((s) => !s.group);
    // Each person's groups, as their own site numbers them (the owner's too).
    const groupsOf = new Map();
    const groupMembers = new Map();
    for (const g of all.filter((s) => s.role === "group")) {
      const mine = state.groups?.[g.host];
      if (!mine?.id) continue;
      const members = [[g.owner, mine.id], ...Object.entries(mine.members)];
      groupMembers.set(g.host, members);
      for (const [host, id] of members) {
        if (!groupsOf.has(host)) groupsOf.set(host, []);
        groupsOf.get(host).push({ group: g.host, id });
      }
    }
    const shared = (a, b) => [...(circlesOf.get(a) ?? [])].some((c) => circlesOf.get(b)?.has(c));
    /** `k` of `host`'s friends, those sharing a circle with them five times as likely. */
    const someFriends = (host, k) => {
      const list = friendsOf.get(host) ?? [];
      const weights = list.map((f) => (shared(host, f) ? 5 : 1));
      const chosen = new Set();
      for (let tries = 0; chosen.size < Math.min(k, list.length) && tries < k * 20; tries++) {
        let x = random() * weights.reduce((a, w) => a + w, 0);
        for (let i = 0; i < list.length; i++) { x -= weights[i]; if (x <= 0) { chosen.add(list[i]); break; } }
      }
      return [...chosen];
    };

    mkdirSync("/out/results", { recursive: true });
    const LOG = "/out/results/social-day.jsonl";
    writeFileSync(LOG, "");
    const since = Date.now();
    const now = () => Date.now() - since;
    const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ t: now(), ...entry })}\n`);
    const schedule = new Schedule();
    const later = (at, act) => schedule.push({ at, act });

    // The day's posts (n: the [day n] in their words), and each poster's, to know what a friend's Home should show.
    const posts = new Map();
    const postsBy = new Map();
    let made = 0;
    const firstSeen = new Set();
    const counts = { home: 0, post: 0, comment: 0, unseen: 0, reply: 0, groupOpen: 0, groupPost: 0, groupComment: 0, failed: 0 };

    /** Home, as `host` opens it: what it shows of their friends' posts from the day, and how fast they got there. */
    const visit = async (host, why) => {
      const started = performance.now();
      const r = await owner(host).fetch("/");
      const t = now();
      const seen = new Set([...r.text.matchAll(/\[day (\d+)\]/g)].map((m) => Number(m[1])));
      let shown = 0;
      let missing = 0;
      let oldest = 0;
      const arrived = [];
      for (const f of friendsOf.get(host) ?? []) {
        for (const p of postsBy.get(f) ?? []) {
          if (seen.has(p.n)) {
            shown++;
            if (!firstSeen.has(`${host} ${p.n}`)) { firstSeen.add(`${host} ${p.n}`); arrived.push(Math.round((t - p.at) * squeeze / 1000)); }
          } else if (t - p.at > Math.max(2 * MINUTE, 60_000)) {
            missing++;
            oldest = Math.max(oldest, Math.round((t - p.at) * squeeze / 1000));
          }
        }
      }
      counts.home++;
      const timing = timingOf(r);
      log({ a: "home", host, why, st: r.status, ms: Math.round(performance.now() - started), calls: timing.calls, rows: timing.rowsRead,
        shown, missing, oldest, arrived });
      return r.text;
    };

    const post = async (host, photo) => {
      const n = ++made;
      const started = performance.now();
      await writePost(owner(host), `A post from ${ownerName(byHost.get(host))} [day ${n}]`, photo);
      const p = { n, host, at: now(), photo, commenters: [] };
      posts.set(n, p);
      if (!postsBy.has(host)) postsBy.set(host, []);
      postsBy.get(host).push(p);
      counts.post++;
      log({ a: "post", host, n, photo, ms: Math.round(performance.now() - started) });
      // The flurry: friends who'll come and comment.
      for (const friend of someFriends(host, photo ? 2 + Math.min(6, poisson(3)) : poisson(0.8))) {
        later(now() + expo(photo ? 20 : 40), () => comment(friend, p, 0, 0));
      }
    };

    /** A friend finds the post on their Home and comments; tries twice more later if it isn't there yet. */
    const comment = async (host, p, tries, round) => {
      const page = await visit(host, "to comment");
      const card = cardWith(page, p.n, /id="f(\d+)-(post-\d+-[0-9a-f]{8})"/);
      if (!card) {
        counts.unseen++;
        log({ a: "unseen", host, n: p.n, tries, age: Math.round((now() - p.at) * squeeze / 1000) });
        if (tries < 2) later(now() + expo(10), () => comment(host, p, tries + 1, round));
        return;
      }
      const started = performance.now();
      const r = await owner(host).fetch("/_feed/comments", { method: "POST", form: { connection: card[1], target: card[2],
        text: `A comment from ${ownerName(byHost.get(host))} on [day ${p.n}]`, back: "/" } });
      const ok = r.status === 303 || r.status === 200;
      counts.comment++;
      if (!ok) counts.failed++;
      log({ a: "comment", host, n: p.n, round, st: r.status, ms: Math.round(performance.now() - started), ...(ok ? {} : { said: saidIn(r.text) }) });
      if (!ok) return;
      // Those who commented before are told (their sites get a note); some come back to look.
      for (const other of p.commenters) if (random() < 0.3) later(now() + expo(6), () => visit(other, "told"));
      p.commenters.push(host);
      if (random() < 0.6) later(now() + expo(8), () => reply(p));
      if (round < 2 && random() < 0.25) later(now() + expo(15), () => comment(host, p, 0, round + 1));
    };

    /** The poster replies on their own post (Posts). */
    const reply = async (p) => {
      const site = owner(p.host);
      const page = await site.fetch("/posts");
      const card = cardWith(page.text, p.n, /id="p-(post-\d+-[0-9a-f]{8})"/);
      if (!card) { counts.failed++; log({ a: "reply", host: p.host, n: p.n, st: "not found" }); return; }
      const started = performance.now();
      const r = await site.fetch("/_comments", { method: "POST", form: { target: card[1], text: `Thanks, all [day ${p.n}]`, back: "/posts" } });
      counts.reply++;
      const ok = r.status === 303 || r.status === 200;
      if (!ok) counts.failed++;
      log({ a: "reply", host: p.host, n: p.n, st: r.status, ms: Math.round(performance.now() - started), ...(ok ? {} : { said: saidIn(r.text) }) });
    };

    /** An unprompted comment: on whichever friend's post Home shows first. */
    const browse = async (host) => {
      const page = await visit(host, "browsing");
      const cards = [...page.matchAll(/id="f(\d+)-(post-\d+-[0-9a-f]{8})"/g)];
      if (!cards.length) return;
      const [, connection, target] = cards[Math.floor(random() * Math.min(10, cards.length))];
      const r = await owner(host).fetch("/_feed/comments", { method: "POST", form: { connection, target, text: "Lovely.", back: "/" } });
      counts.comment++;
      const ok = r.status === 303 || r.status === 200;
      if (!ok) counts.failed++;
      log({ a: "comment", host, browsing: true, st: r.status, ...(ok ? {} : { said: saidIn(r.text) }) });
    };

    const groupOpen = async (host, id, group) => {
      const started = performance.now();
      const r = await owner(host).fetch(`/groups/${id}`);
      counts.groupOpen++;
      if (r.status !== 200) counts.failed++;
      log({ a: "groupOpen", host, group, st: r.status, ms: Math.round(performance.now() - started), rows: timingOf(r).rowsRead });
      return r.text;
    };

    const groupPost = async (host, id, group) => {
      const n = ++made;
      const started = performance.now();
      const r = await owner(host).fetch(`/_groups/${id}/posts`, { method: "POST", body: { text: `A group post [day ${n}]`, photos: [] } });
      counts.groupPost++;
      const ok = r.status === 200;
      if (!ok) counts.failed++;
      log({ a: "groupPost", host, group, n, st: r.status, ms: Math.round(performance.now() - started), ...(ok ? {} : { said: saidIn(r.text) }) });
      if (!ok) return;
      const members = groupMembers.get(group).filter(([h]) => h !== host);
      for (let i = 0, k = 1 + poisson(2.5); i < k && members.length; i++) {
        const [member, memberId] = members[Math.floor(random() * members.length)];
        later(now() + expo(15), () => groupComment(member, memberId, group, n));
      }
    };

    const groupComment = async (host, id, group, n) => {
      const page = await groupOpen(host, id, group);
      const card = cardWith(page, n, /id="gp(\d+)"/);
      if (!card) { counts.unseen++; log({ a: "unseen", host, group, n }); return; }
      const started = performance.now();
      const r = await owner(host).fetch(`/_groups/${id}/comments`, { method: "POST", form: { post: card[1], text: `Group comment [day ${n}]`, back: `/groups/${id}` } });
      counts.groupComment++;
      const ok = r.status === 303 || r.status === 200;
      if (!ok) counts.failed++;
      log({ a: "groupComment", host, group, n, st: r.status, ms: Math.round(performance.now() - started), ...(ok ? {} : { said: saidIn(r.text) }) });
    };

    // The day as planned; flurries are added as posts are made.
    const classes = { lurker: 0, regular: 0, heavy: 0 };
    for (const s of persons) {
      const c = CLASSES[classOf(s)];
      classes[classOf(s)]++;
      for (let i = poisson(c.home); i > 0; i--) later(when(), () => visit(s.host, "planned"));
      for (let i = poisson(c.posts); i > 0; i--) { const photo = random() < 0.4; later(when(), () => post(s.host, photo)); }
      for (let i = poisson(c.comments); i > 0; i--) later(when(), () => browse(s.host));
      for (const { group, id } of groupsOf.get(s.host) ?? []) {
        for (let i = poisson(c.groupOpens); i > 0; i--) later(when(), () => groupOpen(s.host, id, group));
        for (let i = poisson(c.groupPosts); i > 0; i--) later(when(), () => groupPost(s.host, id, group));
      }
    }
    console.log(`${persons.length} people (${JSON.stringify(classes)}), ${schedule.size} actions planned over ${Math.round(span / 60_000)} minutes, before flurries`);

    const running = new Set();
    let lastReport = 0;
    while (schedule.size || running.size) {
      if (now() - lastReport > 5 * 60_000) {
        lastReport = now();
        console.log(`  ${Math.round(now() / 60_000)} min (${Math.round(now() * squeeze / 3_600_000 + 7)}:00 in the day): ${JSON.stringify(counts)}, ${running.size} running, ${schedule.size} to come`);
      }
      if (!schedule.size) { await Promise.race(running); continue; }
      const wait = schedule.peek().at - now();
      if (wait > 0) { await Promise.race([sleep(Math.min(wait, 1000)), ...running]); continue; }
      while (running.size >= 256) await Promise.race(running);
      const { act } = schedule.pop();
      const p = act().catch((error) => { counts.failed++; log({ a: "error", said: String(error.message).slice(0, 200) }); }).finally(() => running.delete(p));
      running.add(p);
    }
    console.log(`  done at ${Math.round(now() / 60_000)} min: ${JSON.stringify(counts)}; waiting for the sites to go quiet`);
    await waitQuiet([], since, { quietMs: 60_000, maxMs: 20 * 60_000 });
    record("social-day", { squeeze, minutes: span / 60_000, since, until: Date.now(), classes, counts,
      posts: [...posts.values()].map(({ n, host, at, photo, commenters }) => ({ n, host, at, photo, commenters: commenters.length })) });
  },
});

// For rehearsing the watchdog (watchdog.sh): a step that never ends, and logs nothing.
steps.stall = () => new Promise(() => setInterval(() => {}, 1 << 30));

const [step, ...rest] = process.argv.slice(2);
if (!steps[step]) {
  console.error(`Steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await waitUp();
await steps[step](...rest);
