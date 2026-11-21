// Comments from before signing (afterwrd 2: docs/signed-conversations.md, step 4e): those on the owner's own posts and
// photos written on afterwrd, kept as they were, the owner's alone and read-only until migration turns them into
// signed records (step 10). New comments are signed records on an item's list (items.js). Also the Notifications page's
// list, which still shows these among everything else.
// A comment's `target` is the post's address (posts.key) or the picture's (photo-<sha256>).
import { commentVersions } from "../edits.js";

export const MAX_COMMENT = 2000;
const TARGET_RE = /^(?:post-\d+-[0-9a-f]{8}|photo-([0-9a-f]{64}))$/;

export const photoKey = (m) => (m.hash ? `photo-${m.hash}` : null);

const COMMENT_SQL = `
  SELECT c.*, COALESCE(u.name, c.author_name) AS name, (c.author_id IS NOT NULL) AS author_is_owner FROM comments c
  LEFT JOIN users u ON u.id = c.author_id`;

/** Map of target -> its comments, oldest first, each with `earlier` (its earlier versions, if edited). */
export async function loadThreads(db, keys) {
  const wanted = [...new Set(keys.filter(Boolean))];
  const threads = new Map(wanted.map((k) => [k, []]));
  if (!wanted.length) return threads;
  const { results } = await db.prepare(`${COMMENT_SQL} WHERE c.target IN (${wanted.map(() => "?").join(",")})
    ORDER BY c.id`).bind(...wanted).all();
  const earlier = await commentVersions(db, results.filter((c) => c.edited_at).map((c) => c.id));
  // author_is_owner comes back from SQLite as 1/0: a bare 0 would print as "0" under someone else's comment.
  for (const c of results) threads.get(c.target).push({ ...c, author_is_owner: Boolean(c.author_is_owner), earlier: earlier.get(c.id) ?? [],
    editable: false });
  return threads;
}

// In a group: what it said (group_inbox, see notify.js), while the owner's still in it.
const GROUP_THERE = "FROM group_inbox i JOIN groups g ON g.id = i.group_id AND g.joined_at IS NOT NULL";

// Notifications: comments here from before signing (comments), notices about signed posts (notices, below), and
// comments in groups and changes to events there the owner is going to. One list, newest first. For a friend or group,
// `connection_id` is the friend or group, `friend` their name, `target` the post. `kind` is NULL for a comment, or
// 'invite' (a friend's), 'changed' or 'cancelled' for an event, or 'mention' (mentions.js: someone mentioned the owner,
// or used @here in a group). `own_post`: whether the owner wrote it (groups). `date`: which date of a repeating group
// event, when a note's about one date. `mentions`: who a comment here mentions (mentions.js).
// Signed posts (afterwrd 2: notes.js): comments and mentions on friends' posts the owner's in, and on their own
// ('own' rows), and friends' invitations to their events and changes to them, from friends still here. (A friend's new
// post is a notice too, but only for the live bar.)
const NOTICES = `FROM notices n JOIN connections co ON co.id = n.connection_id AND co.approved_at IS NOT NULL
  WHERE n.kind IN ('comment', 'mention', 'hidden', 'invite', 'changed', 'cancelled')`;
// A signed group's (step 6c: groupcopies.js): comments, mentions, @here and changes to events, while the owner's in it.
// One date of a repeating event called off (6d) has its target as "<post>?date=<date>".
const GROUP_NOTICES = `FROM notices n JOIN groups g ON g.id = n.group_id AND g.joined_at IS NOT NULL
  WHERE n.kind IN ('comment', 'mention', 'here', 'hidden', 'changed', 'cancelled')`;
const NOTIFICATIONS_SQL = `
  SELECT 'here' AS source, c.id, c.target, c.text, c.created_at, COALESCE(u.name, c.author_name) AS name, c.author_id,
    NULL AS connection_id, NULL AS friend, NULL AS own_post, NULL AS kind, NULL AS date, c.mentions
  FROM comments c LEFT JOIN users u ON u.id = c.author_id
  UNION ALL
  SELECT CASE WHEN n.own = 1 THEN 'own' ELSE 'signed' END, n.id, n.target, n.text, n.created_at, n.actor, NULL, n.connection_id, co.name,
    NULL, n.kind, NULL, NULL
  ${NOTICES}
  UNION ALL
  SELECT 'group', i.id, CAST(i.post_id AS TEXT), i.text, i.created_at, i.actor, NULL, g.id, g.name,
    EXISTS (SELECT 1 FROM group_mine m WHERE m.site = g.origin AND m.remote_group = g.remote_id AND m.kind = 'post' AND m.post_id = i.post_id),
    i.kind, i.date, NULL
  ${GROUP_THERE}
  UNION ALL
  SELECT 'group', n.id, CASE WHEN instr(n.target, '?date=') > 0 THEN substr(n.target, 1, instr(n.target, '?date=') - 1) ELSE n.target END,
    n.text, n.created_at, n.actor, NULL, g.id, g.name, n.own, n.kind,
    CASE WHEN instr(n.target, '?date=') > 0 THEN substr(n.target, instr(n.target, '?date=') + 6) END, NULL
  ${GROUP_NOTICES}`;

/** The newest notifications, for the Notifications page. */
export async function latestComments(db, page, size) {
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${NOTIFICATIONS_SQL})`),
    db.prepare(`SELECT * FROM (${NOTIFICATIONS_SQL}) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(size, (page - 1) * size),
  ]);
  const total = count.results[0].n;
  return { rows: rows.results, paging: { page, total, hasNext: page * size < total } };
}

/** How many notifications arrived since this person last opened Notifications (their own comments aren't news). */
export async function newCount(db, user) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM comments WHERE created_at > ?1 AND (author_id IS NULL OR author_id != ?2))
    + (SELECT COUNT(*) ${NOTICES} AND n.created_at > ?1)
    + (SELECT COUNT(*) ${GROUP_THERE} WHERE i.created_at > ?1)
    + (SELECT COUNT(*) ${GROUP_NOTICES} AND n.created_at > ?1) AS n`)
    .bind(user.activity_seen_at ?? 0, user.id).first();
  return row.n;
}

/**
 * The post or photo a target names, if it's still here: { post } or { photo }. A picture both imported and posted on
 * afterwrd is found as afterwrd's.
 */
export async function findTarget(db, target) {
  const match = TARGET_RE.exec(target ?? "");
  if (!match) return null;
  if (match[1]) {
    const photo = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1").bind(match[1]).first();
    return photo && { photo };
  }
  const post = await db.prepare("SELECT * FROM posts WHERE key = ?").bind(target).first();
  return post && { post };
}

/**
 * Whether what findTarget found may have comments from before signing: posts and photos made on afterwrd, apart from a
 * photo in a signed post (media.item_id), an item of its own whose comments are signed records on its list (items.js).
 */
export const hasOldThread = (found) => (found?.post ?? found?.photo)?.source === "afterwrd" && !found?.photo?.item_id;
