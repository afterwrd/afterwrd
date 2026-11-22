// Drives the scale test's network from inside its container (README.md; docs/signed-conversations.md, step 9b):
//   test/scale/scale.sh drive <step> [options]
// Setting up, in order: owners, posts, friends, groups, warm. Then the scenarios: day [minutes], oneoffs. Then report
// (analyse.mjs) reads what they recorded.
//
// Everything a person does is signed here as their browser would sign it (afterwrd 2): each owner signs in with a
// passkey made here, sets up signing with a recovery code (one passkey prompt signs their identity and this "browser's"
// key), and every post, comment, vote, join and approval is a record made with public/static/records.js (mounted at
// /static) and sent to the routes the pages use.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { makePasskey, machineOf, pool, Site, sleep, tools, toolsAddress } from "./lib.mjs";

const STATIC = process.env.SCALE_STATIC ?? "/static";
const { makeRecord } = await import(`${STATIC}/records.js`);
const S = await import(`${STATIC}/signed.js`);

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
const HERE = machineOf(NET.processes[0]);
if ((process.env.SCALE_MACHINE ?? "127.0.0.1") !== HERE) throw new Error(`Run drive.mjs on the first machine, ${HERE}.`);
const byHost = new Map(all.map((s) => [s.host, s]));
const people = all.filter((s) => !s.group);
const leaves = all.filter((s) => s.role === "leaf");
const hubs = all.filter((s) => s.role === "hub").sort((a, b) => b.friends - a.friends);
const groupSites = all.filter((s) => s.role === "group");
const number = (s) => s.host.slice(1, s.host.indexOf("."));
const ownerName = (s) => (s.role === "hub" ? `Sam Taylor ${Number(number(s))}` : `Ann Example ${number(s)}`);
const SQUEEZE = Number(NET.squeeze) || 1;

/** The site as its signed-in owner. */
function owner(host) {
  const info = byHost.get(host);
  const site = new Site(host, info.machine, info.port);
  for (const [k, v] of Object.entries(state.sites[host]?.cookies ?? {})) site.cookies.set(k, v);
  return site;
}

async function waitUp() {
  for (let i = 0; ; i++) {
    const answers = await Promise.all(NET.processes.filter((p) => p.sites.length)
      .map((p) => new Site(p.sites[0].host, machineOf(p), p.port).fetch("/_version").then((r) => r.status, () => 0)));
    if (answers.every((s) => s === 200)) return;
    if (i > 600) throw new Error("The sites didn't start.");
    await sleep(500);
  }
}

// How many at once while setting up: each friendship waits on a chain of calls between sites, so this sets the pace.
const AT_ONCE = Number(process.env.SCALE_AT_ONCE ?? 64);

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

/** Setting up carries on past a few failures, and gives up if more than `share` of `what` failed. */
function tooMany(failed, total, what, share = 0.02) {
  if (failed > total * share) throw new Error(`${failed} of ${total} ${what} failed: more than ${share * 100}%, so stopping`);
}

/** A seeded random number source, so a run's day is the same each time it's made. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Signing, as a browser does ---------------------------------------------------------------------------------------

const keys = new Map(); // host -> {privateKey, publicKey}, as records.js makeRecord takes them
async function keyOf(host) {
  if (!keys.has(host)) {
    const saved = state.sites[host];
    const privateKey = await crypto.subtle.importKey("pkcs8", Buffer.from(saved.key, "base64url"), { name: "Ed25519" }, false, ["sign"]);
    keys.set(host, { privateKey, publicKey: saved.publicKey });
  }
  return keys.get(host);
}
/** A record signed by `host`'s owner: {sent, fp}. */
const sign = async (host, fields, content) => makeRecord({ author: state.sites[host].person, ...fields }, content, await keyOf(host));

/** A passkey's answer to a prompt signing `statements` under `nonce` (signed.js statementsChallenge), as passkey.js gives it. */
async function passkeySigns(host, nonce, statements) {
  const passkey = makePasskey(host, state.sites[host].passkey);
  return passkey.login({ challenge: await S.statementsChallenge(nonce, statements) }, `https://${host}`, 0);
}

/**
 * POSTs JSON as the owner of `host` (or through `site`, one Site kept for steps that pass a challenge in a cookie, as
 * a start and finish do); the answer's JSON, or throws.
 */
async function post(host, path, body, ok = [200], site = owner(host)) {
  const r = await site.fetch(path, { method: "POST", body });
  if (!ok.includes(r.status)) throw new Error(`${path} ${r.status} ${r.text.slice(0, 160)}`);
  return r.text ? r.json() : {};
}

/** The data-sign-* attributes of the first form matching `cls` on a page (views/items.js signAttrs), or null. */
function signData(html, cls = "say") {
  const tag = new RegExp(`<form[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  const d = {};
  for (const m of tag.matchAll(/data-sign-([a-z-]+)="([^"]*)"/g)) d[m[1]] = m[2];
  return d;
}
const seenOf = (d) => (d?.["seen-n"] ? { n: Number(d["seen-n"]), h: d["seen-h"] } : null);

/** A record signed on the page at `path` (its comment form, or poll form) and sent where that page sends it. */
async function signOn(host, path, relay, kind, content, { form = "say", extra = {} } = {}) {
  const page = await owner(host).fetch(path);
  if (page.status !== 200) throw new Error(`${path}: ${page.status}`);
  const d = signData(page.text, form);
  if (!d) throw new Error(`${path}: no ${form} form`);
  const made = await sign(host, { kind, host: d.host, item: d.item, seen: seenOf(d), prev: d.prev || null,
    ...(kind === "vote" && { version: d.version || d.item }), ...extra }, content);
  const r = await owner(host).fetch(relay, { method: "POST", form: { sent: JSON.stringify(made.sent), back: path } });
  if (r.status !== 303 && r.status !== 200) throw new Error(`${relay}: ${r.status} ${r.text.slice(0, 160)}`);
  return made.fp;
}

// --- Photos and posts -------------------------------------------------------------------------------------------------

const PHOTO_KB = [60, 10]; // a made-up photo and its thumbnail (what's stored, and how, is the same whatever the size)
function photo(kb) {
  const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(kb * 1024), Buffer.from([0xff, 0xd9])]);
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}
async function upload(host) {
  const full = photo(PHOTO_KB[0]);
  const thumb = photo(PHOTO_KB[1]);
  for (const f of [full, thumb]) {
    const put = await owner(host).fetch(`/_admin/import/files/${f.hash}`, { method: "PUT", body: f.body, headers: { "Content-Type": "image/jpeg" } });
    if (put.status !== 200) throw new Error(`photo ${put.status} ${put.text.slice(0, 160)}`);
  }
  return { hash: full.hash, thumb_hash: thumb.hash, width: 2560, height: 1920, size: full.body.length };
}

/**
 * A post by `host`'s owner, signed as compose.js signs one: on their own site, or in a group (`group`: {id (on their
 * site), person}). Each photo is an item of its own, signed first. Returns the post's id.
 */
async function writePost(host, text, { withPhoto = false, group = null, extra = {} } = {}) {
  const photos = withPhoto ? [await upload(host)] : [];
  const fields = { kind: "item", host: group ? group.person : state.sites[host].person };
  const made = [];
  for (const p of photos) made.push(await sign(host, fields, { type: "photo", ...p }));
  const postRecord = await sign(host, fields, { type: "post", text, photos: photos.map((p, i) => ({ item: made[i].fp, ...p })), ...extra });
  if (group) await post(host, `/_groups/${group.id}/items`, { sent: postRecord.sent, photos: made.map((m) => m.sent), files: photos });
  else await post(host, "/_admin/items", { sent: postRecord.sent, photos: made.map((m) => m.sent) });
  return postRecord.fp;
}

// --- Setting up -----------------------------------------------------------------------------------------------------

const POSTS = 3; // each person's own posts before the day (Home keeps 10 a friend)

const steps = {
  /** Each person's site gets its owner, signed in with a passkey made here, and set up to sign (keys.js). */
  async owners() {
    await waitUp();
    const todo = people.filter((s) => !state.sites[s.host]?.person);
    let done = 0;
    let failed = 0;
    await pool(todo, Math.max(16, AT_ONCE / 4), async (s) => {
      try {
        await retry(3, async () => {
          const { link } = await tools(s.tools, "/owner", { host: s.host, name: ownerName(s) });
          const site = new Site(s.host, s.machine, s.port);
          await site.signInWith(link);
          // The recovery-code page (views/pages.js keysPage): its code's key, a new browser key, one prompt.
          const recovery = await S.recoveryKey(S.newRecoveryCode());
          const pair = await S.newKeyPair(true);
          const publicKey = await S.publicKeyText(pair.publicKey);
          const started = await site.fetch("/_admin/keys/start", { method: "POST", body: { recovery: recovery.publicKey, browserKey: publicKey } });
          if (started.status !== 200) throw new Error(`keys/start ${started.status} ${started.text.slice(0, 160)}`);
          const start = started.json();
          const statements = [await S.fingerprintOf("identity", S.fromB64url(start.identity)), await S.fingerprintOf("delegation", S.fromB64url(start.delegation))];
          const response = site.passkey.login({ challenge: await S.statementsChallenge(start.nonce, statements) }, site.origin, 0);
          const finished = await site.fetch("/_admin/keys/finish", { method: "POST", body: { identity: start.identity, delegation: start.delegation, response } });
          if (finished.status !== 200) throw new Error(`keys/finish ${finished.status} ${finished.text.slice(0, 160)}`);
          state.sites[s.host] = { cookies: Object.fromEntries(site.cookies), person: finished.json().person, publicKey,
            key: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64url"), passkey: site.passkey.saved() };
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
    console.log(`Owners: ${people.length - failed} sites signed in and signing, ${failed} failed.`);
    tooMany(failed, people.length, "owners");
  },

  /** Each person's own posts, before they have friends (so no notes go out): one in POSTS with a photo. */
  async posts() {
    const todo = people.filter((s) => state.sites[s.host]?.person && !state.sites[s.host].posted);
    let failed = 0;
    let done = 0;
    await pool(todo, Math.max(12, AT_ONCE / 4), async (s) => {
      for (let n = 1; n <= POSTS; n++) {
        try {
          await retry(3, () => writePost(s.host, `Post ${n} from ${ownerName(s)}: a made-up post for the scale test.`, { withPhoto: n === 1 }));
        } catch (error) {
          failed++;
          if (failed <= 50) console.error(`${s.host}: post ${n}: ${error.message}`);
        }
      }
      state.sites[s.host].posted = POSTS;
      if (++done % 100 === 0) {
        save();
        console.log(`${done}/${todo.length} sites posted`);
      }
    });
    save();
    console.log(`Posts: ${POSTS} each on ${todo.length} sites, ${failed} failed.`);
    tooMany(failed, todo.length * POSTS, "posts");
  },

  /**
   * Friend links made, pasted and approved, as people do it (connect.js): each hub with its first N leaves, and each
   * leaf with the 5 after it round the ring (10 each). In blocks, shuffled, so each block is spread over many sites.
   */
  async friends() {
    const pairs = [];
    for (const hub of hubs) for (const leaf of leaves.slice(0, hub.friends)) pairs.push([hub.host, leaf.host]);
    const reach = Math.min(5, Math.floor((leaves.length - 1) / 2));
    for (let i = 0; i < leaves.length; i++) for (let d = 1; d <= reach; d++) pairs.push([leaves[i].host, leaves[(i + d) % leaves.length].host]);
    const random = seeded(4242);
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    const BLOCK = 2000;
    state.friendBlocks ??= 0;
    let failed = 0;
    let approved = 0;
    const ask = async ([a, other]) => {
      const { link } = await post(a, "/_admin/connections/link", {});
      const added = await owner(other).fetch(`/_admin/connections/new?link=${encodeURIComponent(link)}`, { method: "POST", body: {} });
      if (added.status !== 200 && !(added.status === 409 && /already/i.test(added.text))) throw new Error(`add ${added.status} ${added.text.slice(0, 120)}`);
    };
    const letIn = async (host) => {
      const site = owner(host);
      for (;;) {
        const page = await site.fetch("/friend");
        const ids = [...new Set([...page.text.matchAll(/formaction="\/_admin\/connections\/(\d+)\/approve/g)].map((m) => m[1]))];
        if (!ids.length) return;
        for (const id of ids) {
          const r = await site.fetch(`/_admin/connections/${id}/approve`, { method: "POST", form: {} });
          if (r.status !== 303) throw new Error(`${host}: approve ${id}: ${r.status}`);
          approved++;
        }
      }
    };
    const missed = [];
    for (let b = state.friendBlocks; b * BLOCK < pairs.length; b++) {
      const block = pairs.slice(b * BLOCK, (b + 1) * BLOCK);
      await pool(block, AT_ONCE, async (pair) => {
        try { await ask(pair); } catch (error) {
          failed++;
          missed.push(pair);
          if (failed <= 50) console.error(`${pair[0]} → ${pair[1]}: ${error.message}`);
        }
      });
      await pool([...new Set(block.map(([a]) => a))], 32, (host) => letIn(host).catch((e) => console.error(e.message)));
      state.friendBlocks = b + 1;
      save();
      console.log(`${Math.min((b + 1) * BLOCK, pairs.length)}/${pairs.length} friendships, ${failed} failed, ${approved} approved`);
    }
    let again = 0;
    await pool(missed, 16, async (pair) => { try { await ask(pair); again++; } catch {} });
    await pool([...new Set(missed.map(([a]) => a))], 16, (host) => letIn(host).catch(() => {}));
    console.log(`Friends: ${pairs.length} friendships, ${failed} failed, ${again} of them made on a second try, ${approved} approved.`);
    tooMany(failed - again, pairs.length, "friendships");
  },

  /**
   * Each group's site claimed by its owner (Groups → Start a group, self-hosted), its identity signed by their passkey
   * (groupidentity.js), and its members let in as people are: each signs a `join` through an invite link, and the
   * owner signs an `approve` for each (members.js). At most 10 wait at once (groups.js), so ten at a time.
   */
  async groups() {
    state.groups ??= {};
    for (const g of groupSites) {
      const host = g.owner;
      const mine = (state.groups[g.host] ??= { members: {} });
      if (!mine.person) {
        // Each part kept as it's done, so a retry carries on from where it stopped.
        await retry(3, async () => {
          try {
            mine.made ??= (await post(host, "/_groups/create/local", { origin: `https://${g.host}`, setup: g.vars.GROUP_KEY, name: `Walkers ${g.members}`,
              about: "A made-up group for the scale test." })).id;
            mine.id ??= (await post(host, "/_groups/create/claim", { id: mine.made })).id;
            save();
            const site = owner(host); // the challenge comes back as a cookie (auth.js withChallenge)
            const start = await post(host, `/_groups/${mine.id}/identity/start`, {}, [200], site);
            const response = await passkeySigns(host, start.nonce, [await S.fingerprintOf("identity", S.fromB64url(start.doc))]);
            await post(host, `/_groups/${mine.id}/identity/finish`, { doc: start.doc, response }, [200], site);
          } catch (error) {
            console.error(`${g.host}: starting it: ${error.message}`);
            throw error;
          }
        });
        const chain = (await new Site(g.host, g.machine, g.port).fetch("/.well-known/afterwrd")).json().chain;
        mine.person = await S.fingerprintOf("identity", S.fromB64url(chain[0].bytes));
        save();
      }
      // The owner signs an approve for each join waiting (ui/groupsign.js, from the members page's buttons).
      const approveWaiting = async () => {
        const page = await owner(host).fetch(`/groups/${mine.id}/members`);
        const joins = [...new Set([...page.text.matchAll(/data-group-record="approve"[^>]*data-about="([A-Za-z0-9_-]{43})"/g)].map((m) => m[1]))];
        for (const about of joins) {
          const at = await post(host, `/_groups/${mine.id}/point`, {});
          const made = await sign(host, { kind: "approve", host: at.host, item: at.item, seen: at.seen ?? null, prev: at.prev ?? null, about,
            ...(at.role_at && { role_at: at.role_at }) });
          await post(host, `/_groups/${mine.id}/records`, { sent: made.sent });
        }
        return joins.length;
      };
      await approveWaiting();
      const tries = new Map();
      // Members are the first (members - 1) leaves: with the owner, `members` in all.
      let joining = leaves.slice(0, g.members - 1).filter((s) => state.sites[s.host]?.person && !mine.members[s.host]);
      const started = Date.now();
      for (let round = 0; joining.length; round++) {
        const batch = joining.slice(0, 10);
        joining = joining.slice(10);
        const { link } = await retry(3, () => post(host, `/_groups/${mine.id}/link`, {}));
        await pool(batch, 10, async (s) => {
          try {
            const at = await post(s.host, "/_groups/join/point", { link });
            const made = await sign(s.host, { kind: "join", host: at.host, item: at.item, seen: at.seen ?? null, prev: at.prev ?? null }, { name: at.name });
            mine.members[s.host] = (await post(s.host, "/_groups/join", { sent: made.sent, link })).id;
          } catch (error) {
            const n = (tries.get(s.host) ?? 0) + 1;
            tries.set(s.host, n);
            if (n < 3) joining.push(s);
            else console.error(`${s.host} couldn't join ${g.host}: ${error.message}`);
          }
        });
        await retry(3, approveWaiting).catch((error) => console.error(`${g.host}: letting people in: ${error.message}`));
        save();
        if (round % 10 === 9) console.log(`${g.host}: ${Object.keys(mine.members).length} of ${g.members - 1} joined (${Math.round((Date.now() - started) / 1000)} s)`);
      }
      console.log(`${g.host}: ${Object.keys(mine.members).length} joined in ${Math.round((Date.now() - started) / 1000)} s.`);
    }
  },

  /**
   * Everyone opens Home once, so their sites have copies of all their friends' posts and groups' (and the harness
   * learns each site's numbers for its friends), before the day: as people who've used afterwrd a while.
   */
  async warm() {
    const since = Date.now();
    let failed = 0;
    await pool(people.filter((s) => state.sites[s.host]?.person), Math.max(24, AT_ONCE / 4), async (s) => {
      try { await retry(3, () => home(s.host)); } catch (error) {
        failed++;
        if (failed <= 50) console.error(`${s.host}: ${error.message}`);
      }
    });
    tooMany(failed, people.length, "first Homes", 0.05);
    console.log(`Home opened on all ${people.length} sites; waiting for their copies to settle`);
    await waitQuiet([], since, { quietMs: 30_000, maxMs: 10 * 60_000 });
    // Once more, now the copies are there, for the friends' numbers.
    await pool(people.filter((s) => state.sites[s.host]?.person), 24, (s) => home(s.host).catch(() => {}));
    save();
    console.log(`Warm: ${Math.round((Date.now() - since) / 1000)} s.`);
  },
};

// --- Pages, as people open them --------------------------------------------------------------------------------------

/**
 * Home, as `host`'s owner opens it: the friends' posts on it, by friend (each friend's number on this site is learnt
 * from its cards: views/items.js friendItemCard), kept in state.sites[host].friends.
 */
async function home(host) {
  const r = await owner(host).fetch("/");
  if (r.status !== 200) throw new Error(`Home ${r.status}`);
  const friends = (state.sites[host].friends ??= {});
  const posts = [];
  for (const m of r.text.matchAll(/id="fi(\d+)-([A-Za-z0-9_-]{43})"[^>]*data-who="https:\/\/([^"]+)"/g)) {
    friends[m[3]] = Number(m[1]);
    posts.push({ friend: m[3], connection: Number(m[1]), id: m[2] });
  }
  return posts;
}
const friendPost = (host, poster, id) => `/friend/${state.sites[host].friends?.[poster]}/posts/${id}`;
const friendRelay = (host, poster, id) => `/_admin/friend/${state.sites[host].friends?.[poster]}/items/${id}/records`;

// --- The measuring lines (timing.js AFTERWRD_STATS) ------------------------------------------------------------------

const STATS = "/out/stats.log";
const KEEP_MS = 20 * 60_000;
let statsRead = existsSync(STATS) ? statSync(STATS).size : 0;
let statsPartial = Buffer.alloc(0);
let recent = [];
/** Reads the lines added since last time, a piece at a time (a day can add gigabytes), keeping the last KEEP_MS. */
function readNewStats() {
  if (!existsSync(STATS)) return;
  const size = statSync(STATS).size;
  if (size < statsRead) statsRead = 0;
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
          if (r.t0 >= cutoff) recent.push({ site: r.site, obj: r.obj, m: r.m, path: r.path, t0: r.t0, ms: r.ms, rr: r.rr, rw: r.rw, calls: r.calls, refused: r.refused, st: r.st });
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
function statsSince(since) {
  readNewStats();
  return recent.filter((r) => r.t0 >= since);
}
/** Waits until none of `hosts`' objects (any, if none given) has finished a run for `quietMs`. */
async function waitQuiet(hosts, since, { quietMs = 15_000, minMs = 5_000, maxMs = 15 * 60_000 } = {}) {
  const set = new Set(hosts);
  const start = Date.now();
  let said = start;
  for (;;) {
    await sleep(2000);
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

// --- The day (section 8's assumptions) --------------------------------------------------------------------------------

const groupOf = (memberHost) => {
  for (const g of groupSites) {
    const mine = state.groups?.[g.host];
    const id = memberHost === g.owner ? mine?.id : mine?.members[memberHost];
    if (id) return { site: g.host, id, person: mine.person };
  }
  return null;
};

Object.assign(steps, {
  /**
   * One day, as section 8 of docs/signed-conversations.md assumes it, squeezed into `minutes` (by default a day over
   * the network's squeeze: 3 hours at 8):
   * - everyone posts 2 items (1 in 4 with a photo), visits Home 10 times and opens 5 of their friends' posts;
   * - each post gets about 10 comments from the poster's friends (20 comments a person);
   * - the person with the most friends (the first hub) has each of their posts opened by 100 friends, 10 commenting;
   * - the group gets 50 posts (a third with a photo) with 20 comments each, and every member opens it 3 times and 5 of
   *   its posts.
   * The real limits apply (allowances, caps), and honest sites should never meet them. Each action is logged.
   */
  async day(minutes) {
    const span = (Number(minutes) || 24 * 60 / SQUEEZE) * 60_000;
    const random = seeded(2026);
    const at = () => Math.floor(random() * span);
    const actions = [];
    const active = people.filter((s) => state.sites[s.host]?.person);
    const big = hubs[0];
    for (const s of active) {
      for (let k = 0; k < 10; k++) actions.push({ t: at(), who: s.host, kind: "home" });
      for (let k = 0; k < 2; k++) actions.push({ t: at(), who: s.host, kind: "post", photo: random() < 0.25 });
      if (s.host === big.host) continue; // the first hub's friends' posts are opened through their own schedule
      for (let k = 0; k < 5; k++) actions.push({ t: at(), who: s.host, kind: "open" });
      for (let k = 0; k < 20; k++) actions.push({ t: at(), who: s.host, kind: "comment" });
    }
    // The first hub's two posts: 100 friends open each, 10 of them comment, in the hours after it's posted.
    for (const a of actions.filter((x) => x.who === big.host && x.kind === "post")) {
      a.watched = true;
      const friends = leaves.slice(0, big.friends);
      for (let k = 0; k < 100; k++) {
        const t = a.t + Math.floor(random() * Math.max(1, span - a.t));
        actions.push({ t, who: pickFrom(friends, random).host, kind: "open-big", comment: k < 10 });
      }
    }
    // The group.
    for (const g of groupSites) {
      const members = [g.owner, ...Object.keys(state.groups?.[g.host]?.members ?? {})];
      for (let k = 0; k < 50; k++) actions.push({ t: at(), who: pickFrom(members, random), kind: "gpost", photo: k % 3 === 0 });
      for (let k = 0; k < 50 * 20; k++) actions.push({ t: at(), who: pickFrom(members, random), kind: "gcomment" });
      for (const m of members) {
        for (let k = 0; k < 3; k++) actions.push({ t: at(), who: m, kind: "gopen" });
        for (let k = 0; k < 5; k++) actions.push({ t: at(), who: m, kind: "gthread" });
      }
    }
    actions.sort((a, b) => a.t - b.t);
    const todayBy = new Map(); // poster -> their posts today (ids)
    const groupToday = new Map(); // group site -> posts today
    const counts = {};
    const failures = {};
    const count = (kind, ok) => {
      counts[kind] ??= { ok: 0, failed: 0, skipped: 0 };
      counts[kind][ok]++;
    };
    const since = Date.now();
    console.log(`The day: ${actions.length} actions over ${Math.round(span / 60_000)} minutes, from ${new Date(since).toISOString()}`);
    const log = openSync("/out/results-day.jsonl", "a");
    const act = async (a) => {
      const g = a.kind.startsWith("g") ? groupOf(a.who) : null;
      switch (a.kind) {
        case "home": await home(a.who); return "ok";
        case "post": {
          const id = await writePost(a.who, `A post for the day [${Math.round(a.t / 1000)}]`, { withPhoto: a.photo });
          (todayBy.get(a.who) ?? todayBy.set(a.who, []).get(a.who)).push(id);
          return "ok";
        }
        case "open": case "comment": {
          // A friend's post from today (or their newest, early in the day), not the first hub's (it has its own).
          const friends = Object.keys(state.sites[a.who].friends ?? {}).filter((h) => h !== big.host);
          const poster = pickFrom(friends.filter((h) => todayBy.get(h)?.length), random) ?? null;
          if (!poster) return "skipped";
          const id = pickFrom(todayBy.get(poster), random);
          if (a.kind === "open") {
            const r = await owner(a.who).fetch(friendPost(a.who, poster, id));
            if (r.status !== 200) throw new Error(`open ${r.status}`);
          } else {
            await signOn(a.who, friendPost(a.who, poster, id), friendRelay(a.who, poster, id), "comment", { text: "A comment for the day." });
          }
          return "ok";
        }
        case "open-big": {
          const id = todayBy.get(big.host)?.at(-1);
          if (!id || !state.sites[a.who].friends?.[big.host]) return "skipped";
          if (a.comment) await signOn(a.who, friendPost(a.who, big.host, id), friendRelay(a.who, big.host, id), "comment", { text: "Lovely." });
          else {
            const r = await owner(a.who).fetch(friendPost(a.who, big.host, id));
            if (r.status !== 200) throw new Error(`open ${r.status}`);
          }
          return "ok";
        }
        case "gpost": {
          if (!g) return "skipped";
          const id = await writePost(a.who, "A post for the group's day.", { withPhoto: a.photo, group: g });
          (groupToday.get(g.site) ?? groupToday.set(g.site, []).get(g.site)).push(id);
          return "ok";
        }
        case "gcomment": case "gthread": {
          const posts = g && groupToday.get(g.site);
          if (!posts?.length) return "skipped";
          const id = pickFrom(posts, random);
          const path = `/groups/${g.id}/posts/${id}`;
          if (a.kind === "gthread") {
            const r = await owner(a.who).fetch(path);
            if (r.status !== 200) throw new Error(`thread ${r.status}`);
          } else await signOn(a.who, path, `/_groups/${g.id}/items/${id}/records`, "comment", { text: "A comment for the group's day." });
          return "ok";
        }
        case "gopen": {
          if (!g) return "skipped";
          const r = await owner(a.who).fetch(`/groups/${g.id}`);
          if (r.status !== 200) throw new Error(`group ${r.status}`);
          return "ok";
        }
        default: return "skipped";
      }
    };
    let next = 0;
    let running = 0;
    let lastSaid = since;
    const AT_MOST = 200; // actions at once (a slow site holds one up for a while)
    await new Promise((resolve) => {
      const tick = () => {
        const now = Date.now() - since;
        while (next < actions.length && actions[next].t <= now && running < AT_MOST) {
          const a = actions[next++];
          running++;
          const started = Date.now();
          act(a).then((how) => { count(a.kind, how); return how; }, (error) => {
            count(a.kind, "failed");
            const why = String(error.message).slice(0, 80);
            failures[`${a.kind}: ${why}`] = (failures[`${a.kind}: ${why}`] ?? 0) + 1;
            return "failed";
          }).then((how) => {
            running--;
            const line = JSON.stringify({ t: started - since, kind: a.kind, who: a.who, how, ms: Date.now() - started });
            try { writeFileSync(log, `${line}\n`); } catch {}
          });
        }
        if (Date.now() - lastSaid > 60_000) {
          lastSaid = Date.now();
          console.log(`  ${Math.round(now / 60_000)} min: ${next}/${actions.length} started, ${running} running`);
        }
        if (next >= actions.length && running === 0) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
    closeSync(log);
    const until = Date.now();
    // A squeezed network is never quiet (its sites pull each other every few minutes), so it's given a fixed while to
    // finish what the day set going (notes, the last pulls), and that's counted with the day.
    const settle = Math.min(2 * 60_000, span / 20);
    console.log(`The day's actions done in ${Math.round((until - since) / 60_000)} minutes; ${Math.round(settle / 1000)} s for the sites to settle`);
    await sleep(settle);
    record("day", { since, until, settled: Date.now(), span, squeeze: SQUEEZE, counts, failures, big: big.host,
      group: groupSites[0]?.host ?? null, groupOwner: groupSites[0]?.owner ?? null });
    save();
  },

  /**
   * One-offs, each measured on its own: the first hub's post reaching all its friends (fat notes from its Outbox: how
   * many runs, and how long until the last arrives); an @here to the whole group; a poll in the group that every member
   * answers and opens.
   */
  async oneoffs() {
    const big = hubs[0];
    const friends = new Set(leaves.slice(0, big.friends).map((s) => s.host));
    // 1. Fan-out.
    let since = Date.now();
    const id = await writePost(big.host, "One post, to everyone.", { withPhoto: true });
    const reached = new Map();
    for (;;) {
      await sleep(5000);
      for (const r of statsSince(since)) if (friends.has(r.site) && r.obj === "site" && r.path === "/_p/notes" && !reached.has(r.site)) reached.set(r.site, r.t0 + r.ms - since);
      console.log(`  fan-out ${Math.round((Date.now() - since) / 1000)} s: ${reached.size}/${friends.size} told`);
      if (reached.size >= friends.size || Date.now() - since > 20 * 60_000) break;
    }
    await sleep(30_000); // its Outbox's last runs (a squeezed network is never quiet)
    const runs = statsSince(since).filter((r) => r.site === big.host && r.obj === "outbox");
    const times = [...reached.values()].sort((a, b) => a - b);
    const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? null;
    const fanout = { post: id, friends: friends.size, told: reached.size, ms: { p50: q(0.5), p90: q(0.9), last: times.at(-1) ?? null },
      outboxRuns: runs.length, outboxCalls: runs.reduce((n, r) => n + (r.calls ?? 0), 0), refused: runs.reduce((n, r) => n + (r.refused ?? 0), 0),
      longestRunMs: Math.max(0, ...runs.map((r) => r.ms)) };
    console.log(`  fan-out: ${JSON.stringify(fanout)}`);
    // 2. @here, from the group's owner.
    const g = groupSites[0];
    const results = { fanout };
    if (g) {
      const gs = groupOf(g.owner);
      const members = new Set(Object.keys(state.groups[g.host].members));
      since = Date.now();
      await writePost(g.owner, "@here: walk moved to 10am", { group: gs, extra: { here: true } });
      const told = new Map();
      for (;;) {
        await sleep(5000);
        for (const r of statsSince(since)) if (members.has(r.site) && r.obj === "site" && r.path === "/_p/notes" && !told.has(r.site)) told.set(r.site, r.t0 + r.ms - since);
        if (told.size >= members.size || Date.now() - since > 20 * 60_000) break;
      }
      await sleep(30_000);
      const gRuns = statsSince(since).filter((r) => r.site === g.host);
      const tt = [...told.values()].sort((a, b) => a - b);
      results.here = { members: members.size, told: told.size, lastMs: tt.at(-1) ?? null, groupRuns: gRuns.length,
        outboxRuns: gRuns.filter((r) => r.obj === "outbox").length, rowsWritten: gRuns.reduce((n, r) => n + (r.rw ?? 0), 0) };
      console.log(`  @here: ${JSON.stringify(results.here)}`);
      // 3. A poll every member answers and then opens.
      since = Date.now();
      const poll = await writePost(g.owner, "Which day for the big walk?", { group: gs, extra: { poll: { options: ["Saturday", "Sunday"], multiple: 0, closes_at: null } } });
      let voted = 0;
      let failed = 0;
      const voters = [...members];
      await pool(voters, 32, async (host, i) => {
        const mineG = groupOf(host);
        const path = `/groups/${mineG.id}/posts/${poll}`;
        try {
          await signOn(host, path, `/_groups/${mineG.id}/items/${poll}/records`, "vote", { choices: [i % 2] }, { form: "poll-form" });
          voted++;
        } catch (error) {
          if (++failed <= 10) console.error(`${host}: vote: ${error.message}`);
        }
      });
      const votedAt = Date.now();
      const opens = [];
      await pool(voters, 32, async (host) => {
        const mineG = groupOf(host);
        const r = await owner(host).fetch(`/groups/${mineG.id}/posts/${poll}`).catch(() => null);
        if (r) opens.push(r.ms);
      });
      await sleep(10_000);
      const pollRuns = statsSince(votedAt).filter((r) => r.site === g.host && r.obj === "site" && r.path.startsWith("/_p/items/"));
      opens.sort((a, b) => a - b);
      results.poll = { voters: voters.length, voted, failed, votingMs: votedAt - since, opens: opens.length,
        openMs: { p50: opens[Math.floor(opens.length / 2)] ?? null, p90: opens[Math.floor(opens.length * 0.9)] ?? null },
        groupRowsReadPerOpen: pollRuns.length ? Math.round(pollRuns.reduce((n, r) => n + r.rr, 0) / pollRuns.length) : null };
      console.log(`  poll: ${JSON.stringify(results.poll)}`);
    }
    record("oneoffs", results);
  },
});

Object.assign(steps, {
  /** Does nothing, for ever: for rehearsing the watchdog (README.md, "When a run ends"). */
  async stall() {
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
  },
});

function pickFrom(list, random) {
  return list?.length ? list[Math.floor(random() * list.length)] : undefined;
}

const [step, ...rest] = process.argv.slice(2);
if (!steps[step]) {
  console.error(`Steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await steps[step](...rest);
process.exit(0);
