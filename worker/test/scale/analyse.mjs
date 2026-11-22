// The scale test's report (README.md; docs/signed-conversations.md, step 9b), from what drive.mjs recorded
// (test/scale/out/results/*.json) and every object run's measuring line (out/stats.log, timing.js AFTERWRD_STATS):
//   node test/scale/analyse.mjs        writes test/scale/out/report.md (and prints it)
//   node test/scale/analyse.mjs <dir>  the same for results copied elsewhere (results/, stats.log and net.json in <dir>)
// The day's figures are set against section 8 of docs/signed-conversations.md ("Scale at 1,000"), whose planning
// figures it was run to check.
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

// The free plan, per Cloudflare account per day (read 17 Nov 2026).
const LIMITS = { requests: 100_000, read: 5_000_000, written: 100_000 };
// Section 8's planning figures for a day: requests in, rows read, rows written.
const PLANNED = { big: { requests: 9_800, read: 34_000, written: 16_000 }, group: { requests: 23_500, read: 170_000, written: 8_300 } };

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
const out = [];
const say = (line = "") => out.push(line);
/** A path with its ids and keys taken out, so like requests group together. */
const shape = (path) => String(path).replace(/[A-Za-z0-9_-]{43}/g, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");

const day = results.day;
const big = day?.big ?? sites.find((s) => s.role === "hub")?.host;
const group = day?.group ?? sites.find((s) => s.role === "group")?.host;
const groupOwner = day?.groupOwner ?? sites.find((s) => s.role === "group")?.owner;

// --- Every run in the day, added up by site, and the busiest sites' by kind of request ----------------------------------

const totals = new Map(); // site -> {requests, worker, read, written, refused, slow}
const kinds = new Map(); // "site obj path" for the hub, the group and its owner -> {n, rr, rw, ms[]}
const outboxRuns = new Map(); // site -> run lengths (ms)
if (day && existsSync(`${OUT}stats.log`)) {
  const lines = createInterface({ input: createReadStream(`${OUT}stats.log`), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.t0 < day.since || r.t0 > day.settled) continue;
    let t = totals.get(r.site);
    if (!t) totals.set(r.site, (t = { requests: 0, worker: 0, read: 0, written: 0, refused: 0 }));
    t.requests++;
    if (r.obj === "site" && r.m === "fetch") t.worker++;
    t.read += r.rr ?? 0;
    t.written += r.rw ?? 0;
    t.refused += r.refused ?? 0;
    if (r.obj === "outbox" && r.m === "alarm") (outboxRuns.get(r.site) ?? outboxRuns.set(r.site, []).get(r.site)).push(r.ms);
    if (r.site === big || r.site === group || r.site === groupOwner) {
      const k = `${r.site} ${r.obj} ${r.m === "fetch" ? shape(r.path) : r.m}`;
      let v = kinds.get(k);
      if (!v) kinds.set(k, (v = { n: 0, rr: 0, rw: 0, ms: [] }));
      v.n++;
      v.rr += r.rr ?? 0;
      v.rw += r.rw ?? 0;
      v.ms.push(r.ms);
    }
  }
}
const of = (host) => totals.get(host) ?? { requests: 0, worker: 0, read: 0, written: 0, refused: 0 };
const sum = (...hosts) => hosts.map(of).reduce((a, b) => ({ requests: a.requests + b.requests, worker: a.worker + b.worker, read: a.read + b.read,
  written: a.written + b.written, refused: a.refused + b.refused }));

say("# Scale run: afterwrd 2 at 1,000 (section 8)");
say();
if (!day) say("No day was recorded (results/day.json).");
else {
  const minutes = Math.round((day.until - day.since) / 60_000);
  say(`One day, squeezed ${fmt(day.squeeze)} times into ${fmt(minutes)} minutes (and ${fmt((day.settled - day.until) / 60_000)} more for the ` +
    `sites to settle), on ${fmt(sites.length)} sites. Every figure below is that whole day's, as one real day's.`);
  say();
  say(table(["Action", "Done", "Failed", "Skipped (nothing to act on yet)"], Object.entries(day.counts).map(([k, c]) => [k, fmt(c.ok), fmt(c.failed), fmt(c.skipped)])));
  if (Object.keys(day.failures ?? {}).length) {
    say();
    say(`Why actions failed (the harness injects 1% failed and 2% hanging calls between sites): ${Object.entries(day.failures).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([why, n]) => `${why} (${fmt(n)})`).join("; ")}.`);
  }
  say();
  say("## Each account's day, against section 8");
  say();
  const row = (label, t, planned) => [label, `${fmt(t.requests)} (${pct(t.requests, LIMITS.requests)})`, fmt(t.worker),
    `${fmt(t.read)} (${pct(t.read, LIMITS.read)})`, `${fmt(t.written)} (${pct(t.written, LIMITS.written)})`,
    planned ? `${fmt(planned.requests)} / ${fmt(planned.read)} / ${fmt(planned.written)}` : "", fmt(t.refused)];
  const leafTotals = sites.filter((s) => s.role === "leaf").map((s) => of(s.host));
  const leafRow = (label, f) => [label, fmt(f(leafTotals.map((t) => t.requests))), fmt(f(leafTotals.map((t) => t.worker))), fmt(f(leafTotals.map((t) => t.read))),
    fmt(f(leafTotals.map((t) => t.written))), "", fmt(f(leafTotals.map((t) => t.refused)))];
  say(table(["Account", "Requests (objects)", "of them to the Worker", "Rows read", "Rows written", "Section 8 planned (requests / read / written)", "Calls refused (over 50)"], [
    row(`The person with ${fmt(sites.find((s) => s.host === big)?.friends)} friends`, of(big), PLANNED.big),
    row("The group's site", of(group), PLANNED.group),
    row("Its owner's own site (10 friends)", of(groupOwner)),
    row("The owner's account: both", sum(group, groupOwner)),
    row("If the 1,000-friend person owned the group", sum(big, group)),
    leafRow("Everyone else: median", median), leafRow("…90th percentile", (xs) => quantile(xs, 0.9)), leafRow("…the most", (xs) => most(xs, 0)),
  ]));
  say();
  say("Section 8 counted requests in; here every run of an object counts (requests in, alarms, and calls from the site's own objects), as Cloudflare bills them.");
  for (const [label, host] of [["The 1,000-friend person", big], ["The group's site", group], ["The group's owner", groupOwner]]) {
    const list = [...kinds].filter(([k]) => k.startsWith(`${host} `));
    if (!list.length) continue;
    say();
    say(`### ${label}: where it went`);
    say();
    say(table(["Run", "Runs", "Rows read", "Rows written", "Median time", "Slowest"], list.sort((a, b) => (b[1].rr + 20 * b[1].rw) - (a[1].rr + 20 * a[1].rw)).slice(0, 15)
      .map(([k, v]) => [`\`${k.slice(host.length + 1)}\``, fmt(v.n), fmt(v.rr), fmt(v.rw), `${fmt(median(v.ms))} ms`, `${fmt(most(v.ms, 0))} ms`])));
  }
  const runs = [...outboxRuns.values()].flat();
  if (runs.length) {
    say();
    say(`**Outbox runs** (sending notes, 40 calls a run): ${fmt(runs.length)} in the day; median ${fmt(median(runs))} ms, 99th percentile ` +
      `${fmt(quantile(runs, 0.99))} ms, longest ${fmt(most(runs, 0))} ms (the 1,000-friend person's longest: ${fmt(most(outboxRuns.get(big) ?? [], 0))} ms).`);
  }
}

const o = results.oneoffs;
if (o) {
  say();
  say("## One-offs");
  say();
  const f = o.fanout;
  if (f) say(`- **One post to ${fmt(f.friends)} friends:** ${fmt(f.told)} told; half within ${fmt(f.ms.p50 / 1000, 1)} s, 90% within ${fmt(f.ms.p90 / 1000, 1)} s, ` +
    `the last after ${fmt(f.ms.last / 1000, 1)} s. ${fmt(f.outboxRuns)} Outbox runs, ${fmt(f.outboxCalls)} calls, ${fmt(f.refused)} refused; the longest run ${fmt(f.longestRunMs / 1000, 1)} s.`);
  const h = o.here;
  if (h) say(`- **@here to ${fmt(h.members)} members:** ${fmt(h.told)} told, the last after ${fmt(h.lastMs / 1000, 1)} s; the group's site made ${fmt(h.groupRuns)} runs ` +
    `(${fmt(h.outboxRuns)} of them its Outbox) and wrote ${fmt(h.rowsWritten)} rows.`);
  const p = o.poll;
  if (p) say(`- **A poll every member answers:** ${fmt(p.voted)} of ${fmt(p.voters)} votes taken (${fmt(p.failed)} failed) in ${fmt(p.votingMs / 60_000, 1)} minutes; ` +
    `then ${fmt(p.opens)} opened it: half within ${fmt(p.openMs.p50)} ms, 90% within ${fmt(p.openMs.p90)} ms, ` +
    `${fmt(p.groupRowsReadPerOpen)} rows read on the group's site for each.`);
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
