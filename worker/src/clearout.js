// Clearing out what's left from afterwrd 1 once the 30 days to bring it over are up (afterwrd 2, step 10f:
// docs/signed-conversations.md, "10f in detail"). afterwrd 2 writes none of afterwrd 1's tables, so whatever's in them
// by then never came over, and never will.
//
// On a person's site, 30 days after signing was set up (before.js broughtUntil), checked again daily after that:
//   - goes: comments from before that can't come over now (on a post brought over whose comments are in, on a photo that
//     was only ever in an album, anyone else's on a post still here), with their earlier words; the owner's copies of
//     what they said on the site of someone who isn't a friend any more (nothing more can come of them);
//   - stays: the owner's own posts that haven't come over (an event that waited, one that failed to sign), with what's
//     on them and their own comments on them, read-only for them, brought over whenever the job can (Ste, 23 Nov); their
//     copies of what they said on a friend's site that hasn't moved yet (until it does: before.js askHosts drops them
//     once that site's 30 days are over); what they wrote in groups (beforehistory.js drops it once a group's are);
//     `brought` (old links), albums and the Facebook archive.
// On an old group's own site, once, 30 days after its owner brought it over (beforehistory.js groupUntil): every row
// from before goes (posts, comments, photos and their files, polls, votes, events, answers, versions, the members it
// had), but `brought`, so old links still lead where they did.
//
// Both run where the 30 days are already looked at (tidyBefore: Home and friends' pulls; members' pulls on a group's
// site), after any post waiting for its comments from before has had them, a chunk at a time, so no call is long: what
// a call doesn't finish, the next one does. The empty tables, and the code that reads them, go in a later release (Ste,
// 23 Nov: at least 60 days after 2.0.0).
import { broughtUntil, buildDue } from "./before.js";
import { groupUntil } from "./beforehistory.js";
import { ownHost } from "./items.js";
import { removeUnusedFiles } from "./posts.js";
import { now } from "./util.js";

const CHUNK = 500; // rows deleted in one statement
const ROUNDS = 20; // statements of each kind in one call, at most
const AGAIN = 86400; // a person's site checks again this often, once its 30 days are up

/** Before a friend's or member's pull, or on Home: posts whose 30 days are up get their comments, then the clear-out. */
export async function tidyBefore(env, group = null) {
  await buildDue(env, group);
  await (group ? clearGroupIfDue(env) : clearOutIfDue(env));
}

/**
 * Deletes `select`'s rows from `table` (by rowid), a chunk at a time; whether it got through them all (a call that
 * didn't leaves the rest for the next).
 */
async function inChunks(db, table, select, ...binds) {
  for (let i = 0; i < ROUNDS; i++) {
    const { meta } = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (${select} LIMIT ${CHUNK})`).bind(...binds).run();
    if (Number(meta?.changes ?? 0) < CHUNK) return true;
  }
  return false;
}

/** Still frozen past its time (buildDue does five at a go): the clear-out waits until they've had their comments. */
const stillDue = (db) => db.prepare("SELECT 1 FROM items WHERE before_until IS NOT NULL AND before_until <= ? LIMIT 1").bind(now()).first();

// --- a person's site ---------------------------------------------------------------------------------------------------

/** The clear-out on a person's site, if its 30 days are up and it hasn't run today. */
export async function clearOutIfDue(env) {
  const db = env.DB;
  if (!(await ownHost(env)) || now() < (await broughtUntil(env))) return;
  const last = await db.prepare("SELECT value FROM settings WHERE key = 'before_cleared_at'").first();
  if (Number(last?.value ?? 0) > now() - AGAIN || (await stillDue(db))) return;
  if (await clearOut(db)) {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('before_cleared_at', ?)").bind(String(now())).run();
  }
}

/** Comments from before that stay: the owner's own, on their own posts (and those posts' photos) still to come over. */
const KEPT = `SELECT id FROM comments WHERE origin = 'site' AND (target IN (SELECT key FROM posts WHERE source = 'afterwrd')
  OR target IN (SELECT 'photo-' || hash FROM media WHERE source = 'afterwrd' AND hash IS NOT NULL
    AND post_id IN (SELECT id FROM posts WHERE source = 'afterwrd')))`;

/** One go at it: whether it's all done. */
async function clearOut(db) {
  // Comments still waiting on a post that isn't frozen any more can't go in now: nothing waits for them.
  let done = await inChunks(db, "before_comments", `SELECT rowid FROM before_comments
    WHERE item NOT IN (SELECT id FROM items WHERE before_until IS NOT NULL)`);
  done = done && await inChunks(db, "comments", `SELECT rowid FROM comments WHERE id NOT IN (SELECT id FROM before_comments)
    AND id NOT IN (${KEPT})`);
  done = done && await inChunks(db, "comment_versions", "SELECT rowid FROM comment_versions WHERE comment_id NOT IN (SELECT id FROM comments)");
  // Copies of what the owner said on the site of someone who isn't a friend any more.
  const gone = "SELECT id FROM comments_elsewhere WHERE connection_id NOT IN (SELECT id FROM connections WHERE approved_at IS NOT NULL)";
  done = done && await inChunks(db, "comments_elsewhere_versions", `SELECT rowid FROM comments_elsewhere_versions WHERE comment_id IN (${gone})`);
  done = done && await inChunks(db, "comments_elsewhere", `SELECT rowid FROM comments_elsewhere WHERE id IN (${gone})`);
  return done;
}

// --- an old group's own site -------------------------------------------------------------------------------------------

/** Every table on a group's site with rows from before (afterwrd 1), but group_photos (their files go too). */
const GROUP_TABLES = ["group_comment_versions", "group_comments", "group_post_versions", "group_poll_votes", "group_polls",
  "group_event_skips", "group_answers", "group_events", "group_posts", "group_members_before"];

/** The clear-out on an old group's own site, once, when its 30 days are up. */
export async function clearGroupIfDue(env) {
  const db = env.DB;
  const state = await db.prepare(`SELECT (SELECT value FROM settings WHERE key = 'group_brought_at') AS brought,
    (SELECT value FROM settings WHERE key = 'before_cleared_at') AS cleared`).first();
  // A group made on afterwrd 2 has nothing from before; one done already has nothing left.
  if (!state?.brought || state.cleared || now() < (await groupUntil(env)) || (await stillDue(db))) return;
  let done = await inChunks(db, "before_comments", "SELECT rowid FROM before_comments WHERE item NOT IN (SELECT id FROM items WHERE before_until IS NOT NULL)");
  // Photos a call gets through, and their files, unless a signed post uses them (removeUnusedFiles checks).
  for (let i = 0; done && i < ROUNDS; i++) {
    const { results } = await db.prepare(`DELETE FROM group_photos WHERE rowid IN (SELECT rowid FROM group_photos LIMIT ${CHUNK})
      RETURNING hash, thumb_hash`).all();
    await removeUnusedFiles(env, results.flatMap((f) => [f.hash, f.thumb_hash]).filter((h) => typeof h === "string"));
    if (results.length < CHUNK) break;
    if (i === ROUNDS - 1) done = false;
  }
  for (const table of GROUP_TABLES) done = done && await inChunks(db, table, `SELECT rowid FROM ${table}`);
  if (done) await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('before_cleared_at', ?)").bind(String(now())).run();
}
