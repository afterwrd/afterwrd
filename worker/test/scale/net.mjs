// Writes test/scale/out/net.json, the scale test's network (docs/scale-test-plan.md), for start.mjs and drive.mjs:
//   node test/scale/net.mjs [--leaves 500] [--processes 3] [--hubs 5,150,500] [--groups 40,150] [--no-delays]
//                           [--machines 10.0.0.10,10.0.0.11] [--squeeze 16]
//   node test/scale/net.mjs --model social --people 3000 [--seed 1] [--median 200] [--outliers 10]
//                           [--groups 50,150,300,600,1000,2000] [--processes 24] [--machines …] [--squeeze 8]
// --model social: a network shaped like Facebook's (social.mjs): friend counts with a median of about 200 and a few
// people with thousands, friendships mostly within overlapping circles, and groups grown out of circles. Its
// friendships are listed in net.json (edges), for drive.mjs to make. People are p0001.scale.test …; the outliers (the
// few with the most friends) are role "hub", with the groups in the first process.
// --squeeze: how many times faster than real life the test's day runs; rate limits' short windows shrink by as much on
// the test's sites (TEST_SQUEEZE: limits.js rateWindow).
// --machines spreads the processes over several computers (their private addresses), in order: the first runs the
// hubs and groups, and drive.mjs (it measures their CPU through the inspector, which only listens locally). Without it,
// everything runs on one computer, at 127.0.0.1.
// Hubs (Sam Taylor's sites, h005.scale.test …) have that many of the leaves (Ann Example's, s001.scale.test …) as
// friends; each group (g040.scale.test …) gets that many members. Calls between sites are as slow and unreliable as
// measured on Cloudflare (0.5–0.7 s) unless --no-delays.
import { createHash } from "node:crypto";
import { describe, socialNetwork } from "./social.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const leaves = Number(option("leaves", 500));
const processes = Number(option("processes", 3));
const hubs = String(option("hubs", "5,150,500")).split(",").filter(Boolean).map(Number);
const groups = String(option("groups", "40,150")).split(",").filter(Boolean).map(Number);
const machines = String(option("machines", "127.0.0.1")).split(",").filter(Boolean);
const squeeze = Number(option("squeeze", 16));
const social = option("model", "hubs") === "social";
if (machines.length > processes) throw new Error("More machines than processes: give each machine at least one process.");
// A group's key is its setup code too (selfhost/afterwrd.mjs new-group). Made from its address here, so it stays the
// same each time this runs: it's a made-up test network, so the key needn't be secret.
const groupVars = (host, members) => ({ GROUP_KEY: createHash("sha256").update(`scale-test ${host}`).digest("base64url"),
  TEST_MAX_MEMBERS: String(members) });
let sites;
let extra = {};
if (social) {
  const people = Number(option("people", 3000));
  const made = socialNetwork({ people, seed: Number(option("seed", 1)), median: Number(option("median", 200)),
    outliers: Number(option("outliers", 10)), groups: String(option("groups", "50,150,300,600,1000,2000")).split(",").filter(Boolean).map(Number) });
  const width = Math.max(4, String(people).length);
  const host = (i) => `p${String(i + 1).padStart(width, "0")}.scale.test`;
  const groupHost = (size) => `g${String(size).padStart(width, "0")}.scale.test`;
  const person = (i) => ({ host: host(i), role: made.hubs.has(i) ? "hub" : "leaf", friends: made.degree[i] });
  sites = [
    // The outliers and the groups first (the first process, on the first machine: drive.mjs measures their CPU).
    ...[...made.hubs].map(person),
    ...made.groups.map((g) => ({ host: groupHost(g.size), role: "group", group: true, members: g.members.length + 1, owner: host(g.owner),
      memberHosts: g.members.map(host), vars: groupVars(groupHost(g.size), g.size) })),
    ...Array.from({ length: people }, (_, i) => i).filter((i) => !made.hubs.has(i)).map(person),
  ];
  extra = { model: "social", people: Array.from({ length: people }, (_, i) => host(i)), edges: made.pairs.flat(),
    circles: made.circles, friendCounts: describe(made.degree) };
  console.log(`Friends: ${JSON.stringify(extra.friendCounts)}`);
} else {
  // Numbers in addresses all the same width (3 digits, or 4 from 1,000 sites), so they sort.
  const width = Math.max(3, String(Math.max(leaves, ...hubs, ...groups)).length);
  const pad = (n) => String(n).padStart(width, "0");
  sites = [
    ...hubs.map((friends) => ({ host: `h${pad(friends)}.scale.test`, role: "hub", friends: Math.min(friends, leaves) })),
    ...groups.map((members) => {
      const host = `g${pad(members)}.scale.test`;
      return { host, role: "group", members: Math.min(members, leaves), group: true, owner: `h${pad(Math.max(...hubs))}.scale.test`,
        vars: groupVars(host, members) };
    }),
    ...Array.from({ length: leaves }, (_, i) => ({ host: `s${pad(i + 1)}.scale.test`, role: "leaf" })),
  ];
}
for (const s of sites) s.vars = { ...s.vars, TEST_SQUEEZE: String(squeeze) };
// Processes go to machines in order, as evenly as they divide. The hubs and groups go to the first machine (drive.mjs
// measures their CPU there), shared round its processes (each process runs on one core, and they're the busiest
// sites); then the leaves fill every process to the same size.
const machineOfProcess = (i) => machines[Math.floor((i * machines.length) / processes)];
const per = Math.ceil(sites.length / processes);
const lists = Array.from({ length: processes }, () => []);
const firsts = lists.map((_, i) => i).filter((i) => machineOfProcess(i) === machines[0]);
sites.filter((s) => s.role !== "leaf").forEach((s, n) => lists[firsts[n % firsts.length]].push(s));
let fill = 0;
for (const s of sites.filter((x) => x.role === "leaf")) {
  while (lists[fill].length >= per) fill++;
  lists[fill].push(s);
}
const net = {
  squeeze,
  processes: lists.map((list, i) => ({ machine: machineOfProcess(i), port: 8081 + i, sites: list })),
  testNet: args.includes("--no-delays") ? { minMs: 0, maxMs: 0, slowRate: 0, slowMs: 0, hangRate: 0, hangMs: 0, failRate: 0, internet: false }
    : { minMs: 500, maxMs: 700, slowRate: 0.05, slowMs: 1500, hangRate: 0.02, hangMs: 30_000, failRate: 0.01, internet: false },
  ...extra,
};
const out = fileURLToPath(new URL("out/", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}net.json`, `${JSON.stringify(net)}\n`);
console.log(`${sites.length} sites in ${processes} processes: ${net.processes.map((p) => p.sites.length).join(", ")}` +
  (machines.length > 1 ? `, on ${machines.length} machines: ${machines.map((m) => `${m} (${net.processes.filter((p) => p.machine === m).length})`).join(", ")}.` : "."));
