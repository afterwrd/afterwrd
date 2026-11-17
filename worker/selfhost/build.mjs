// Makes the build folder a self-hosted server runs (config.mjs, serve.mjs):
//   node selfhost/build.mjs <build dir>
// The code is bundled exactly as for Cloudflare (wrangler's own bundling, with nothing uploaded), and the site files
// are copied straight after, so each matches the hash the bundle carries (src/static.js refuses one that doesn't).
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const build = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node selfhost/build.mjs <build dir>");
const worker = fileURLToPath(new URL("..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

rmSync(build, { recursive: true, force: true });
execFileSync(join(worker, "node_modules", ".bin", "wrangler"), ["deploy", "--dry-run", "--outdir", build],
  { cwd: worker, stdio: ["ignore", "ignore", "inherit"] });
rmSync(join(build, "index.js.map"), { force: true });
rmSync(join(build, "README.md"), { force: true });
cpSync(join(worker, "public"), join(build, "public"), { recursive: true });
for (const file of ["entry.js", "d1.js", "files.js", "router.js", "outbound.js", "tools.js"]) cpSync(join(here, file), join(build, file));

const wrangler = JSON.parse(readFileSync(join(worker, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const pkg = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
writeFileSync(join(build, "meta.json"), JSON.stringify({
  version: pkg.version,
  builtAt: new Date().toISOString(),
  compatibilityDate: wrangler.compatibility_date,
  compatibilityFlags: wrangler.compatibility_flags,
}, null, 2));
console.log(`Built afterwrd ${pkg.version} in ${build}.`);
