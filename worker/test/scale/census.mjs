// After a scale test, with the sites stopped: how big each site's data is on this machine, and how many rows its
// busiest tables have (out/census-<machine>.json), for working out what grows with what. Run in the image, as root:
//   node /scale/census.mjs [machine]     reads /data/sites/<host>/…, writes /out/census-<machine>.json
// Only counts and sizes: nothing anyone wrote.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TABLES = ["connections", "posts", "media", "comments", "comments_elsewhere", "friend_posts", "inbox", "post_audience",
  "events_elsewhere", "groups", "group_members", "group_posts", "group_comments", "group_photos", "group_inbox", "group_mine"];
const machine = process.argv[2] ?? "127.0.0.1";
const root = "/data/sites";

/** Every file under `dir`, with its size. */
function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else out.push({ path, bytes: statSync(path).size });
  }
  return out;
}

const sites = {};
for (const host of existsSync(root) ? readdirSync(root) : []) {
  const all = files(join(root, host));
  const site = { bytes: all.reduce((a, f) => a + f.bytes, 0), sqliteBytes: 0, rows: {} };
  for (const f of all.filter((x) => x.path.endsWith(".sqlite"))) {
    site.sqliteBytes += f.bytes;
    let db;
    try {
      db = new DatabaseSync(f.path, { readOnly: true });
      const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const t of TABLES.filter((x) => have.has(x))) site.rows[t] = (site.rows[t] ?? 0) + db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    } catch (error) {
      site.errors = [...(site.errors ?? []), `${f.path.slice(root.length)}: ${error.message}`];
    } finally {
      db?.close();
    }
  }
  sites[host] = site;
}
writeFileSync(`/out/census-${machine}.json`, JSON.stringify({ machine, at: Date.now(), sites }));
console.log(`Census: ${Object.keys(sites).length} sites, ${Math.round(Object.values(sites).reduce((a, s) => a + s.bytes, 0) / 1e6)} MB.`);
