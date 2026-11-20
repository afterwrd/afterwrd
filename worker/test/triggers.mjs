// What the database keeps for itself (migrations/0024_group_counts.js, 0025_feed_changed.js), on the real migrations
// in an in-memory SQLite database, run as src/migrate.js runs them:
//   node --no-warnings test/triggers.mjs
// - what a friend's feed shows (peers.js feed) is marked changed as it changes: each post's changed_at with anything
//   it's sent with, feed_changed.at with any of it, and feed_changed.whole_at with what every post is sent with; never
//   with a refresh's bookkeeping, the owner's other bookkeeping, settings the feed doesn't show, or Facebook's posts;
//   and each only once a second.
// - a group's post count and each post's comment count follow posts and comments as they come and go.
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
const feedRow = () => db.prepare("SELECT at, whole_at FROM feed_changed WHERE id = 1").get();
const postRow = (key) => db.prepare("SELECT changed_at FROM posts WHERE key = ?").get(key)?.changed_at ?? null;
const KEY = "post-1-abcdef12";
const OTHER = "post-2-abcdef34";
/**
 * What `sql` marks changed (everything set well back first, so any move shows): {any, whole, post, other} (the feed,
 * all of it, the post KEY, the post OTHER).
 */
const marks = (sql) => {
  db.exec("UPDATE feed_changed SET at = 1000, whole_at = 1000 WHERE id = 1");
  db.exec("UPDATE posts SET changed_at = 1000");
  db.exec(sql);
  const f = feedRow();
  return { any: f.at > 1000, whole: f.whole_at > 1000, post: (postRow(KEY) ?? 0) > 1000, other: (postRow(OTHER) ?? 0) > 1000 };
};
const only = (m, ...which) => ["any", "whole", "post", "other"].every((k) => m[k] === which.includes(k));
const shown = (m) => JSON.stringify(m);

db.exec(`INSERT INTO users (id, name, created_at) VALUES (1, 'Sam Taylor', 1)`);
db.exec(`INSERT INTO connections (id, origin, name, key_hash, created_at, connected_at, approved_at)
  VALUES (7, 'https://friend.example', 'Ann Example', 'h7', 1, 1, 1)`);
db.exec(`INSERT INTO posts (source, key, created_at, text, audience) VALUES ('afterwrd', '${OTHER}', 1, 'Older', 'friends')`);
const idOf = (key) => db.prepare("SELECT id FROM posts WHERE key = ?").get(key).id;

let m = marks(`INSERT INTO posts (source, key, created_at, text, audience) VALUES ('afterwrd', '${KEY}', 2, 'Hello', 'friends')`);
check("a new post is marked changed, and the feed", only(m, "any", "post"), shown(m));
m = marks(`INSERT INTO comments (target, text, created_at, author_name, origin) VALUES ('${KEY}', 'Hi', 2, 'Ann Example', 'https://friend.example')`);
check("a comment marks its post, and nothing else", only(m, "any", "post"), shown(m));
const comment = db.prepare("SELECT id FROM comments ORDER BY id DESC LIMIT 1").get().id;
m = marks(`INSERT INTO comment_versions (comment_id, text, replaced_at) VALUES (${comment}, 'Hi there', 3)`);
check("a comment's edit marks its post", only(m, "any", "post"), shown(m));
m = marks("DELETE FROM comments");
check("deleting the comment marks its post", only(m, "any", "post"), shown(m));
m = marks(`UPDATE posts SET text = 'Hello again', edited_at = 5 WHERE key = '${KEY}'`);
check("an edit marks the post", only(m, "any", "post"), shown(m));
m = marks(`INSERT INTO post_audience (post_id, connection_id, added_at) VALUES (${idOf(KEY)}, 7, 1)`);
check("sharing a post with one friend marks it", only(m, "any", "post"), shown(m));
m = marks(`UPDATE post_audience SET delivery = 'delivered' WHERE post_id = ${idOf(KEY)}`);
check("…but not how delivering it went", only(m), shown(m));
m = marks(`INSERT INTO media (source, path, kind, post_id, hash) VALUES ('afterwrd', 'p.jpg', 'photo', ${idOf(OTHER)}, 'abc')`);
check("a photo marks the post it's in", only(m, "any", "other"), shown(m));
m = marks(`INSERT INTO polls (post_id, options) VALUES (${idOf(KEY)}, '["Yes","No"]')`);
check("a poll marks its post", only(m, "any", "post"), shown(m));
m = marks(`INSERT INTO poll_votes (post_id, voter, name, choices, voted_at) VALUES (${idOf(KEY)}, 'site', 'Sam', 1, 3)`);
check("an answer to it marks its post", only(m, "any", "post"), shown(m));
m = marks(`INSERT INTO events (post_id, title, starts_at, time_zone) VALUES (${idOf(OTHER)}, 'Walk', 9999999999, 'Europe/London')`);
check("an event marks its post", only(m, "any", "other"), shown(m));
m = marks(`INSERT INTO event_answers (post_id, connection_id, answer, answered_at) VALUES (${idOf(OTHER)}, 7, 'going', 3)`);
check("an answer to it marks its post", only(m, "any", "other"), shown(m));
m = marks(`DELETE FROM posts WHERE key = '${OTHER}'`);
check("a post going marks the feed (it's gone from the newest)", only(m, "any"), shown(m));
m = marks("UPDATE users SET name = 'Sam T' WHERE id = 1");
check("the owner's new name marks all of it (their comments carry it)", only(m, "any", "whole"), shown(m));
m = marks("UPDATE users SET activity_seen_at = 9 WHERE id = 1");
check("…but not their opening Notifications", only(m), shown(m));
m = marks("UPDATE connections SET name = 'Ann E' WHERE id = 7");
check("a friend's new name marks all of it (events list who's going)", only(m, "any", "whole"), shown(m));
m = marks("UPDATE connections SET feed_checked_at = 5, copied_at = 5, copy_keys = '[]', feed_since = 'y' WHERE id = 7");
check("a refresh's bookkeeping marks nothing", only(m), shown(m));
m = marks("INSERT INTO settings (key, value) VALUES ('profile_hash', 'abc')");
check("a new profile picture marks all of it", only(m, "any", "whole"), shown(m));
m = marks("INSERT INTO settings (key, value) VALUES ('latest_release', '{}')");
check("other settings mark nothing", only(m), shown(m));
m = marks(`INSERT INTO posts (source, key, created_at, text) VALUES ('facebook', 'post-3-abcdef56', 1, 'From Facebook')`);
check("Facebook's posts mark nothing", only(m), shown(m));
m = marks(`INSERT INTO comments (target, text, created_at, author_name, origin) VALUES ('photo-${"a".repeat(64)}', 'Nice', 2, 'A', 'https://friend.example')`);
check("a comment on a photo marks no post", !m.post && !m.other, shown(m));
// Already marked this second (here, set ahead of the clock): the triggers' WHERE leaves the rows alone, so a burst
// writes each at most once a second.
db.exec("UPDATE feed_changed SET at = CAST(strftime('%s', 'now') AS INTEGER) + 100 WHERE id = 1");
db.exec(`UPDATE posts SET changed_at = CAST(strftime('%s', 'now') AS INTEGER) + 100 WHERE key = '${KEY}'`);
const ahead = [feedRow().at, postRow(KEY)];
db.exec(`INSERT INTO comments (target, text, created_at, author_name, origin) VALUES ('${KEY}', 'Two', 4, 'A', 'https://friend.example')`);
check("only once a second: a change when they're already marked this second leaves them", feedRow().at === ahead[0] && postRow(KEY) === ahead[1]);

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
