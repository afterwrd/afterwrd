// Starts the scale test's network inside the self-hosted image (docs/scale-test-plan.md): several workerd processes,
// each running its share of the sites (one workerd can't hold more than about 250), with calls between sites in
// different processes going to the other process's router (selfhost/config.mjs `elsewhere`).
//
//   node /scale/start.mjs          reads /out/net.json (net.mjs writes it), and runs until stopped
//
// On several machines (net.mjs --machines), each runs this with SCALE_MACHINE set to its own address, and starts only
// its own processes. Routers and tools listen on that address, so the other machines (and drive.mjs) can reach them:
// keep it a private network. The other machines send their measuring lines to the first one's stats.log
// (STATS_PORT), as drive.mjs and analyse.mjs read them there; each also keeps its own.
//
// Mounts (scale.sh): /build the release built by selfhost/build.mjs, /selfhost the server pieces, /scale this folder,
// /data the sites' data (a Docker volume), /out logs and reports.
// net.json: {processes: [{machine, port, sites: [{host, group?, vars?}]}], testNet}
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { writeConfig } from "/selfhost/config.mjs";
import { machineOf, STATS_PORT, toolsAddress } from "/scale/lib.mjs";

const net = JSON.parse(readFileSync("/out/net.json", "utf8"));
const machines = [...new Set(net.processes.map(machineOf))];
const me = process.env.SCALE_MACHINE ?? "127.0.0.1";
if (!machines.includes(me)) throw new Error(`This machine (${me}) isn't one of the network's: ${machines.join(", ")}.`);
const first = machines[0];
mkdirSync("/out", { recursive: true });
const stats = createWriteStream("/out/stats.log", { flags: "a" });
const id = (host) => host.replace(/[^a-z0-9]/g, "");

// Measuring lines from the other machines (on the first machine), or to the first machine (on the others).
let send = null;
if (machines.length > 1 && me === first) {
  let skipped = 0;
  createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      // A line cut short by a dropped connection isn't JSON: left out, so the log stays readable.
      try {
        JSON.parse(line);
        stats.write(`${line}\n`);
      } catch {
        console.error(`Measuring line left out (${++skipped}): ${line.slice(0, 80)}`);
      }
    });
    socket.on("error", () => {});
  }).listen(STATS_PORT, me, () => console.log(`Measuring lines from the other machines on ${me}:${STATS_PORT}`));
} else if (machines.length > 1) {
  const queue = [];
  let socket = null;
  let ready = false;
  const flush = () => {
    while (ready && queue.length) socket.write(queue.shift());
  };
  const open = () => {
    socket = connect(STATS_PORT, first, () => {
      ready = true;
      console.log(`Sending measuring lines to ${first}:${STATS_PORT}`);
      flush();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (ready) console.error(`Lost the connection to ${first}:${STATS_PORT}: trying again`);
      ready = false;
      setTimeout(open, 1000);
    });
  };
  open();
  send = (line) => {
    queue.push(`${line}\n`);
    flush();
  };
}

const children = net.processes.map((proc, i) => {
  if (machineOf(proc) !== me) return null;
  const sites = proc.sites.map((s) => ({ id: id(s.host), host: s.host, data: `/data/sites/${s.host}`, group: Boolean(s.group),
    vars: { TEST_SCALE: s.host, ...s.vars } }));
  const elsewhere = net.processes.flatMap((other, j) => j === i ? [] : other.sites.map((s) => ({ host: s.host, address: `${machineOf(other)}:${other.port}` })));
  const path = writeConfig("/build", sites, { router: `${me}:${proc.port}`, tools: toolsAddress(proc, i), elsewhere, testNet: net.testNet });
  // Each process its own config file, beside the code it names.
  const mine = `/build/config-${i}.capnp`;
  copyFileSync(path, mine);
  const log = createWriteStream(`/out/workerd-${i}.log`, { flags: "a" });
  const child = spawn("workerd", ["serve", mine, "--experimental", `--inspector-addr=127.0.0.1:${9230 + i}`], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const at = line.indexOf("AFTERWRD_STATS ");
      if (at >= 0) {
        const stat = line.slice(at + 15);
        stats.write(`${stat}\n`);
        send?.(stat);
      } else if (!line.includes("compatibility flag")) log.write(`${line}\n`);
    });
  }
  child.on("exit", (code, signal) => {
    console.error(`workerd ${i} stopped (${signal ?? code})`);
    process.exit(1);
  });
  console.log(`workerd ${i}: ${sites.length} sites on ${me}:${proc.port}, pid ${child.pid}`);
  return { child, i };
}).filter(Boolean).map(({ child, i }) => Object.assign(child, { procIndex: i }));

// How this machine and each of its processes are doing, every 30 seconds (out/resources.log): memory in use, CPU time
// so far (user and system, in seconds: the difference between two lines is what it used meanwhile), and the load.
const RESOURCES = createWriteStream("/out/resources.log", { flags: "a" });
const processNow = (pid) => {
  try {
    const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return { rssMb: Math.round(rss / 1024), cpuS: (Number(fields[11]) + Number(fields[12])) / 100 };
  } catch {
    return { gone: true };
  }
};
setInterval(() => {
  try {
    const memory = readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(memory)?.[1] ?? 0);
    RESOURCES.write(`${JSON.stringify({ t: Date.now(), machine: me, load: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
      availableMb: Math.round(kb("MemAvailable") / 1024), swapMb: Math.round((kb("SwapTotal") - kb("SwapFree")) / 1024),
      processes: children.map((c) => ({ i: c.procIndex, ...processNow(c.pid) })) })}\n`);
  } catch (error) {
    console.error("Resources:", error.message);
  }
}, 30_000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const child of children) child.removeAllListeners("exit").kill("SIGTERM");
    stats.end(() => process.exit(0));
  });
}
