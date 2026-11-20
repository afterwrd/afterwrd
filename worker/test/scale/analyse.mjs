// The scale test's report (docs/scale-test-plan.md), from what drive.mjs recorded (test/scale/out/results/*.json) and
// every object run's measuring line (out/stats.log, timing.js AFTERWRD_STATS):
//   node test/scale/analyse.mjs        writes test/scale/out/report.md (and prints it)
//   node test/scale/analyse.mjs <dir>  the same for results copied elsewhere (results/, stats.log and net.json in <dir>)
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.argv[2] ? `${resolve(process.argv[2])}/` : fileURLToPath(new URL("out/", import.meta.url));
const net = JSON.parse(readFileSync(`${OUT}net.json`, "utf8"));
const sites = net.processes.flatMap((p) => p.sites);
const results = Object.fromEntries(existsSync(`${OUT}results`)
  ? readdirSync(`${OUT}results`).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(`${OUT}results/${f}`, "utf8"))])
  : []);
const siteByHost = new Map(sites.map((s) => [s.host, s]));

// The free plan, per Cloudflare account per day (docs/site-object-plan.md, read 17 Nov 2026).
const LIMITS = { requests: 100_000, gbs: 13_000, read: 5_000_000, written: 100_000 };
const GB_PER_OBJECT = 0.128; // Cloudflare bills an object's active time at 128 MB

// Largest and smallest without spreading: a big network's runs are too many for a function's arguments.
const most = (xs, start = -Infinity) => xs.reduce((a, x) => (x > a ? x : a), start);
const least = (xs) => xs.reduce((a, x) => (x < a ? x : a), Infinity);
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const quantile = (xs, q) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const fmt = (n, digits = 0) => !Number.isFinite(n) ? "–" : n.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (n, of) => `${fmt((100 * n) / of, 1)}%`;
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** Each object's active time, from its runs: the time any run was going (lower), and with each run kept 10 s longer
 * (upper: in case Cloudflare counts an object as active until it's been idle a while). In object-seconds. */
function activeSeconds(list, tail = 0) {
  const byObject = new Map();
  for (const r of list) {
    const key = `${r.site} ${r.obj}`;
    if (!byObject.has(key)) byObject.set(key, []);
    byObject.get(key).push([r.t0, r.t0 + r.ms + tail]);
  }
  let total = 0;
  for (const spans of byObject.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = spans[0];
    for (const [s, e] of spans.slice(1)) {
      if (s > end) {
        total += end - start;
        [start, end] = [s, e];
      } else end = Math.max(end, e);
    }
    total += end - start;
  }
  return total / 1000;
}

/** The Cloudflare account a site's runs count against: its own (a group is taken as installed in an account of its own,
 *  not its owner's, so a person's numbers and a group's can be read apart). */
function accountOf(host) {
  return host;
}

function accounts(list) {
  const by = new Map();
  for (const r of list) {
    const a = accountOf(r.site);
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(r);
  }
  return [...by].map(([account, rs]) => ({
    account,
    role: siteByHost.get(account)?.role ?? "?",
    // Each run of an object is one Durable Object request; each visit or call coming in is also one Worker request.
    objectRequests: rs.length,
    workerRequests: rs.filter((r) => r.obj === "site" && r.m === "fetch").length,
    read: rs.reduce((a, r) => a + r.rr, 0),
    written: rs.reduce((a, r) => a + r.rw, 0),
    activeLow: activeSeconds(rs),
    activeHigh: activeSeconds(rs, 10_000),
    refused: rs.reduce((a, r) => a + r.refused, 0),
    maxCalls: most(rs.map((r) => r.calls), 0),
  }));
}

/** A path with its ids and keys taken out, so like requests group together. */
const shape = (path) => path.replace(/\/post-\d+-[0-9a-f]{8}/g, "/:post").replace(/\/[0-9a-f]{20,}/g, "/:hash").replace(/\/\d+/g, "/:n")
  .replace(/\/_connect\/[\w-]{20,}/, "/_connect/:token").replace(/\/_join\/[\w-]{20,}/, "/_join/:token");

// The measuring lines, read a line at a time (a big network's day is gigabytes of them). The scenarios' windows (a few
// minutes each) are kept whole, for the sections below; the social model's day is added up as it goes (dayRun).
const day = results["social-day"];
const windows = Object.entries(results).filter(([k]) => k !== "social-day").map(([, r]) => r).filter((r) => r.since && r.until);
const runs = [];
const totals = { runs: 0, maxCalls: 0, refused: new Map() };
const dayTotals = { accounts: new Map(), kinds: new Map(), problems: new Map(), groupOpens: new Map(), runs: 0, unchangedFeeds: 0 };
/** A sample of up to 500 of what's added, for medians of things there are millions of. */
const sample = (list, x, seen) => {
  if (list.length < 500) list.push(x);
  else if (Math.random() < 500 / seen) list[Math.floor(Math.random() * 500)] = x;
};
function dayRun(r) {
  dayTotals.runs++;
  const account = accountOf(r.site);
  let a = dayTotals.accounts.get(account);
  if (!a) dayTotals.accounts.set(account, (a = { requests: 0, worker: 0, read: 0, written: 0, busyMs: 0, refused: 0 }));
  a.requests++;
  if (r.obj === "site" && r.m === "fetch") a.worker++;
  a.read += r.rr;
  a.written += r.rw;
  a.busyMs += r.ms;
  a.refused += r.refused;
  const role = siteByHost.get(r.site)?.group ? "group" : "person";
  const key = `${role} ${r.obj.startsWith("media") ? "media" : r.obj} ${r.m} ${shape(r.path)}`.trim();
  let k = dayTotals.kinds.get(key);
  if (!k) dayTotals.kinds.set(key, (k = { n: 0, rr: 0, rw: 0, ms: [], maxCalls: 0 }));
  k.n++;
  k.rr += r.rr;
  k.rw += r.rw;
  k.maxCalls = Math.max(k.maxCalls, r.calls);
  sample(k.ms, r.ms, k.n);
  if (r.obj === "site" && r.path === "/_peer/feed" && r.rr <= 5) dayTotals.unchangedFeeds++;
  if ((r.st ?? 0) >= 400 || r.failed) {
    const p = `${role} ${r.m} ${shape(r.path)} ${r.failed ? "threw" : r.st}`;
    dayTotals.problems.set(p, (dayTotals.problems.get(p) ?? 0) + 1);
  }
  if (role === "group" && r.obj === "site" && r.path.startsWith("/_group/posts") && r.rw === 0) {
    let g = dayTotals.groupOpens.get(r.site);
    if (!g) dayTotals.groupOpens.set(r.site, (g = { n: 0, rows: [] }));
    g.n++;
    sample(g.rows, r.rr, g.n);
  }
}
for await (const line of createInterface({ input: createReadStream(`${OUT}stats.log`), crlfDelay: Infinity })) {
  if (!line) continue;
  const r = JSON.parse(line);
  totals.runs++;
  totals.maxCalls = Math.max(totals.maxCalls, r.calls);
  if (r.refused > 0) {
    const k = `${r.site} ${r.obj} ${r.m} ${shape(r.path)}`;
    totals.refused.set(k, (totals.refused.get(k) ?? 0) + r.refused);
  }
  if (windows.some((w) => r.t0 >= w.since && r.t0 <= w.until)) runs.push(r);
  if (day && r.t0 >= day.since && r.t0 <= day.until) dayRun(r);
}
const within = (r, { since, until }) => runs.filter((x) => x.t0 >= since && x.t0 <= until);

const out = [];
const say = (s = "") => out.push(s);
say(`# Scale test report`);
say();
say(`${sites.length} sites (${sites.filter((s) => s.role === "hub").length} hubs, ${sites.filter((s) => s.role === "leaf").length} others, ` +
  `${sites.filter((s) => s.group).length} groups) in ${net.processes.length} workerd processes` +
  `${new Set(net.processes.map((p) => p.machine ?? "")).size > 1 ? ` on ${new Set(net.processes.map((p) => p.machine)).size} machines` : ""}. Calls between sites: ` +
  `${net.testNet.minMs}–${net.testNet.maxMs} ms, ${pct(net.testNet.slowRate, 1)} take ${net.testNet.slowMs} ms, ${pct(net.testNet.hangRate, 1)} hang ` +
  `${net.testNet.hangMs / 1000} s, ${pct(net.testNet.failRate, 1)} fail. Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`);
say();
say(`**Calls out:** across ${fmt(totals.runs)} object runs, the most any one made was ${totals.maxCalls} (the free plan allows 50); ` +
  `${totals.refused.size ? `calls were refused in: ${[...totals.refused].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${fmt(n)})`).join("; ")}` : "none was refused"}.`);

// --- Home
const homes = Object.entries(results).filter(([k]) => k.startsWith("home-")).map(([, r]) => r).sort((a, b) => a.friends - b.friends);
if (homes.length) {
  say();
  say(`## Home`);
  say();
  say(`CPU is the site's whole isolate while the page was made (V8's profiler; this Mac, not Cloudflare's servers).`);
  say();
  const rows = [];
  for (const h of homes) {
    const of = (label) => h.rows.filter((r) => r.label === label);
    for (const [label, list] of [["first visit", of("first")], ["warm (median of 5)", of("warm")], ["a friend's page (median)", of("friend page")],
      ["10 s after a burst", of("burst +10s")], ["60 s after a burst", of("burst +60s")]]) {
      if (!list.length) continue;
      const m = (k) => median(list.map((r) => r[k]));
      rows.push([`${h.friends}`, label, `${fmt(m("wallMs"))} ms`, `${fmt(m("cpuMs"), 1)} ms`, fmt(m("calls")), fmt(m("queries")), fmt(m("rowsRead")),
        label.includes("burst") ? `${fmt(m("burst"))} of ${h.burst.posters} new` : fmt(m("friendPosts"))]);
    }
  }
  say(table(["Friends", "Visit", "Waited", "CPU", "Calls out", "Queries", "Rows read", "Friends' posts shown"], rows));
  for (const h of homes) {
    const list = within(runs, h);
    const mine = list.filter((r) => r.site === h.hub && r.obj === "outbox" && r.m === "alarm");
    say();
    say(`- **${h.friends} friends:** the Outbox's background refreshes took ${mine.length} alarm runs (most calls in one: ` +
      `${most(mine.map((r) => r.calls), 0)}); the site wrote ${fmt(list.filter((r) => r.site === h.hub).reduce((a, r) => a + r.rw, 0))} rows ` +
      `in this scenario.`);
  }
}

// --- Fan-out
const f = results.fanout;
if (f) {
  const list = within(runs, f);
  const alarms = list.filter((r) => r.site === f.hub && r.obj === "outbox" && r.m === "alarm");
  const feeds = list.filter((r) => r.site === f.hub && r.obj === "site" && r.path === "/_peer/feed");
  const sec = (ms) => `${fmt(ms / 1000, 1)} s`;
  say();
  say(`## One post reaching ${f.friends} friends`);
  say();
  say(`- **Told:** ${f.told} of ${f.friends}: half by ${sec(f.toldMs.p50)}, 90% by ${sec(f.toldMs.p90)}, the last at ${sec(f.toldMs.last)}.`);
  say(`- **The Outbox:** ${alarms.length} alarm runs, at most ${most(alarms.map((r) => r.calls), 0)} calls in one, ` +
    `${alarms.reduce((a, r) => a + r.refused, 0)} refused; ${fmt(alarms.reduce((a, r) => a + r.rw, 0))} rows written by them.`);
  if (feeds.length) {
    const t0 = least(feeds.map((r) => r.t0));
    const t1 = most(feeds.map((r) => r.t0 + r.ms));
    say(`- **The rush back:** friends' sites asked for the hub's newest posts ${feeds.length} times over ${sec(t1 - t0)} ` +
      `(median ${fmt(median(feeds.map((r) => r.ms)))} ms each, slowest ${fmt(most(feeds.map((r) => r.ms)))} ms), reading ` +
      `${fmt(feeds.reduce((a, r) => a + r.rr, 0))} rows.`);
  }
  say(`- **Posting** used ${fmt(f.postCpuMs, 1)} ms of the hub's CPU.`);
  const acct = accounts(list).find((a) => a.account === f.hub);
  if (acct) say(`- **The hub's account** in this scenario: ${fmt(acct.objectRequests)} object requests, ${fmt(acct.written)} rows written, ` +
    `${fmt(acct.read)} read, ${fmt(acct.activeLow)}–${fmt(acct.activeHigh)} object-seconds active.`);
}

// --- Groups
const groups = Object.entries(results).filter(([k]) => k.startsWith("group-")).map(([, r]) => r);
if (groups.length) {
  say();
  say(`## Groups`);
  say();
  const rows = groups.sort((a, b) => a.members - b.members).map((g) => {
    const list = within(runs, g).filter((r) => r.site === g.group);
    const worst = list.reduce((a, r) => (r.calls + r.refused > a.calls + a.refused ? r : a), { calls: 0, refused: 0, m: "", path: "" });
    return [`${g.members}`, fmt(list.length), `${worst.calls + worst.refused} (${worst.m} ${shape(worst.path)})`, fmt(list.reduce((a, r) => a + r.refused, 0)),
      g.here ? `${g.here.told} of ${g.members}` : "–", g.closed ? `${g.closed.told} of ${g.closed.members}` : "not closed"];
  });
  say(table(["Members", "Group site runs", "Most calls wanted by one run", "Refused", "Told of an @here post", "Told when closed"], rows));
}

// --- The day
const d = results.day;
if (d) {
  const list = within(runs, d);
  const accts = accounts(list);
  say();
  say(`## A day, squeezed into ${d.minutes} minutes`);
  say();
  say(`${d.active.length} people active (every hub, and a third of the others), each: Home 10 times (evenly spread), a post (1 in 4 with a photo), ` +
    `5 comments on friends' posts, 2 friends' pages. ${d.actions.length} actions.`);
  say();
  const types = [...new Set(d.actions.map((a) => a.type))];
  say(table(["Action", "Done", "Failed", "Median wait", "90% within", "Most calls out"], types.map((t) => {
    const a = d.actions.filter((x) => x.type === t);
    const ok = a.filter((x) => x.status >= 200 && x.status < 400);
    return [t, fmt(ok.length), fmt(a.length - ok.length), `${fmt(median(ok.map((x) => x.ms)))} ms`, `${fmt(quantile(ok.map((x) => x.ms), 0.9))} ms`,
      fmt(most(a.map((x) => x.calls).filter(Number.isFinite), 0))];
  })));
  say();
  say(`Per Cloudflare account (a person's site and the groups they own), for that day, against the free plan:`);
  say();
  const row = (label, a) => [label, `${fmt(a.objectRequests)} (${pct(a.objectRequests, LIMITS.requests)})`, fmt(a.workerRequests),
    `${fmt(a.written)} (${pct(a.written, LIMITS.written)})`, `${fmt(a.read)} (${pct(a.read, LIMITS.read)})`,
    `${fmt(a.activeLow * GB_PER_OBJECT)}–${fmt(a.activeHigh * GB_PER_OBJECT)} (${pct(a.activeHigh * GB_PER_OBJECT, LIMITS.gbs)})`];
  const hubs = accts.filter((a) => a.role === "hub").sort((a, b) => a.account.localeCompare(b.account));
  const others = accts.filter((a) => a.role === "leaf");
  const typical = (key) => median(others.map((a) => a[key]));
  const busiest = others.reduce((a, b) => (b.written > a.written ? b : a), others[0]);
  say(table(["Account", "Object requests", "Worker requests", "Rows written", "Rows read", "GB-s active"], [
    ...hubs.map((a) => row(`${a.account} (${sites.find((s) => s.host === a.account).friends} friends)`, a)),
    ...(others.length ? [row("others: median", { objectRequests: typical("objectRequests"), workerRequests: typical("workerRequests"), written: typical("written"),
      read: typical("read"), activeLow: typical("activeLow"), activeHigh: typical("activeHigh") }), row(`others: busiest (${busiest.account})`, busiest)] : []),
  ]));
  say();
  say(`Limits: ${fmt(LIMITS.requests)} object requests, ${fmt(LIMITS.written)} rows written, ${fmt(LIMITS.read)} read, ${fmt(LIMITS.gbs)} GB-s a day. ` +
    `Friends' photo links last the day, so squeezing it doesn't hide rewrites. Only a third of the others are active, so a hub's friends ask ` +
    `for its posts about a third as often as if all of them used afterwrd that day.`);

  // Unit costs, by kind of run, from the day.
  say();
  say(`### What each kind of run costs (the day's runs)`);
  say();
  const kinds = new Map();
  for (const r of list) {
    const role = sites.find((s) => s.host === r.site)?.role ?? "?";
    const key = `${role === "group" ? "group" : "person"} ${r.obj.startsWith("media") ? "media" : r.obj} ${r.m} ${shape(r.path)}`.trim();
    if (!kinds.has(key)) kinds.set(key, []);
    kinds.get(key).push(r);
  }
  say(table(["Run", "How many", "Rows written (mean)", "Rows read (mean)", "Time (median)", "Most calls"],
    [...kinds].sort((a, b) => b[1].reduce((s, r) => s + r.rw, 0) - a[1].reduce((s, r) => s + r.rw, 0)).slice(0, 25).map(([k, rs]) => [
      `\`${k}\``, fmt(rs.length), fmt(rs.reduce((a, r) => a + r.rw, 0) / rs.length, 1), fmt(rs.reduce((a, r) => a + r.rr, 0) / rs.length, 1),
      `${fmt(median(rs.map((r) => r.ms)))} ms`, fmt(most(rs.map((r) => r.calls)))])));
}

// --- A day in the groups
const gd = results["group-day"];
if (gd) {
  const list = within(runs, gd);
  say();
  say(`## A day in the groups, squeezed into ${gd.minutes} minutes`);
  say();
  say(`Half of each group's members open it 4 times and comment twice, and 1 in 5 of them posts. Each group is taken as ` +
    `installed in an account of its own. The squeeze holds a whole day's actions, so its totals are a day's.`);
  say();
  const rows = gd.groups.map((g) => {
    const mine = list.filter((r) => r.site === g.host);
    const acts = gd.actions.filter((a) => a.group === g.host);
    const failed = acts.filter((a) => !(a.status >= 200 && a.status < 400)).length;
    const opens = mine.filter((r) => r.obj === "site" && r.path.startsWith("/_group/posts") && r.rw === 0);
    const comments = mine.filter((r) => r.obj === "site" && r.path === "/_group/comments");
    const read = mine.reduce((a, r) => a + r.rr, 0);
    const written = mine.reduce((a, r) => a + r.rw, 0);
    return [`${g.members}`, `${fmt(g.active)}`, `${fmt(acts.length)} (${fmt(failed)} failed)`, fmt(median(opens.map((r) => r.rr))),
      fmt(median(comments.map((r) => r.rr))), `${fmt(read)} (${pct(read, LIMITS.read)})`, `${fmt(written)} (${pct(written, LIMITS.written)})`,
      `${fmt(mine.length)} (${pct(mine.length, LIMITS.requests)})`];
  });
  say(table(["Members", "Active", "Actions", "Rows read to open (median)", "Rows read to comment (median)", "Rows read: the day",
    "Rows written: the day", "Object requests: the day"], rows));
  // The heaviest statements in the groups' runs, to see what grows with members.
  const heavy = new Map();
  for (const r of list.filter((x) => gd.groups.some((g) => g.host === x.site))) {
    for (const [n, sql] of r.heavy ?? []) {
      const k = sql.slice(0, 110);
      const v = heavy.get(k) ?? { runs: 0, rows: 0 };
      v.runs++;
      v.rows += n;
      heavy.set(k, v);
    }
  }
  if (heavy.size) {
    say();
    say(table(["Heavy statement (runs reading over 200 rows)", "Runs", "Rows (mean)"],
      [...heavy].sort((a, b) => b[1].rows - a[1].rows).slice(0, 8).map(([k, v]) => [`\`${k.replace(/\|/g, "\\|")}\``, fmt(v.runs), fmt(v.rows / v.runs)])));
  }
}
// --- Refreshing across the hour
const rf = results.refresh;
if (rf) {
  say();
  say(`## Refreshing stored copies (${rf.friends} friends)`);
  say();
  // Each friend's copy is kept in one batch from the Outbox (feed.js askSites): one run of the site object's query. The
  // commonest size of those is what keeping one copy writes; batches of exactly as many rows as friends asked are the
  // daily ration being claimed.
  const rows = rf.rounds.map((r, i) => {
    const until = rf.rounds[i + 1]?.since ?? rf.until;
    const q = runs.filter((x) => x.site === rf.hub && x.obj === "site" && x.m === "query" && x.t0 >= r.since && x.t0 < until);
    const counts = new Map();
    for (const x of q) counts.set(x.rw, (counts.get(x.rw) ?? 0) + 1);
    const [perCopy, saved] = [...counts].filter(([rw]) => rw !== 40).sort((a, b) => b[1] - a[1])[0] ?? [NaN, 0];
    const refused = runs.filter((x) => x.site === rf.hub && x.obj === "outbox" && x.t0 >= r.since && x.t0 < until).reduce((a, x) => a + x.refused, 0);
    return [r.label, fmt(r.refreshed), fmt(saved), fmt(refused), fmt(perCopy), fmt(r.written)];
  });
  say(table(["When", "Friends fetched", "Copies kept", "Calls refused", "Rows to keep one copy", "Rows written in all"], rows));
}

// --- The social model's day
if (day) {
  const squeeze = day.squeeze;
  const real = (seconds) => (seconds >= 3600 ? `${fmt(seconds / 3600, 1)} h` : seconds >= 60 ? `${fmt(seconds / 60)} min` : `${fmt(seconds)} s`);
  // What happened, from drive.mjs's log of every action (results/social-day.jsonl).
  const actions = existsSync(`${OUT}results/social-day.jsonl`)
    ? readFileSync(`${OUT}results/social-day.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  say();
  say(`## A day of the social model, squeezed ${squeeze} times into ${fmt(day.minutes)} minutes`);
  say();
  const fc = net.friendCounts;
  if (fc) say(`${fmt(fc.people)} people: friends median ${fmt(fc.median)}, average ${fmt(fc.average)}, 90% under ${fmt(fc.p90)}, ` +
    `${fmt(fc.over500)} with over 500 and ${fmt(fc.over1000)} over 1,000, the most ${fmt(fc.most)}; ${fmt(fc.friendships)} friendships. ` +
    `${JSON.stringify(day.classes)} (lurker, regular, busy). Times below are as in a real day (the test's times ×${squeeze}).`);
  say();
  const ok = (st) => typeof st === "number" && st >= 200 && st < 400;
  const kinds = [...new Set(actions.map((a) => a.a))];
  say(table(["Action", "Done", "Failed", "Median wait", "90% within"], kinds.map((k) => {
    const list = actions.filter((a) => a.a === k);
    const failed = list.filter((a) => a.st !== undefined && !ok(a.st)).length;
    return [k, fmt(list.length), fmt(failed), `${fmt(median(list.map((a) => a.ms)))} ms`, `${fmt(quantile(list.map((a) => a.ms), 0.9))} ms`];
  })));

  // How fast friends' posts reach Home.
  const homes = actions.filter((a) => a.a === "home" && ok(a.st));
  const arrived = homes.flatMap((a) => a.arrived ?? []);
  const behind = homes.filter((a) => a.missing > 0);
  say();
  say(`**Friends' posts reaching Home:** of ${fmt(arrived.length)} first sightings of a friend's new post, half were within ` +
    `${real(median(arrived))} of it being posted, 90% within ${real(quantile(arrived, 0.9))}, 99% within ${real(quantile(arrived, 0.99))}. ` +
    `${pct(behind.length, homes.length || 1)} of Home visits were missing a friend's post more than 2 minutes old (median ` +
    `${fmt(median(behind.map((a) => a.missing)))} missing, the oldest median ${real(median(behind.map((a) => a.oldest)))}). ` +
    `${fmt(actions.filter((a) => a.a === "unseen").length)} times someone went to comment on a post their Home didn't show yet. ` +
    `(These include waiting for the friend to open Home again, so they scale with the squeeze; the sites' own delays don't.)`);
  const feeds = dayTotals.kinds.get("person site fetch /_peer/feed");
  if (feeds) say(`**"Nothing new":** friends' sites asked for someone's posts ${fmt(feeds.n)} times; ${pct(dayTotals.unchangedFeeds, feeds.n)} were ` +
    `answered "nothing new" (5 rows or fewer), and they read ${fmt(feeds.rr / feeds.n, 1)} rows on average.`);

  // Each account's day against the free plan, by how many friends its owner has.
  const people = sites.filter((s) => !s.group);
  const acct = (host) => dayTotals.accounts.get(host) ?? { requests: 0, worker: 0, read: 0, written: 0, busyMs: 0, refused: 0 };
  const bands = [[0, 100], [100, 200], [200, 500], [500, 1000], [1000, Infinity]];
  say();
  say(`### Each person's account for the day (their site only: groups are counted in accounts of their own), by how many friends they have`);
  say();
  say(table(["Friends", "People", "Rows read: median (most)", "Rows written: median (most)", "Object requests: median (most)", "Over a limit"],
    bands.map(([lo, hi]) => {
      const list = people.filter((s) => (s.friends ?? 0) >= lo && (s.friends ?? 0) < hi).map((s) => acct(s.host));
      const over = list.filter((a) => a.read > LIMITS.read || a.written > LIMITS.written || a.requests > LIMITS.requests).length;
      const cell = (key, limit) => `${pct(median(list.map((a) => a[key])), limit)} (${pct(most(list.map((a) => a[key]), 0), limit)})`;
      return [hi === Infinity ? `${fmt(lo)}+` : `${fmt(lo)}–${fmt(hi - 1)}`, fmt(list.length), cell("read", LIMITS.read), cell("written", LIMITS.written),
        cell("requests", LIMITS.requests), fmt(over)];
    })));
  say();
  say(`The ten with most friends:`);
  say();
  say(table(["Site", "Friends", "Rows read", "Rows written", "Object requests", "Busy (upper bound)", "Calls refused"],
    people.filter((s) => s.role === "hub").sort((a, b) => b.friends - a.friends).map((s) => {
      const a = acct(s.host);
      return [s.host, fmt(s.friends), `${fmt(a.read)} (${pct(a.read, LIMITS.read)})`, `${fmt(a.written)} (${pct(a.written, LIMITS.written)})`,
        `${fmt(a.requests)} (${pct(a.requests, LIMITS.requests)})`, `${fmt((a.busyMs / 1000) * GB_PER_OBJECT)} GB-s`, fmt(a.refused)];
    })));

  // Groups.
  const groups = sites.filter((s) => s.group).sort((a, b) => a.members - b.members);
  if (groups.length) {
    say();
    say(`### Groups through the day`);
    say();
    say(`Each group in an account of its own: its numbers against the free plan's daily limits.`);
    say();
    say(table(["Members", "Owner (friends)", "Opens", "Rows read to open (median)", "Posts", "Comments", "Group's account: rows read", "Rows written", "Object requests"],
      groups.map((g) => {
        const opens = dayTotals.groupOpens.get(g.host) ?? { n: 0, rows: [] };
        const a = acct(g.host);
        const mine = actions.filter((x) => x.group === g.host);
        return [fmt(g.members), `${g.owner} (${fmt(siteByHost.get(g.owner)?.friends)})`, fmt(opens.n), fmt(median(opens.rows)),
          fmt(mine.filter((x) => x.a === "groupPost").length), fmt(mine.filter((x) => x.a === "groupComment").length),
          `${fmt(a.read)} (${pct(a.read, LIMITS.read)})`, `${fmt(a.written)} (${pct(a.written, LIMITS.written)})`,
          `${fmt(a.requests)} (${pct(a.requests, LIMITS.requests)})`];
      })));
  }

  // What went wrong, and what each kind of run cost.
  say();
  say(`### Refused or failed runs through the day`);
  say();
  const problems = [...dayTotals.problems].sort((a, b) => b[1] - a[1]);
  say(problems.length ? table(["Run and status", "How many"], problems.slice(0, 20).map(([k, n]) => [`\`${k}\``, fmt(n)])) : "None.");
  say();
  say(`### What each kind of run cost through the day (${fmt(dayTotals.runs)} runs)`);
  say();
  say(table(["Run", "How many", "Rows written (mean)", "Rows read (mean)", "Time (median of a sample)", "Most calls"],
    [...dayTotals.kinds].sort((a, b) => b[1].rr - a[1].rr).slice(0, 25).map(([k, v]) => [`\`${k}\``, fmt(v.n), fmt(v.rw / v.n, 1),
      fmt(v.rr / v.n, 1), `${fmt(median(v.ms))} ms`, fmt(v.maxCalls)])));
}

// --- The machines: memory and CPU through the run (start.mjs resources.log, one per machine)
const resourceFiles = [`${OUT}resources.log`, ...(existsSync(`${OUT}machines`) ? readdirSync(`${OUT}machines`).map((m) => `${OUT}machines/${m}/resources.log`) : [])]
  .filter((f) => existsSync(f));
if (resourceFiles.length) {
  say();
  say(`## The machines`);
  say();
  const rows = resourceFiles.map((f) => {
    const samples = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const first = samples[0];
    const last = samples.at(-1);
    const rss = samples.flatMap((s) => s.processes.map((p) => p.rssMb ?? 0));
    // CPU used: each process's rise between samples (a process started again, between setting up and the scenarios,
    // starts from nothing).
    let cpu = 0;
    const before = new Map();
    for (const sampleLine of samples) {
      for (const p of sampleLine.processes) {
        if (p.cpuS === undefined) continue;
        const was = before.get(p.i);
        cpu += was === undefined ? 0 : p.cpuS >= was ? p.cpuS - was : p.cpuS;
        before.set(p.i, p.cpuS);
      }
    }
    const hours = (last.t - first.t) / 3_600_000;
    return [first.machine, fmt(samples.length), `${fmt(least(samples.map((s) => s.availableMb)))} MB`, `${fmt(most(samples.map((s) => s.swapMb), 0))} MB`,
      fmt(most(samples.map((s) => s.load), 0), 1), `${fmt(most(rss, 0))} MB`, `${fmt(cpu / 60)} CPU-minutes over ${fmt(hours * 60)} minutes`];
  });
  say(table(["Machine", "Samples", "Least memory free", "Most swap", "Highest load", "Largest process", "workerd CPU"], rows));
}

// --- What's stored, at the end (census.mjs, one file per machine)
const censusFiles = [...(existsSync(OUT) ? readdirSync(OUT).filter((f) => /^census-.*\.json$/.test(f)).map((f) => `${OUT}${f}`) : []),
  ...(existsSync(`${OUT}machines`) ? readdirSync(`${OUT}machines`).flatMap((m) => readdirSync(`${OUT}machines/${m}`).filter((f) => /^census-/.test(f)).map((f) => `${OUT}machines/${m}/${f}`)) : [])];
if (censusFiles.length) {
  const census = Object.assign({}, ...censusFiles.map((f) => JSON.parse(readFileSync(f, "utf8")).sites));
  const list = Object.entries(census);
  const mb = (b) => fmt(b / 1e6, 1);
  const rows = {};
  for (const [, s] of list) for (const [t, n] of Object.entries(s.rows)) rows[t] = (rows[t] ?? 0) + n;
  say();
  say(`## What's stored at the end`);
  say();
  say(`${fmt(list.length)} sites, ${mb(list.reduce((a, [, s]) => a + s.bytes, 0))} MB in all; a site's data: median ${mb(median(list.map(([, s]) => s.bytes)))} MB, ` +
    `the most ${mb(most(list.map(([, s]) => s.bytes), 0))} MB (${list.sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3).map(([h, s]) => `${h} ${mb(s.bytes)} MB`).join(", ")}). ` +
    `Rows in all: ${Object.entries(rows).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${fmt(n)}`).join(", ")}.`);
}

const text = `${out.join("\n")}\n`;
writeFileSync(`${OUT}report.md`, text);
console.log(text);
