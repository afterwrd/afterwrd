// What the container runs (Dockerfile): the afterwrd sites on this server, in workerd (docs/self-hosting-plan.md).
//
// The sites are listed in <data>/sites.json: {"sites": [{"host": "me.example.com"}, {"host": "walkers.example.com",
// "group": true, "key": "<its GROUP_KEY>"}]}. The first time, it's made from AFTERWRD_ADDRESS (your site's address).
// Each site's data is in <data>/sites/<host>/. When sites.json changes (afterwrd.mjs new-group, delete-group),
// workerd is started again with the new list, which takes a few seconds.
//   AFTERWRD_DATA     the data folder (default /data)
//   AFTERWRD_BUILD    the build folder (build.mjs; default /app/build)
//   AFTERWRD_ADDRESS  your site's address, the first time
//   AFTERWRD_LISTEN   where visits come in, from Caddy or a tunnel (default *:8080)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeConfig } from "./config.mjs";

export const DATA = process.env.AFTERWRD_DATA ?? "/data";
export const SITES_FILE = join(DATA, "sites.json");
export const TOOLS = "127.0.0.1:8081";
const BUILD = process.env.AFTERWRD_BUILD ?? "/app/build";
const LISTEN = process.env.AFTERWRD_LISTEN ?? "*:8080";
const WORKERD = process.env.WORKERD ?? "workerd";
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The sites listed in sites.json. */
export function readSites() {
  const { sites } = JSON.parse(readFileSync(SITES_FILE, "utf8"));
  if (!Array.isArray(sites) || !sites.length) throw new Error(`${SITES_FILE} lists no sites.`);
  for (const site of sites) {
    if (!HOST_RE.test(site.host ?? "")) throw new Error(`${SITES_FILE}: "${site.host}" isn't an address like me.example.com.`);
    if (site.group && !/^[\w-]{32,}$/.test(site.key ?? "")) throw new Error(`${SITES_FILE}: the group at ${site.host} has no key.`);
  }
  return sites;
}

/** Saves the list of sites, all at once (serve.mjs notices, and starts workerd again). */
export function saveSites(sites) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(`${SITES_FILE}.new`, `${JSON.stringify({ sites }, null, 2)}\n`);
  renameSync(`${SITES_FILE}.new`, SITES_FILE);
}

/** The sites as config.mjs wants them. */
function forConfig(sites) {
  const ids = new Set();
  return sites.map((site) => {
    let id = site.host.replace(/[^a-z0-9]/g, "");
    while (ids.has(id)) id += "x";
    ids.add(id);
    return { id, host: site.host, data: join(DATA, "sites", site.host), group: Boolean(site.group), vars: site.group ? { GROUP_KEY: site.key } : {} };
  });
}

function start() {
  if (!existsSync(SITES_FILE)) {
    const address = (process.env.AFTERWRD_ADDRESS ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!HOST_RE.test(address)) {
      console.error("Set AFTERWRD_ADDRESS (in compose.yaml) to your site's address, like me.example.com, and start again.");
      process.exit(1);
    }
    saveSites([{ host: address }]);
  }
  let workerd = null;
  let stopping = false;
  let restarting = false;
  let listed = "";
  const run = () => {
    const sites = readSites();
    listed = JSON.stringify(sites);
    const config = writeConfig(BUILD, forConfig(sites), { router: LISTEN, tools: TOOLS });
    console.log(`Starting ${sites.map((s) => `${s.group ? "group " : ""}https://${s.host}`).join(", ")}`);
    workerd = spawn(WORKERD, ["serve", config, "--experimental"], { stdio: "inherit" });
    workerd.on("exit", (code, signal) => {
      workerd = null;
      if (stopping) return;
      const planned = restarting;
      restarting = false;
      if (!planned) console.error(`workerd stopped (${signal ?? code}); starting it again in 5 seconds.`);
      setTimeout(run, planned ? 0 : 5000);
    });
  };
  run();
  // A changed list: workerd again, with the new one (a bad list is said, and the running sites carry on).
  watchFile(SITES_FILE, { interval: 1000 }, () => {
    try {
      if (JSON.stringify(readSites()) === listed) return;
    } catch (error) {
      console.error(error.message);
      return;
    }
    console.log("The list of sites changed.");
    restarting = true;
    workerd?.kill("SIGTERM");
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopping = true;
      unwatchFile(SITES_FILE);
      if (!workerd) process.exit(0);
      workerd.on("exit", () => process.exit(0));
      workerd.kill("SIGTERM");
    });
  }
}

if (process.argv[1]?.endsWith("serve.mjs")) start();
