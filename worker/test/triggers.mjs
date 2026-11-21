// What the database keeps for itself (migrations/0024_group_counts.js), on the real migrations in an in-memory SQLite
// database, run as src/migrate.js runs them:
//   node --no-warnings test/triggers.mjs
// - groups kept without keys, and nothing left counting old groups' posts (step 6e);
// - the old feed's bookkeeping (0025_feed_changed.js) is gone again (0034_signed_friends.sql).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const worker = fileURLToPath(new URL("..", import.meta.url));
const db = new DatabaseSync(":memory:");
const statements = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const prepared = (sql, params = []) => ({ sql, params, bind: (...values) => prepared(sql, values),
  all: async () => ({ results: db.prepare(sql).all(...params) }), first: async () => db.prepare(sql).get(...params) ?? null,
  run: async () => db.prepare(sql).run(...params) });
for (const file of readdirSync(`${worker}migrations`).sort()) {
  if (file.endsWith(".sql")) for (const s of statements(readFileSync(`${worker}migrations/${file}`, "utf8"))) db.exec(s);
  else if (file.endsWith(".js")) {
    const { default: migration } = await import(pathToFileURL(`${worker}migrations/${file}`).href);
    for (const s of await migration({ prepare: (sql) => prepared(sql) })) db.prepare(s.sql).run(...s.params);
  }
}

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
// The old feed's bookkeeping (migrations/0025_feed_changed.js) went with the old feed (0034_signed_friends.sql): no
// trigger left to write rows nothing reads.
check("the old feed's triggers and table are gone", db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'feed%'").get().n === 0
  && !db.prepare("SELECT sql FROM sqlite_master WHERE name = 'posts'").get().sql.includes("changed_at"));
check("…and friends are kept without passwords", !/their_key|key_hash/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'connections'").get().sql));

// Groups (step 6e): signed only, so kept without keys; old groups' posts are read-only, with nothing left counting them.
check("groups and their members are kept without keys", !/their_key|key_hash/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'groups'").get().sql)
  && !/their_key|key_hash/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'group_members'").get().sql));
check("…and no triggers count old groups' posts", db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'group%'").get().n === 0);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
