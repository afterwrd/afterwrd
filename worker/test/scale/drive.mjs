// Drives the scale test's network from inside its container (docs/scale-test-plan.md):
//   test/scale/scale.sh drive <step> [options]
// Steps run in order the first time (setup), and each scenario can be run again on its own afterwards.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool, Site, sleep, tools, withCpu } from "./lib.mjs";

const NET = JSON.parse(readFileSync("/out/net.json", "utf8"));
const STATE_FILE = "/data/drive-state.json";
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { sites: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));

// Every site, with its workerd process and port.
const all = NET.processes.flatMap((p, i) => p.sites.map((s) => ({ ...s, proc: i, port: p.port })));
const byHost = new Map(all.map((s) => [s.host, s]));
const people = all.filter((s) => !s.group);
const ownerName = (s) => s.role === "hub" ? `Sam Taylor ${Number(s.host.slice(1, 4))}` : `Ann Example ${s.host.slice(1, 4)}`;

/** The site as its signed-in owner. */
export function owner(host) {
  const info = byHost.get(host);
  const site = new Site(host, info.port);
  for (const [k, v] of Object.entries(state.sites[host]?.cookies ?? {})) site.cookies.set(k, v);
  return site;
}

async function waitUp() {
  for (let i = 0; ; i++) {
    const answers = await Promise.all(NET.processes.map((p) => new Site(p.sites[0].host, p.port).fetch("/_version").then((r) => r.status, () => 0)));
    if (answers.every((s) => s === 200)) return;
    if (i > 600) throw new Error("The sites didn't start.");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const POSTS = 30; // each site's own posts (a friend's feed sends their newest 30)
const PHOTO_EVERY = 4; // 1 post in 4 has a photo

/** A made-up photo: JPEG markers round random bytes (the site stores and hashes it, and never decodes it). */
function photo(kb) {
  const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(kb * 1024), Buffer.from([0xff, 0xd9])]);
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}

/** Writes a post as the owner of `site`, with a made-up photo if `withPhoto`. */
export async function writePost(site, text, withPhoto) {
  const photos = [];
  if (withPhoto) {
    const full = photo(150);
    const thumb = photo(25);
    for (const f of [full, thumb]) {
      const put = await site.fetch(`/_admin/import/files/${f.hash}`, { method: "PUT", body: f.body, headers: { "Content-Type": "image/jpeg" } });
      if (put.status !== 200) throw new Error(`${site.host}: photo ${put.status} ${put.text.slice(0, 200)}`);
    }
    photos.push({ hash: full.hash, thumb_hash: thumb.hash, width: 2560, height: 1920, size: full.body.length });
  }
  const r = await site.fetch("/_admin/posts", { method: "POST", body: { text, photos } });
  if (r.status !== 200) throw new Error(`${site.host}: post ${r.status} ${r.text.slice(0, 200)}`);
}

/** Who is friends with whom: each hub with the first N leaves; each leaf with the 5 after it, round the ring (10 each). */
function friendships() {
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
    await pool(todo, 16, async (s) => {
      const { link } = await tools(s.proc, "/owner", { host: s.host, name: ownerName(s) });
      const site = new Site(s.host, s.port);
      await site.signInWith(link);
      state.sites[s.host] = { cookies: Object.fromEntries(site.cookies) };
      if (++done % 50 === 0) {
        save();
        console.log(`${done}/${todo.length} owners`);
      }
    });
    save();
    console.log(`Owners: ${people.length} sites signed in.`);
  },

  /** Each person's site gets its own posts, before it has friends (so no notes go out). */
  async posts() {
    const todo = people.filter((s) => !state.sites[s.host].posted);
    let done = 0;
    await pool(todo, 12, async (s) => {
      const site = owner(s.host);
      for (let n = 1; n <= POSTS; n++) await writePost(site, `Post ${n} from ${ownerName(s)}: a made-up post for the scale test.`, n % PHOTO_EVERY === 0);
      state.sites[s.host].posted = POSTS;
      if (++done % 50 === 0) {
        save();
        console.log(`${done}/${todo.length} sites posted`);
      }
    });
    save();
    console.log(`Posts: ${POSTS} each on ${people.length} sites.`);
  },

  /** Friend links made, pasted and approved, as people do it (connect.js). */
  async friends() {
    const pairs = friendships().filter(([a, b]) => !state.friends?.[`${a} ${b}`]);
    state.friends ??= {};
    let done = 0;
    let failed = 0;
    // A site makes one link at a time for each friend; spread so no site is asked by many at once.
    await pool(pairs, 24, async ([a, b]) => {
      try {
        const made = await owner(a).fetch("/_admin/connections/link", { method: "POST", body: {} });
        if (made.status !== 200) throw new Error(`link ${made.status} ${made.text.slice(0, 120)}`);
        const { link } = made.json();
        const added = await owner(b).fetch(`/_admin/connections/new?link=${encodeURIComponent(link)}`, { method: "POST", body: {} });
        if (added.status !== 200) throw new Error(`add ${added.status} ${added.text.slice(0, 120)}`);
        state.friends[`${a} ${b}`] = true;
      } catch (error) {
        failed++;
        console.error(`${a} → ${b}: ${error.message}`);
      }
      if (++done % 200 === 0) {
        save();
        console.log(`${done}/${pairs.length} friend links`);
      }
    });
    save();
    // Then each site lets in everyone asking (Friends → Approve).
    const askers = [...new Set(pairs.map(([a]) => a))];
    let approved = 0;
    await pool(askers, 16, async (host) => {
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
    console.log(`Friends: ${pairs.length - failed} links used, ${failed} failed, ${approved} approved.`);
  },

  /** Each group's site claimed by its owner (Groups → Start a group, self-hosted), and its members let in, 10 at a time. */
  async groups() {
    state.groups ??= {};
    for (const g of all.filter((s) => s.role === "group")) {
      const host = g.owner;
      const site = owner(host);
      const mine = (state.groups[g.host] ??= { members: {} });
      if (!mine.id) {
        const made = await site.fetch("/_groups/create/local", { method: "POST",
          body: { origin: `https://${g.host}`, setup: g.vars.GROUP_KEY, name: `Walkers ${g.members}`, about: "A made-up group for the scale test." } });
        if (made.status !== 200) throw new Error(`${g.host}: create ${made.status} ${made.text.slice(0, 200)}`);
        const claimed = await site.fetch("/_groups/create/claim", { method: "POST", body: { id: made.json().id } });
        if (claimed.status !== 200) throw new Error(`${g.host}: claim ${claimed.status} ${claimed.text.slice(0, 200)}`);
        mine.id = claimed.json().id;
        save();
      }
      const joining = all.filter((s) => s.role === "leaf").slice(0, g.members).filter((s) => !mine.members[s.host]);
      // At most 10 may wait at once (groups.js MAX_WAITING): ask, then let in, ten at a time. A link takes 100
      // requests, so each round gets a new one.
      for (let i = 0; i < joining.length; i += 10) {
        const link = await site.fetch(`/_groups/${mine.id}/link`, { method: "POST", body: {} });
        if (link.status !== 200) throw new Error(`${g.host}: link ${link.status} ${link.text.slice(0, 200)}`);
        const { link: joinLink } = link.json();
        await pool(joining.slice(i, i + 10), 10, async (s) => {
          const r = await owner(s.host).fetch("/_groups/join", { method: "POST", body: { link: joinLink } });
          if (r.status !== 200) throw new Error(`${s.host} joining ${g.host}: ${r.status} ${r.text.slice(0, 200)}`);
          mine.members[s.host] = r.json().id;
        });
        const page = await site.fetch(`/groups/${mine.id}/members`);
        const ids = [...new Set([...page.text.matchAll(new RegExp(`formaction="/_groups/${mine.id}/members/(\\d+)/approve`, "g"))].map((m) => m[1]))];
        for (const m of ids) {
          const r = await site.fetch(`/_groups/${mine.id}/members/${m}/approve`, { method: "POST", form: {} });
          if (r.status !== 303) throw new Error(`${g.host}: approve ${m}: ${r.status}`);
        }
        save();
      }
      const page = await site.fetch(`/groups/${mine.id}/members`);
      console.log(`${g.host}: ${Object.keys(mine.members).length} joined; members page ${page.status}, ${(page.text.match(/\/remove"/g) ?? []).length} removable.`);
    }
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

/** The measuring lines (timing.js AFTERWRD_STATS) for runs that started at or after `since`. */
function statsSince(since) {
  if (!existsSync("/out/stats.log")) return [];
  return readFileSync("/out/stats.log", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t0 >= since);
}

/** Waits until none of `hosts`' objects has finished a run for `quietMs` (at least `minMs`, at most `maxMs`). */
async function waitQuiet(hosts, since, { quietMs = 15_000, minMs = 5_000, maxMs = 15 * 60_000 } = {}) {
  const set = new Set(hosts);
  const start = Date.now();
  for (;;) {
    await sleep(2000);
    const last = Math.max(since, ...statsSince(since).filter((r) => !set.size || set.has(r.site)).map((r) => r.t0 + r.ms));
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
    for (const hub of all.filter((s) => s.role === "hub" && (!only || s.host === only))) {
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
        const posters = all.filter((s) => s.role === "leaf").slice(0, hub.friends).filter((_, i) => i % 3 === 0);
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
    const leaves = new Set(all.filter((s) => s.role === "leaf").slice(0, hub.friends).map((s) => s.host));
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
   * A day's activity squeezed into `minutes` (default 30): every hub, and a third of the others, each open Home 10
   * times, write a post (1 in 4 with a photo), comment on 5 friends' posts and open 2 friends' pages.
   */
  async day(minutes = "30") {
    const span = Number(minutes) * 60_000;
    const active = people.filter((s, i) => s.role === "hub" || i % 3 === 0);
    const events = [];
    for (const s of active) {
      const add = (type, n) => { for (let i = 0; i < n; i++) events.push({ at: Math.random() * span, s, type }); };
      add("home", 10);
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
    const friends = new Set(all.filter((s) => s.role === "leaf").slice(0, hub.friends).map((s) => s.host));
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

const [step, ...rest] = process.argv.slice(2);
if (!steps[step]) {
  console.error(`Steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await waitUp();
await steps[step](...rest);
