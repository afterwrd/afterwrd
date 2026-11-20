// What changed in what friends' sites are sent with the owner's newest posts (peers.js feed), and when: kept by the
// database itself, so no code path can forget it. A friend's site gives back what its copy is as of, and is told
// "nothing new" (a row or two read), or sent only the posts that have changed since (with the list of which are the
// newest), rather than all 30 with every comment again: on a popular site, about 440 rows for every friend, every
// time anything changed (docs/speed-and-scale-plan.md, "3,000 people on eight servers").
//
// - posts.changed_at: when anything a post is sent with last changed: its words and settings, who it's shared with,
//   its photos, comments (and their edits), poll and answers, event and answers.
// - feed_changed.at: when anything at all in the feed last changed (a post above, or one going): "nothing new" if not
//   since what a friend's site has.
// - feed_changed.whole_at: when something every post is sent with changed (the owner's name, which their comments
//   carry, and pictures; a friend's name, which event guest lists show): then the whole feed is sent again. Not the
//   owner's other bookkeeping (users.activity_seen_at moves each time they open Notifications).
// Only afterwrd's own posts are in the feed: Facebook's (an import's thousands of rows) move nothing.
//
// Each trigger sets a time only if it's moved on (to the second), so a burst writes each row once a second at most.
// A friend's site is sent everything changed at or after the second its copy is as of, so a change in that same
// second is sent again next time rather than missed. Times are the database's own clock (peers.js reads it too).
// A migration that rebuilds one of these tables must make its triggers again. A code step, not an .sql file, only
// because .sql files are split at semicolons (migrate.js) and a trigger's body has its own.

const NOW = "CAST(strftime('%s', 'now') AS INTEGER)";
const ANY = `UPDATE feed_changed SET at = ${NOW} WHERE id = 1 AND at < ${NOW};`;
// Moving whole_at moves at too (whole_at <= at always, so at is NOW already when whole_at is).
const WHOLE = `UPDATE feed_changed SET at = ${NOW}, whole_at = ${NOW} WHERE id = 1 AND whole_at < ${NOW};`;
/** The post (or posts) matching `where` changed, and so the feed did. */
const POST = (where) => `UPDATE posts SET changed_at = ${NOW}
  WHERE (${where}) AND source = 'afterwrd' AND (changed_at IS NULL OR changed_at < ${NOW}); ${ANY}`;
// What a post is sent with of its own row (share.js notes). Not changed_at, so setting it doesn't set it off again.
const POST_COLUMNS = "key, source, created_at, kind, title, text, group_name, link_url, place_name, edited_at, audience, mentions";

/** @param {D1Database} db */
export default async function feedChanged(db) {
  const trigger = (name, when, body) => db.prepare(`CREATE TRIGGER feed_${name} ${when} BEGIN ${body} END`);
  /** INSERT, UPDATE and DELETE on `table`, each moving the posts `where` picks (written with NEW, then OLD). */
  const each = (table, where, update = "UPDATE") => [
    trigger(`${table}_insert`, `AFTER INSERT ON ${table}`, POST(where("NEW"))),
    trigger(`${table}_update`, `AFTER ${update} ON ${table}`, POST(`${where("NEW")} OR ${where("OLD")}`)),
    trigger(`${table}_delete`, `AFTER DELETE ON ${table}`, POST(where("OLD"))),
  ];
  return [
    db.prepare("CREATE TABLE feed_changed (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, whole_at INTEGER NOT NULL)"),
    // Made now: friends' sites have nothing as of later than this, so the first time each asks it's sent everything.
    db.prepare(`INSERT INTO feed_changed (id, at, whole_at) VALUES (1, ${NOW}, ${NOW})`),
    db.prepare("ALTER TABLE posts ADD COLUMN changed_at INTEGER"),

    // A post: new, changed, gone. (A new one is in the newest at once, so it's sent with what's changed.)
    trigger("posts_insert", "AFTER INSERT ON posts WHEN NEW.source = 'afterwrd'", POST("id = NEW.id")),
    trigger("posts_update", `AFTER UPDATE OF ${POST_COLUMNS} ON posts WHEN NEW.source = 'afterwrd' OR OLD.source = 'afterwrd'`,
      POST("id = NEW.id")),
    trigger("posts_delete", "AFTER DELETE ON posts WHEN OLD.source = 'afterwrd'", ANY),
    // What each is sent with.
    ...each("comments", (r) => `key = ${r}.target`),
    ...each("comment_versions", (r) => `key = (SELECT target FROM comments WHERE id = ${r}.comment_id)`),
    ...each("post_versions", (r) => `id = ${r}.post_id`),
    ...each("media", (r) => `id = ${r}.post_id`),
    ...each("polls", (r) => `id = ${r}.post_id`),
    ...each("poll_votes", (r) => `id = ${r}.post_id`),
    ...each("events", (r) => `id = ${r}.post_id`),
    ...each("event_answers", (r) => `id = ${r}.post_id`),
    // Who it's shared with; not how delivering it went (delivery), which isn't sent.
    ...each("post_audience", (r) => `id = ${r}.post_id`, "UPDATE OF post_id, connection_id"),

    // What every post is sent with: the whole feed again.
    trigger("users_name", "AFTER UPDATE OF name ON users", WHOLE),
    trigger("connections_name", "AFTER UPDATE OF name ON connections", WHOLE),
    trigger("settings_insert", "AFTER INSERT ON settings WHEN NEW.key IN ('profile_hash', 'cover_hash')", WHOLE),
    trigger("settings_update", "AFTER UPDATE ON settings WHEN NEW.key IN ('profile_hash', 'cover_hash') OR OLD.key IN ('profile_hash', 'cover_hash')", WHOLE),
    trigger("settings_delete", "AFTER DELETE ON settings WHEN OLD.key IN ('profile_hash', 'cover_hash')", WHOLE),
  ];
}
