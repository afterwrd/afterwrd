// Writes test/scale/out/net.json, the scale test's network (README.md), for start.mjs and drive.mjs:
//   node test/scale/net.mjs [--leaves 1000] [--processes 16] [--machines 10.0.0.10,10.0.0.11] [--squeeze 8] [--no-delays]
// Section 8 of docs/signed-conversations.md, as a network: a person with as many friends as there are leaves (the
// first hub, h1000.scale.test for 1,000), a group with that many members (g1000…: the leaves but one, and its owner)
// owned by someone with 10 friends (the second hub, h0010…), so each of section 8's tables is measured on an account
// of its own; and the leaves (s0001…), each friends with the 10 nearest it round a ring. Hubs are Sam Taylor's sites,
// leaves Ann Example's.
// --squeeze: how many times faster than real life the test's day runs; rate limits' short windows, the hourly pulls and
// the background checks' schedule shrink by as much on the test's sites (TEST_SQUEEZE: limits.js rateWindow).
// --machines spreads the processes over several computers (their addresses), in order: the first runs the hubs and
// the group, and drive.mjs. Without it, everything runs on one computer, at 127.0.0.1.
// Calls between sites are as slow and unreliable as measured on Cloudflare (0.5–0.7 s) unless --no-delays.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const leaves = Number(option("leaves", 1000));
const processes = Number(option("processes", 16));
const machines = String(option("machines", "127.0.0.1")).split(",").filter(Boolean);
const squeeze = Number(option("squeeze", 8));
if (machines.length > processes) throw new Error("More machines than processes: give each machine at least one process.");
// Numbers in addresses all the same width (4 digits), so they sort.
const pad = (n) => String(n).padStart(4, "0");
const big = `h${pad(leaves)}.scale.test`;
const small = `h${pad(10)}.scale.test`;
const group = `g${pad(leaves)}.scale.test`;
// A group's key is its setup code too (selfhost/afterwrd.mjs new-group). Made from its address here, so it stays the
// same each time this runs: it's a made-up test network, so the key needn't be secret.
const groupVars = { GROUP_KEY: createHash("sha256").update(`scale-test ${group}`).digest("base64url"), TEST_MAX_MEMBERS: String(leaves) };
const sites = [
  { host: big, role: "hub", friends: leaves },
  { host: small, role: "hub", friends: Math.min(10, leaves) },
  { host: group, role: "group", group: true, members: leaves, owner: small, vars: groupVars },
  ...Array.from({ length: leaves }, (_, i) => ({ host: `s${pad(i + 1)}.scale.test`, role: "leaf" })),
];
for (const s of sites) s.vars = { ...s.vars, TEST_SQUEEZE: String(squeeze) };
// Processes go to machines in order, as evenly as they divide. The hubs and the group go to the first machine, each in
// a process of its own where there are enough (each process runs on one core, and they're the busiest sites); then the
// leaves fill every process to the same size.
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
  // A process with no sites left over (1,003 sites in 64 processes of 16 leave the last empty) isn't started at all.
  processes: lists.map((list, i) => ({ machine: machineOfProcess(i), port: 8081 + i, sites: list })).filter((p) => p.sites.length),
  testNet: args.includes("--no-delays") ? { minMs: 0, maxMs: 0, slowRate: 0, slowMs: 0, hangRate: 0, hangMs: 0, failRate: 0, internet: false }
    : { minMs: 500, maxMs: 700, slowRate: 0.05, slowMs: 1500, hangRate: 0.02, hangMs: 30_000, failRate: 0.01, internet: false },
};
const out = fileURLToPath(new URL("out/", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}net.json`, `${JSON.stringify(net)}\n`);
console.log(`${sites.length} sites in ${processes} processes: ${net.processes.map((p) => p.sites.length).join(", ")}` +
  (machines.length > 1 ? `, on ${machines.length} machines: ${machines.map((m) => `${m} (${net.processes.filter((p) => p.machine === m).length})`).join(", ")}.` : "."));
