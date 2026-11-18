// workerd's config for the afterwrd sites on one server (docs/self-hosting-plan.md).
//
// The build folder (build.mjs) holds the release's code bundled as for Cloudflare (index.js and its .sql modules),
// the site files it was bundled with (public/), these selfhost/*.js pieces and meta.json (the release's version and
// compatibility settings). config.capnp is written there.
//
// Each site: { id, host, data, vars, group, local, listen }
//   id      letters and numbers, unique on the server
//   host    its address (my.example.com): visits for it come through the router, and other sites here reach it
//           directly (outbound.js)
//   data    the folder holding its database, photos and outbox
//   vars    settings: HOSTING=self always; GROUP_KEY for a group's site
//   group   a group's site (no owner, no tools)
//   local   tests only: it may call addresses on this computer, where the other test sites are
//   listen  tests only: its own address to listen on (127.0.0.1:8787), instead of coming through the router
// Options: router (where the router listens, e.g. "*:8080"), tools (where tools.js listens: "unix:/tmp/afterwrd/tools.sock").
// Tests only (test/scale): elsewhere, sites run by another workerd on this computer ([{host, address: "127.0.0.1:8082"}]),
// reached through that workerd's router (one workerd can't hold more than about 250 sites: V8 gives all of a
// process's JavaScript 4 GB); testNet, delays and failures outbound.js adds to calls between sites (outbound.js).
//
// For tests: node selfhost/config.mjs <build dir> <sites.json>  (sites.json: a list of sites as above)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const text = (s) => JSON.stringify(String(s)); // capnp's string syntax is JSON's, near enough
const list = (items) => `[\n    ${items.join(",\n    ")}]`;
const worker = (meta, modules, bindings, extra = "") => `(
    compatibilityDate = ${text(meta.compatibilityDate)},
    compatibilityFlags = ${list(meta.compatibilityFlags.map(text))},
    modules = ${list(modules)},
    bindings = ${list(bindings)}${extra})`;
const esm = (name) => `(name = ${text(name)}, esModule = embed ${text(name)})`;

/** Writes <build>/config.capnp for these sites; returns its path. */
export function writeConfig(build, sites, { router = null, tools = null, elsewhere = [], testNet = null } = {}) {
  const meta = JSON.parse(readFileSync(join(build, "meta.json"), "utf8"));
  const sql = readdirSync(build).filter((f) => f.endsWith(".sql")).map((f) => `(name = ${text(f)}, text = embed ${text(f)})`);
  const version = JSON.stringify({ id: `selfhost-${meta.version}`, tag: `v${meta.version}`, timestamp: meta.builtAt });
  const routed = sites.filter((s) => s.host);
  const hostMap = (pick) => JSON.stringify(Object.fromEntries(routed.map((s) => [s.host, pick(s)])));
  const siteBindings = routed.map((s) => `(name = "S_${s.id}", service = "site-${s.id}")`);
  // Another workerd's router, for each address it listens on (tests only).
  const others = [...new Set(elsewhere.map((s) => s.address))];
  const otherName = (address) => `elsewhere-${others.indexOf(address)}`;
  const outboundMap = JSON.stringify({ ...Object.fromEntries(routed.map((s) => [s.host, `S_${s.id}`])),
    ...Object.fromEntries(elsewhere.map((s) => [s.host, `E_${others.indexOf(s.address)}`])) });

  const services = [
    `(name = "files-disk", disk = (path = ${text(join(build, "public"))}, writable = false))`,
    `(name = "files", worker = ${worker(meta, [esm("files.js")], [`(name = "DISK", service = "files-disk")`])})`,
    // Public addresses only. NAT64 and 6to4 addresses count as public, but can lead back to private ones: refused too.
    `(name = "internet", network = (allow = ["public"], deny = ["64:ff9b::/96", "64:ff9b:1::/48", "2002::/16"], tlsOptions = (trustBrowserCas = true)))`,
  ];
  if (sites.some((s) => s.local)) {
    services.push(`(name = "internet-local", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true)))`);
  }
  const sockets = [];
  for (const address of others) services.push(`(name = "${otherName(address)}", external = (address = ${text(address)}, http = ()))`);
  if (routed.length) {
    services.push(`(name = "outbound", worker = ${worker(meta, [esm("outbound.js")], [`(name = "SITES", json = ${text(outboundMap)})`,
      `(name = "INTERNET", service = "internet")`, ...siteBindings,
      ...others.map((address, i) => `(name = "E_${i}", service = "${otherName(address)}")`),
      ...(testNet ? [`(name = "TEST_NET", json = ${text(JSON.stringify(testNet))})`] : [])], `,\n    globalOutbound = "internet"`)})`);
  }
  if (router && routed.length) {
    services.push(`(name = "router", worker = ${worker(meta, [esm("router.js")], [`(name = "SITES", json = ${text(hostMap((s) => `S_${s.id}`))})`,
      ...siteBindings])})`);
    sockets.push(`(name = "http", address = ${text(router)}, http = (), service = "router")`);
  }
  const people = routed.filter((s) => !s.group);
  if (tools && people.length) {
    services.push(`(name = "tools", worker = ${worker(meta, [esm("tools.js"), esm("d1.js")], [
      `(name = "SITES", json = ${text(JSON.stringify(Object.fromEntries(people.map((s) => [s.host, [`D_${s.id}`, `S_${s.id}`]]))))})`,
      ...people.map((s) => `(name = "D_${s.id}", durableObjectNamespace = (className = "Outbox", serviceName = "site-${s.id}"))`),
      ...people.map((s) => `(name = "S_${s.id}", service = "site-${s.id}")`)])})`);
    sockets.push(`(name = "tools", address = ${text(tools)}, http = (), service = "tools")`);
  }

  for (const site of sites) {
    if (!/^[a-z0-9]+$/i.test(site.id)) throw new Error(`A site's id must be letters and numbers: ${site.id}`);
    mkdirSync(site.data, { recursive: true });
    const bindings = [
      `(name = "DATABASE", durableObjectNamespace = "Database")`,
      `(name = "MEDIA", durableObjectNamespace = "MediaStore")`,
      `(name = "OUTBOX", durableObjectNamespace = "Outbox")`,
      `(name = "ASSETS", service = "files")`,
      `(name = "VERSION", json = ${text(version)})`,
      ...Object.entries({ HOSTING: "self", ...site.vars }).map(([name, value]) => `(name = ${text(name)}, text = ${text(value)})`),
    ];
    const outbound = site.local ? "internet-local" : routed.length ? "outbound" : "internet";
    services.push(`(name = "data-${site.id}", disk = (path = ${text(site.data)}, writable = true))`);
    services.push(`(name = "site-${site.id}", worker = ${worker(meta, [esm("entry.js"), esm("index.js"), esm("d1.js"), ...sql], bindings, `,
    durableObjectNamespaces = [
      (className = "Database", uniqueKey = "database", enableSql = true),
      (className = "MediaStore", uniqueKey = "media", enableSql = true),
      (className = "Outbox", uniqueKey = "outbox", enableSql = true)],
    durableObjectStorage = (localDisk = "data-${site.id}"),
    globalOutbound = "${outbound}"`)})`);
    if (site.listen) sockets.push(`(name = "http-${site.id}", address = ${text(site.listen)}, http = (), service = "site-${site.id}")`);
  }

  const path = join(build, "config.capnp");
  writeFileSync(path, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = ${list(services)},
  sockets = ${list(sockets)},
);
`);
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [build, sitesFile] = process.argv.slice(2).map((p) => resolve(p));
  if (!build || !sitesFile) throw new Error("Usage: node selfhost/config.mjs <build dir> <sites.json>");
  console.log(`Wrote ${writeConfig(build, JSON.parse(readFileSync(sitesFile, "utf8")))}.`);
}
