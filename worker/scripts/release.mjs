// Packages a afterwrd release for the installer:
//
//   npm run release -- --base https://github.com/<owner>/afterwrd/releases/download/v<version>
//
// writes release/<version>/, a flat folder so every file can be a GitHub release asset:
//   manifest.json    the code modules and site files, each with its SHA-256, plus the Worker settings
//   <sha256>         every file, named by its hash
// and release/site/, the install page (with the Connect page Cloudflare's sign-in comes back to, and How it works).
// Publish every file in the folder at --base unchanged; installing and updating refuse anything that doesn't match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build as bundle } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTICES_PATH, notices, runtimePackages } from "./notices.mjs";
import { assetHashes } from "./asset-hashes.mjs";

const worker = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1];
if (!args.includes("--base") || !/^https:\/\/\S+[^/]$/.test(base ?? "")) {
  console.error("Give the https address the release folder will be published at, without a trailing slash: --base https://…");
  process.exit(1);
}

const { version, afterwrd: project } = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
// wrangler.jsonc with its comments removed; no value in it contains "//".
const config = JSON.parse(readFileSync(join(worker, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const out = join(worker, "release", version);
const dist = join(worker, "release", ".build");
rmSync(out, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const build = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", dist], { cwd: worker, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(1);
}

// Every copy must carry the licences of the code inside it (see scripts/notices.mjs): stop if licenses.txt is
// stale, or if the built Worker contains a package it doesn't list.
if (readFileSync(NOTICES_PATH, "utf8") !== notices()) {
  console.error("public/static/licenses.txt is out of date: run npm run notices, check the result and commit it.");
  process.exit(1);
}
const covered = new Set(runtimePackages().map((p) => p.dir));
const PACKAGE_DIR = /^(node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*)\//;
const bundledPackages = new Set(JSON.parse(readFileSync(join(dist, "index.js.map"), "utf8")).sources
  .map((source) => PACKAGE_DIR.exec(relative(worker, resolve(dist, source)).split(sep).join("/"))?.[1])
  .filter(Boolean));
const uncovered = [...bundledPackages].filter((dir) => !covered.has(dir));
if (!bundledPackages.has("node_modules/@simplewebauthn/server")) {
  console.error("Couldn't read which packages the Worker contains from its source map, so can't check licenses.txt.");
  process.exit(1);
}
if (uncovered.length) {
  console.error(`The Worker contains packages licenses.txt doesn't cover: ${uncovered.join(", ")}`);
  process.exit(1);
}

// One code module, not one per migration. Installing or updating a site downloads every module separately, and on
// Cloudflare's free plan a request may make only 50 calls, each of GitHub's redirects counting as one: 0.49.0 had
// 21 modules (index.js and 20 migrations), which took the installer's deploy step over the limit. So the .sql files
// wrangler leaves beside index.js are built into it here, as the same text the Worker imported them as.
const single = await bundle({
  entryPoints: [join(dist, "index.js")], bundle: true, format: "esm", target: "es2022", platform: "neutral", write: false,
  charset: "utf8", loader: { ".sql": "text" }, external: ["cloudflare:*", "node:*"],
});
writeFileSync(join(dist, "index.js"), single.outputFiles[0].contents);
for (const name of readdirSync(dist).filter((n) => n.endsWith(".sql"))) rmSync(join(dist, name));

const TYPES = {
  ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".woff2": "font/woff2", ".txt": "text/plain",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function add(bytes) {
  const hash = sha256(bytes);
  writeFileSync(join(out, hash), bytes);
  return { sha256: hash, size: bytes.length };
}

const modules = readdirSync(dist)
  .filter((name) => name.endsWith(".js") || name.endsWith(".sql"))
  .map((name) => ({
    name,
    type: name.endsWith(".js") ? "application/javascript+module" : "text/plain",
    ...add(readFileSync(join(dist, name))),
  }));
if (modules.length !== 1) {
  console.error(`The Worker should be one code module, but the build made ${modules.length}: ${modules.map((m) => m.name).join(", ")}`);
  process.exit(1);
}

const publicDir = join(worker, config.assets.directory);
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const assets = walk(publicDir).map((file) => {
  const bytes = readFileSync(file);
  return {
    path: `/${relative(publicDir, file).split("\\").join("/")}`,
    type: TYPES[extname(file)] ?? "text/plain",
    // The upload session's own identifier for the file (32 hex characters), as in Cloudflare's examples.
    hash: sha256(bytes.toString("base64") + extname(file).slice(1)).slice(0, 32),
    ...add(bytes),
  };
});

// What's new, for the Update page: the tagged commit's message, without its sign-off lines.
const git = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: worker, encoding: "utf8" });
// Commit messages wrap at 72 characters; the page wraps for itself, so lines within a paragraph are joined.
const notes = git.status === 0
  ? git.stdout.replace(/^Co-Authored-By:.*$/gim, "").trim().split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, " ")).join("\n\n").slice(0, 3000)
  : "";

// The newest release that fixed a security problem: set afterwrd.securityFix in package.json to the version being
// released when it fixes one, and leave it as it is otherwise, so sites that skip a release still hear about it.
// Sites older than it show their owner a notice on Home (update.js securityFixWaiting).
const securityFix = project.securityFix;
if (securityFix !== undefined && !(/^\d+\.\d+\.\d+$/.test(securityFix) && !newerThan(securityFix, version))) {
  throw new Error(`afterwrd.securityFix in package.json (${securityFix}) must be a version no newer than ${version}.`);
}

// The code checks every static file against the hashes built into it (src/static.js): they must be exactly the
// files being published, or every site would refuse them.
const built = readFileSync(join(worker, "generated", "asset-hashes.json"), "utf8");
if (built !== assetHashes() || built !== `${JSON.stringify(Object.fromEntries(assets.map((a) => [a.path, a.sha256])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2)}\n`) {
  console.error("The static file hashes built into the code don't match public/. Build again.");
  process.exit(1);
}

// A new kind of store (Durable Object class) can't be installed carefully: Cloudflare only takes one in a deploy that
// goes live at once, without the staging, health check and switching back every other update gets, and it may not
// allow going back past it. So new storage goes into the existing stores as tables (the vault in an Outbox object, for
// one). If a new class is ever truly needed, release it first with nothing using it, with --new-store, and start using
// it in the release after (docs/security-and-install-plan.md, section 6).
const STORES = ["MediaStore", "Outbox"];
const newStores = config.migrations.flatMap((m) => m.new_sqlite_classes ?? []).filter((name) => !STORES.includes(name));
if (newStores.length && !args.includes("--new-store")) {
  console.error(`This release adds a new kind of store (${newStores.join(", ")}), which every site would have to install by hand,`
    + " with no check or way back. Put the storage in an existing store instead, or see the note in scripts/release.mjs.");
  process.exit(1);
}

const manifest = {
  name: "afterwrd",
  version,
  notes,
  ...(securityFix ? { security_fix: securityFix } : {}),
  main_module: config.main.split("/").pop(),
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags ?? [],
  modules,
  assets,
  assets_config: {
    html_handling: config.assets.html_handling,
    not_found_handling: config.assets.not_found_handling,
    run_worker_first: config.assets.run_worker_first,
  },
  durable_objects: config.durable_objects.bindings,
  migrations: { new_tag: config.migrations.at(-1).tag, new_sqlite_classes: config.migrations.flatMap((m) => m.new_sqlite_classes ?? []) },
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(join(out, "manifest.json"), manifestBytes);

// The install page (published to GitHub Pages by the release workflow).
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(base)?.[1];
const site = join(worker, "release", "site");
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
writeFileSync(join(site, "index.html"), readFileSync(join(worker, "installer", "page.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__MANIFEST_SHORT__", sha256(manifestBytes).slice(0, 12))
  .replaceAll("__RELEASE_PAGE__", repo ? `https://github.com/${repo}/releases/tag/v${version}` : base)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// The Connect page, at /connect/: the address Cloudflare's sign-in sends people back to (src/cloudflare.js).
mkdirSync(join(site, "connect"), { recursive: true });
writeFileSync(join(site, "connect", "index.html"), readFileSync(join(worker, "installer", "connect.html"), "utf8")
  .replaceAll("__OAUTH_CLIENTS__", [project.cloudflareClient, ...(project.cloudflareClientsBefore ?? [])].join(" "))
  .replaceAll("__OAUTH_CLIENT_UNSAID__", (project.cloudflareClientsBefore ?? [])[0] ?? project.cloudflareClient));
// "How it works", beside it at /how-it-works/.
mkdirSync(join(site, "how-it-works"), { recursive: true });
writeFileSync(join(site, "how-it-works", "index.html"), readFileSync(join(worker, "installer", "how-it-works.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__RELEASE_PAGE__", repo ? `https://github.com/${repo}/releases/tag/v${version}` : base)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// "How afterwrd is different from Facebook", at /compared/.
mkdirSync(join(site, "compared"), { recursive: true });
writeFileSync(join(site, "compared", "index.html"), readFileSync(join(worker, "installer", "compared.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// "Check your install", at /check/.
mkdirSync(join(site, "check"), { recursive: true });
writeFileSync(join(site, "check", "index.html"), readFileSync(join(worker, "installer", "check.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__REPO_PAGE__", repo ? `https://github.com/${repo}` : base));
// GitHub Pages keeps a custom domain in a CNAME file beside the page; the release replaces the whole branch, so
// it's written here every time or the domain would be dropped.
if (project?.site) writeFileSync(join(site, "CNAME"), `${project.site}\n`);
rmSync(dist, { recursive: true, force: true });

const total = [...modules, ...assets].reduce((n, f) => n + f.size, 0);
console.log(`afterwrd ${version}: ${modules.length} code modules and ${assets.length} site files (${(total / 1e3).toFixed(0)} KB)`);
console.log(`  ${relative(worker, out)}/  → publish at ${base}/`);
console.log(`  manifest ${sha256(manifestBytes).slice(0, 12)}…`);

function newerThan(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
