// Step 0 of the scale test (docs/scale-test-plan.md): how much memory N afterwrd sites take in one workerd.
// Run inside the self-hosted image:
//   docker run --rm -v "$PWD/test/scale:/scale:ro" --entrypoint node afterwrd-scale /scale/spike.mjs 50
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { writeConfig } from "/app/selfhost/config.mjs";

const n = Number(process.argv[2] ?? 50);
const BUILD = process.env.AFTERWRD_BUILD ?? "/app/build";
const sites = Array.from({ length: n }, (_, i) => {
  const host = `s${String(i + 1).padStart(3, "0")}.scale.test`;
  return { id: host.replace(/[^a-z0-9]/g, ""), host, data: `/data/sites/${host}`, vars: {} };
});
const config = writeConfig(BUILD, sites, { router: "127.0.0.1:8080" });
const started = Date.now();
const workerd = spawn("workerd", ["serve", config, "--experimental"], { stdio: ["ignore", "ignore", "inherit"] });

const rss = () => {
  const status = readFileSync(`/proc/${workerd.pid}/status`, "utf8");
  return Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024;
};
const get = (host, path) => new Promise((done) => {
  const req = request({ host: "127.0.0.1", port: 8080, path, headers: { Host: host }, timeout: 60_000 }, (res) => {
    res.resume();
    res.on("end", () => done(res.statusCode));
  });
  req.on("error", () => done(0));
  req.end();
});

for (let i = 0; (await get(sites[0].host, "/_version")) !== 200; i++) {
  if (i > 6000) throw new Error("workerd didn't start");
  await new Promise((r) => setTimeout(r, 100));
}
const up = Date.now() - started;
const idle = rss();
// Each site's first visit makes its tables (migrations) and loads its code; then the sign-in page.
const t = Date.now();
const statuses = [];
for (let i = 0; i < sites.length; i += 10) {
  statuses.push(...await Promise.all(sites.slice(i, i + 10).map(async (s) => [await get(s.host, "/_version"), await get(s.host, "/")])));
}
const touched = rss();
await new Promise((r) => setTimeout(r, 15_000));
const settled = rss();
const bad = statuses.flat().filter((s) => s !== 200).length;
console.log(JSON.stringify({ sites: n, startMs: up, rssIdleMB: Math.round(idle), rssTouchedMB: Math.round(touched),
  rssAfter15sMB: Math.round(settled), perSiteMB: Math.round((touched - idle) / n * 10) / 10, touchMs: Date.now() - t - 15_000, non200: bad }));
workerd.kill("SIGTERM");
