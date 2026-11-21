// The earlier words of the owner's posts and comments from before signing (post_versions, comment_versions), shown as
// they were. (Signed posts and comments are edited by signed records: lists.js. Groups' old edits, group_*_versions and
// group_mine_versions, are kept for migration, and read by nothing now.)
export const MAX_POST_TEXT = 5000;
const EARLIER_SHOWN = 20; // versions kept forever; this many shown (and sent to friends), the newest

/** Statements removing versions whose post or comment has gone. Add to any batch that deletes posts or comments. */
export const versionsGone = (db) => [
  db.prepare("DELETE FROM post_versions WHERE post_id NOT IN (SELECT id FROM posts)"),
  db.prepare("DELETE FROM comment_versions WHERE comment_id NOT IN (SELECT id FROM comments)"),
];

// --- from before signing -----------------------------------------------------------------------------------------------

// Lists of ids go to D1 as one JSON value (json_each): a statement takes at most 100 bound values, and a page can show
// more comments than that.
const IDS = "(SELECT value FROM json_each(?))";

/** Earlier versions of these posts (ids): Map id -> [{ text, replaced_at }], oldest first (the newest EARLIER_SHOWN). */
export async function postVersions(db, ids) {
  return versionsOf(db, "post_versions", "post_id", ids);
}

/** Earlier versions of these comments (ids): Map id -> [{ text, replaced_at }], oldest first. */
export async function commentVersions(db, ids) {
  return versionsOf(db, "comment_versions", "comment_id", ids);
}

async function versionsOf(db, table, column, ids) {
  const versions = new Map();
  if (!ids.length) return versions;
  // The newest EARLIER_SHOWN of each, counted in SQL, so however many there are, only those are read.
  const { results } = await db.prepare(`SELECT of, text, replaced_at FROM (SELECT ${column} AS of, text, replaced_at, id,
      ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY id DESC) AS n FROM ${table} WHERE ${column} IN ${IDS})
    WHERE n <= ${EARLIER_SHOWN} ORDER BY id`).bind(JSON.stringify(ids)).all();
  for (const v of results) {
    if (!versions.has(v.of)) versions.set(v.of, []);
    versions.get(v.of).push({ text: v.text, replaced_at: v.replaced_at });
  }
  return versions;
}
