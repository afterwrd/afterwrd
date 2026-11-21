// What the database keeps for itself (migrations/0024_group_counts.js), on the real migrations in an in-memory SQLite
// database, run as src/migrate.js runs them:
//   node --no-warnings test/triggers.mjs
// - a group's post count and each post's comment count follow posts and comments as they come and go;
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

// Groups: counts kept by the database.
db.exec(`INSERT INTO groups (id, name, created_at) VALUES (1, 'Walkers', 1)`);
const add = (n) => { for (let i = 0; i < n; i++) db.exec(`INSERT INTO group_posts (group_id, origin, author_name, created_at) VALUES (1, 'https://m.example', 'M', ${i})`); };
add(3);
const gp = db.prepare("SELECT id FROM group_posts ORDER BY id LIMIT 1").get().id;
for (let i = 0; i < 4; i++) db.exec(`INSERT INTO group_comments (post_id, origin, author_name, text, created_at) VALUES (${gp}, 'https://m.example', 'M', 'c', ${i})`);
db.exec(`DELETE FROM group_comments WHERE id = (SELECT MIN(id) FROM group_comments)`);
const counts = () => [db.prepare("SELECT post_count AS n FROM groups WHERE id = 1").get().n, db.prepare(`SELECT comment_count AS n FROM group_posts WHERE id = ${gp}`).get().n];
check("a group's post count follows its posts", counts()[0] === 3, String(counts()[0]));
check("a post's comment count follows its comments", counts()[1] === 3, String(counts()[1]));
db.exec(`DELETE FROM group_posts WHERE id != ${gp}`);
check("…and deleting posts", counts()[0] === 1, String(counts()[0]));

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
