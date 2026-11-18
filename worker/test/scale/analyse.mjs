// The scale test's report (docs/scale-test-plan.md), from what drive.mjs recorded (test/scale/out/results/*.json) and
// every object run's measuring line (out/stats.log, timing.js AFTERWRD_STATS):
//   node test/scale/analyse.mjs        writes test/scale/out/report.md (and prints it)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("out/", import.meta.url));
const net = JSON.parse(readFileSync(`${OUT}net.json`, "utf8"));
const sites = net.processes.flatMap((p) => p.sites);
const results = Object.fromEntries(existsSync(`${OUT}results`)
  ? readdirSync(`${OUT}results`).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(`${OUT}results/${f}`, "utf8"))])
  : []);
const runs = readFileSync(`${OUT}stats.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const within = (r, { since, until }) => runs.filter((x) => x.t0 >= since && x.t0 <= until);

// The free plan, per Cloudflare account per day (docs/site-object-plan.md, read 17 Nov 2026).
const LIMITS = { requests: 100_000, gbs: 13_000, read: 5_000_000, written: 100_000 };
const GB_PER_OBJECT = 0.128; // Cloudflare bills an object's active time at 128 MB

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

/** Everything that counts against one person's Cloudflare account: their site, and the groups they own. */
function accountOf(host) {
  const g = sites.find((s) => s.host === host && s.group);
  return g ? g.owner : host;
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
    role: sites.find((s) => s.host === account)?.role ?? "?",
    // Each run of an object is one Durable Object request; each visit or call coming in is also one Worker request.
    objectRequests: rs.length,
    workerRequests: rs.filter((r) => r.obj === "site" && r.m === "fetch").length,
    read: rs.reduce((a, r) => a + r.rr, 0),
    written: rs.reduce((a, r) => a + r.rw, 0),
    activeLow: activeSeconds(rs),
    activeHigh: activeSeconds(rs, 10_000),
    refused: rs.reduce((a, r) => a + r.refused, 0),
    maxCalls: Math.max(0, ...rs.map((r) => r.calls)),
  }));
}

/** A path with its ids and keys taken out, so like requests group together. */
const shape = (path) => path.replace(/\/post-\d+-[0-9a-f]{8}/g, "/:post").replace(/\/[0-9a-f]{20,}/g, "/:hash").replace(/\/\d+/g, "/:n")
  .replace(/\/_connect\/[\w-]{20,}/, "/_connect/:token").replace(/\/_join\/[\w-]{20,}/, "/_join/:token");

const out = [];
const say = (s = "") => out.push(s);
say(`# Scale test report`);
say();
say(`${sites.length} sites (${sites.filter((s) => s.role === "hub").length} hubs, ${sites.filter((s) => s.role === "leaf").length} others, ` +
  `${sites.filter((s) => s.group).length} groups) in ${net.processes.length} workerd processes. Calls between sites: ` +
  `${net.testNet.minMs}–${net.testNet.maxMs} ms, ${pct(net.testNet.slowRate, 1)} take ${net.testNet.slowMs} ms, ${pct(net.testNet.hangRate, 1)} hang ` +
  `${net.testNet.hangMs / 1000} s, ${pct(net.testNet.failRate, 1)} fail. Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`);
say();
const all = runs.filter((r) => r.refused > 0);
say(`**Calls out:** across ${fmt(runs.length)} object runs, the most any one made was ${Math.max(0, ...runs.map((r) => r.calls))} ` +
  `(the free plan allows 50); ${all.length ? `${all.length} runs had calls refused: ${[...new Set(all.map((r) => `${r.site} ${r.obj} ${r.m} ${shape(r.path)}`))].slice(0, 8).join("; ")}` : "none was refused"}.`);

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
      `${Math.max(0, ...mine.map((r) => r.calls))}); the site wrote ${fmt(list.filter((r) => r.site === h.hub).reduce((a, r) => a + r.rw, 0))} rows ` +
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
  say(`- **The Outbox:** ${alarms.length} alarm runs, at most ${Math.max(0, ...alarms.map((r) => r.calls))} calls in one, ` +
    `${alarms.reduce((a, r) => a + r.refused, 0)} refused; ${fmt(alarms.reduce((a, r) => a + r.rw, 0))} rows written by them.`);
  if (feeds.length) {
    const t0 = Math.min(...feeds.map((r) => r.t0));
    const t1 = Math.max(...feeds.map((r) => r.t0 + r.ms));
    say(`- **The rush back:** friends' sites asked for the hub's newest posts ${feeds.length} times over ${sec(t1 - t0)} ` +
      `(median ${fmt(median(feeds.map((r) => r.ms)))} ms each, slowest ${fmt(Math.max(...feeds.map((r) => r.ms)))} ms), reading ` +
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
  say(`${d.active.length} people active (every hub, and a third of the others), each: Home 10 times, a post (1 in 4 with a photo), ` +
    `5 comments on friends' posts, 2 friends' pages. ${d.actions.length} actions.`);
  say();
  const types = [...new Set(d.actions.map((a) => a.type))];
  say(table(["Action", "Done", "Failed", "Median wait", "90% within", "Most calls out"], types.map((t) => {
    const a = d.actions.filter((x) => x.type === t);
    const ok = a.filter((x) => x.status >= 200 && x.status < 400);
    return [t, fmt(ok.length), fmt(a.length - ok.length), `${fmt(median(ok.map((x) => x.ms)))} ms`, `${fmt(quantile(ok.map((x) => x.ms), 0.9))} ms`,
      fmt(Math.max(0, ...a.map((x) => x.calls).filter(Number.isFinite)))];
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
    `Squeezing a day into ${d.minutes} minutes keeps most refreshes inside one hour, when friends' photo links don't change, so the rows written ` +
    `here are a floor: see "Refreshing stored copies" for the rewrites when the hour turns.`);

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
      `${fmt(median(rs.map((r) => r.ms)))} ms`, fmt(Math.max(...rs.map((r) => r.calls)))])));
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

const text = `${out.join("\n")}\n`;
writeFileSync(`${OUT}report.md`, text);
console.log(text);
