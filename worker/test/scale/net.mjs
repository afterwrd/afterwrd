// Writes test/scale/out/net.json, the scale test's network (docs/scale-test-plan.md), for start.mjs and drive.mjs:
//   node test/scale/net.mjs [--leaves 500] [--processes 3] [--hubs 5,150,500] [--groups 40,150] [--no-delays]
// Hubs (Sam Taylor's sites, h005.scale.test …) have that many of the leaves (Ann Example's, s001.scale.test …) as
// friends; each group (g040.scale.test …) gets that many members. Calls between sites are as slow and unreliable as
// measured on Cloudflare (0.5–0.7 s) unless --no-delays.
import { createHash } from "node:crypto";
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
const pad = (n) => String(n).padStart(3, "0");

const sites = [
  ...hubs.map((friends) => ({ host: `h${pad(friends)}.scale.test`, role: "hub", friends: Math.min(friends, leaves) })),
  // A group's key is its setup code too (selfhost/afterwrd.mjs new-group). Made from its address here, so it stays the
  // same each time this runs: it's a made-up test network, so the key needn't be secret.
  ...groups.map((members) => {
    const host = `g${pad(members)}.scale.test`;
    return { host, role: "group", members: Math.min(members, leaves), group: true, owner: `h${pad(Math.max(...hubs))}.scale.test`,
      vars: { GROUP_KEY: createHash("sha256").update(`scale-test ${host}`).digest("base64url"), TEST_MAX_MEMBERS: String(members) } };
  }),
  ...Array.from({ length: leaves }, (_, i) => ({ host: `s${pad(i + 1)}.scale.test`, role: "leaf" })),
];
// Hubs and groups first, in the first process; then the leaves spread evenly.
const per = Math.ceil(sites.length / processes);
const net = {
  processes: Array.from({ length: processes }, (_, i) => ({ port: 8081 + i, sites: sites.slice(i * per, (i + 1) * per) })),
  testNet: args.includes("--no-delays") ? { minMs: 0, maxMs: 0, slowRate: 0, slowMs: 0, hangRate: 0, hangMs: 0, failRate: 0, internet: false }
    : { minMs: 500, maxMs: 700, slowRate: 0.05, slowMs: 1500, hangRate: 0.02, hangMs: 30_000, failRate: 0.01, internet: false },
};
const out = fileURLToPath(new URL("out/", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}net.json`, `${JSON.stringify(net, null, 1)}\n`);
console.log(`${sites.length} sites in ${processes} processes: ${net.processes.map((p) => p.sites.length).join(", ")}.`);
