// Starts the scale test's network inside the self-hosted image (docs/scale-test-plan.md): several workerd processes,
// each running its share of the sites (one workerd can't hold more than about 250), with calls between sites in
// different processes going to the other process's router (selfhost/config.mjs `elsewhere`).
//
//   node /scale/start.mjs          reads /out/net.json (net.mjs writes it), and runs until stopped
//
// Mounts (scale.sh): /build the release built by selfhost/build.mjs, /selfhost the server pieces, /scale this folder,
// /data the sites' data (a Docker volume), /out logs and reports.
// net.json: {processes: [{port, sites: [{host, group?, vars?}]}], testNet}
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { writeConfig } from "/selfhost/config.mjs";

const net = JSON.parse(readFileSync("/out/net.json", "utf8"));
mkdirSync("/out", { recursive: true });
mkdirSync("/tmp/afterwrd", { recursive: true, mode: 0o700 });
const stats = createWriteStream("/out/stats.log", { flags: "a" });
const id = (host) => host.replace(/[^a-z0-9]/g, "");

const children = net.processes.map((proc, i) => {
  const sites = proc.sites.map((s) => ({ id: id(s.host), host: s.host, data: `/data/sites/${s.host}`, group: Boolean(s.group),
    vars: { TEST_SCALE: s.host, ...s.vars } }));
  const elsewhere = net.processes.flatMap((other, j) => j === i ? [] : other.sites.map((s) => ({ host: s.host, address: `127.0.0.1:${other.port}` })));
  const path = writeConfig("/build", sites, { router: `127.0.0.1:${proc.port}`, tools: `unix:/tmp/afterwrd/tools-${i}.sock`, elsewhere,
    testNet: net.testNet });
  // Each process its own config file, beside the code it names.
  const mine = `/build/config-${i}.capnp`;
  copyFileSync(path, mine);
  const log = createWriteStream(`/out/workerd-${i}.log`, { flags: "a" });
  const child = spawn("workerd", ["serve", mine, "--experimental", `--inspector-addr=127.0.0.1:${9230 + i}`], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const at = line.indexOf("AFTERWRD_STATS ");
      if (at >= 0) stats.write(`${line.slice(at + 15)}\n`);
      else if (!line.includes("compatibility flag")) log.write(`${line}\n`);
    });
  }
  child.on("exit", (code, signal) => {
    console.error(`workerd ${i} stopped (${signal ?? code})`);
    process.exit(1);
  });
  console.log(`workerd ${i}: ${sites.length} sites on 127.0.0.1:${proc.port}, pid ${child.pid}`);
  return child;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const child of children) child.removeAllListeners("exit").kill("SIGTERM");
    stats.end(() => process.exit(0));
  });
}
