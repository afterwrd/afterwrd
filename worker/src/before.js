// Bringing over what was written on afterwrd 1 (afterwrd 2, step 10: docs/signed-conversations.md, "10 in detail").
//
// 10b: the owner's own posts from before (`posts` with source 'afterwrd', with their photos, polls and events) become
// signed items. Only the owner's browser can sign, so their pages do it (static/ui/bringover.js), a post at a time and
// with no prompt, since the browser's key is already allowed to sign. This site prepares exactly what each post says
// from its old rows (prepare), the browser signs that, with `before` (when it was first written: records.js), and the
// site takes it only if it's what was prepared. Once brought over:
//   - the post's own old rows go (its poll and votes, its event, guests and answers, its earlier words: votes and
//     answers aren't carried, Ste 22 Nov), and its photos' rows are pointed at their new items;
//   - `brought` remembers which item it became, so old links lead there, and the comments made on it before can follow
//     (10c);
//   - if anyone commented on it, it takes nothing new until those comments are in (items.before_until: hosted.js), at
//     most 30 days after signing was set up here, so they go into its list first, in the order they were written.
//   - one brought over after those 30 days (it waited, or failed to sign) comes with the owner's own comments on it and
//     nobody else's, which go (10f): it takes nothing new for a day while this browser signs those.
// No notes go out for it (it isn't new), except an upcoming event's invitations. An upcoming event waits until everyone
// it's for has moved to afterwrd 2 (their identity is known here), or the 30 days are up, then goes with those who have.
//
// 10c: the comments made on those posts before (decision 9). Each is re-signed by whoever wrote it, from their own copy,
// so a host can't put words in anyone's mouth, and taken only if it matches the host's own row (the same writer, old
// id, words and time), so a writer can't add to history. The host waits for them in `before_comments`:
//   - the owner's own, on their own posts: their browser signs them from the rows here, as it does their posts;
//   - a friend's: their site asks here (POST /_p/before, a signed call) with every old id in its own copy
//     (comments_elsewhere), which says which item each is on now; whatever this site has as theirs that their copy
//     doesn't is theirs no longer ('declined'). Their browser signs each, and their site sends them here.
// Once none of an item's is waiting, or the 30 days are up, they go into its list in the order they were first written,
// each taken at the time it came (so its delegation checks), and the item takes new records again (build). What never
// came is dropped. Votes and event answers aren't carried. Nobody is notified about any of it. After the 30 days this
// site answers a friend's POST /_p/before with 410, and the friend's site drops its copies of what it said here (10f).
// Whatever's left from before then is cleared out (clearout.js).
//
//   GET  /_admin/before            -> {next: {old, before, photos, post, mentions, guests} | null, comments: {to, item,
//                                     host, seen, prev, list: [{id, before, text}]} | null, left, waiting}
//   POST /_admin/before            {old, sent, photos, guests, salt} -> {item, left}
//                                  {to: "own" | connection id, item, records: [{id, sent}]} -> {ok}
//                                  {rejoin: group id, sent}: a `join` for a group from before (10d: beforegroups.js)
//   …GET also gives, once posts and comments are over, `rejoin` ({group, host, item, seen, prev, name}: an old group
//   come over, for a join) and `approve` ({group, joins}: old members of a group the owner here brought over, waiting);
//   then `groupPost` and `groupComments`: what the owner wrote in old groups (10e: beforehistory.js), which POST takes as
//   {groupPost, sent, photos, calloffs} and {groupItem, records}.
//   POST /_p/before (friendhost)   {ask: [old ids], all} -> {answers: [{id, item, at, seen, until} | {id, state}]}
//                                  {records: [{id, sent}], delegation, profile} -> {ok}
import { guestsFor, keepIfSigned, lookupsFor, ownHost, refreshItem, sentDelegationOf, sentRecord, takePost } from "./items.js";
import { takeRecord } from "./hosted.js";
import { checkRecord } from "./records.js";
import { callFriend } from "./calls.js";
import { isBlocked } from "./blocks.js";
import { fromB64url } from "../public/static/signed.js";
import { nextApprovals, nextRejoin, sendRejoin } from "./beforegroups.js";
import { nextGroupWork, sendGroupComments, sendGroupPost } from "./beforehistory.js";
import { queueItemNote } from "./notes.js";
import { pollTrouble } from "./itemkinds.js";
import { cleanEvent, EVENT_FIELDS, finishedAt } from "./calendar.js";
import { says } from "../public/static/records.js";
import { fingerprintOf } from "../public/static/signed.js";
import { json, now } from "./util.js";

const WINDOW_SECONDS = 30 * 86400;
const LATE_FREEZE = 86400; // a post brought over after the 30 days waits this long, at most, for the owner's own comments
const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];

/** How long everything has to come over in: 30 days, or less on a local test site (TEST_BEFORE_SECONDS). */
export const windowOf = (env) => (env.ALLOW_LOCAL_SITES && Number(env.TEST_BEFORE_SECONDS) > 0 ? Number(env.TEST_BEFORE_SECONDS) : WINDOW_SECONDS);

/**
 * When the 30 days to bring things over end: 30 days after signing was set up here (10f, Ste 23 Nov), since until then
 * the site can't reach anyone or sign anything; or after the update (migration 0046 noted when it came), if that's later.
 */
export async function broughtUntil(env) {
  const row = await env.DB.prepare(`SELECT MAX(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'crossover_at'), 0),
    COALESCE((SELECT created_at FROM own_identity WHERE id = 1), 0)) AS at`).first();
  return (Number(row?.at) || now()) + windowOf(env);
}

/** How many of the owner's posts from before are still to come over (for Home's line). */
export async function leftToBring(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'").first();
  return Number(row?.n ?? 0);
}

/**
 * How many of the owner's comments from before are waiting for this browser (for Home): their own on their own posts,
 * and theirs on friends' posts, once their site has said where they are now or it's time to ask it again.
 */
export async function commentsToBring(db) {
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM before_comments WHERE origin = 'site' AND state = 'waiting')
    + (SELECT COUNT(*) FROM comments_elsewhere e JOIN connections c ON c.id = e.connection_id AND c.approved_at IS NOT NULL AND c.identity IS NOT NULL
       WHERE e.item IS NOT NULL OR COALESCE(e.asked_at, 0) < ?) AS n`).bind(now() - ASK_EVERY).first();
  return Number(row?.n ?? 0);
}

/**
 * Exactly what an old post (a `posts` row) will say as a signed item, from its old rows: {old (its key), before (when it
 * was written), photos (each photo item's content), media (their rows' ids), post (the post's content, its photos'
 * `item` still to fill in), mentions (person ids), guests ([{id, person}] for an event, else null), waiting (an
 * upcoming event whose guests haven't all moved yet)}.
 */
async function prepare(env, row, until) {
  const db = env.DB;
  const id = Number(row.id);
  const [media, poll, event, audience, friends] = await Promise.all([
    db.prepare("SELECT id, hash, thumb_hash, width, height, size FROM media WHERE post_id = ? AND source = 'afterwrd' AND hash IS NOT NULL ORDER BY id").bind(id).all(),
    db.prepare("SELECT options, multiple, closes_at, closed_at FROM polls WHERE post_id = ?").bind(id).first(),
    db.prepare("SELECT * FROM events WHERE post_id = ?").bind(id).first(),
    db.prepare(`SELECT a.connection_id, c.identity FROM post_audience a LEFT JOIN connections c ON c.id = a.connection_id AND c.approved_at IS NOT NULL
      WHERE a.post_id = ? ORDER BY a.connection_id`).bind(id).all(),
    db.prepare("SELECT origin, identity FROM connections WHERE approved_at IS NOT NULL AND identity IS NOT NULL").all(),
  ]);
  // An album's post said what was added (its title) and often nothing else: those become its words.
  const text = String(row.text ?? row.title ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 5000);
  const photos = media.results.map((m) => ({ type: "photo", ...Object.fromEntries(PHOTO_FIELDS.map((f) => [f, f === "hash" || f === "thumb_hash" ? String(m[f]) : Number(m[f])])) }));
  const post = /** @type {Record<string, any>} */ ({ type: "post", text, photos: photos.map((p) => ({ item: null, ...Object.fromEntries(PHOTO_FIELDS.map((f) => [f, p[f]])) })) });
  // A poll closed by hand closes at the time it was closed, so it stays closed without anything else to sign.
  if (poll) {
    const closes = [poll.closes_at, poll.closed_at].filter((t) => t !== null && t !== undefined).map(Number);
    const asked = { options: JSON.parse(String(poll.options)), multiple: Number(poll.multiple) ? 1 : 0, closes_at: closes.length ? Math.max(Math.min(...closes), Number(row.created_at) + 1) : null };
    if (!pollTrouble(asked, Number(row.created_at))) post.poll = asked;
  }
  let guests = null;
  let waiting = false;
  if (event) {
    const details = Object.fromEntries(EVENT_FIELDS.map((f) => [f, event[f] ?? null]));
    const e = { ...details, ...(event.cancelled_at ? { cancelled: true } : {}) };
    if (cleanEvent(e)) {
      post.type = "event";
      post.event = e;
      delete post.photos;
      guests = audience.results.filter((a) => a.identity).map((a) => ({ id: Number(a.connection_id), person: String(a.identity) }));
      waiting = guests.length < audience.results.length && finishedAt(e) > now() && now() < until;
    }
  }
  // Who it mentions, where they're known here by their identity, and its words still say so.
  const known = new Map(friends.results.map((f) => [String(f.origin), String(f.identity)]));
  const listed = (() => { try { return JSON.parse(String(row.mentions ?? "[]")); } catch { return []; } })();
  const mentions = (Array.isArray(listed) ? listed : [])
    .filter((m) => typeof m?.name === "string" && known.has(m.origin) && says(text, m.name))
    .map((m) => ({ name: m.name, person: known.get(m.origin) }))
    .filter((m, i, all) => all.findIndex((x) => x.person === m.person) === i).slice(0, 10);
  if (mentions.length) post.mentions = mentions;
  return { old: String(row.key), id, before: Number(row.created_at), photos, media: media.results.map((m) => Number(m.id)), post,
    mentions: mentions.map((m) => m.person), guests, waiting };
}

/** The next old post to bring over (oldest first, skipping events still waiting for their guests), and how many are left. */
async function next(env) {
  const until = await broughtUntil(env);
  const { results } = await env.DB.prepare("SELECT id, key, created_at, text, title, mentions FROM posts WHERE source = 'afterwrd' ORDER BY created_at, id LIMIT 200").all();
  let waiting = 0;
  for (const row of results) {
    const prepared = await prepare(env, row, until);
    if (prepared.waiting) { waiting++; continue; }
    return { prepared, left: results.length, waiting };
  }
  return { prepared: null, left: results.length, waiting };
}

/** /_admin/before: the owner's browser bringing their posts from before over, one at a time. */
export async function handleBefore(request, env, url) {
  const host = await ownHost(env);
  if (!host) return json({ error: "Set up signing first." }, 409);
  if (request.method === "GET") {
    const { prepared, left, waiting } = await next(env);
    const shown = prepared && { old: prepared.old, before: prepared.before, photos: prepared.photos, post: prepared.post,
      mentions: prepared.mentions, guests: prepared.guests };
    // Once the posts are over: comments made before, the owner's own here first, then those on friends' posts; then
    // groups from before (10d): one come over to re-join, and old members to let in to one the owner here brought over.
    const comments = shown ? null : await nextComments(env, host, url.origin);
    const rejoin = shown || comments ? null : await nextRejoin(env, url.origin);
    const approve = shown || comments || rejoin ? null : await nextApprovals(env, windowOf(env));
    // Then what the owner wrote in groups from before, once they've come over (10e: beforehistory.js).
    const history = shown || comments || rejoin || approve ? null : await nextGroupWork(env, url.origin);
    return json({ next: shown, comments, rejoin, approve, groupPost: history?.groupPost ?? null, groupComments: history?.groupComments ?? null, left, waiting });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (body.to !== undefined) return takeComments(env, host, url.origin, body);
  if (body.rejoin !== undefined) return sendRejoin(env, url.origin, Number(body.rejoin), body.sent);
  if (body.groupPost !== undefined) return sendGroupPost(env, url.origin, body);
  if (body.groupItem !== undefined) return sendGroupComments(env, url.origin, body);
  const row = typeof body.old === "string"
    ? await env.DB.prepare("SELECT id, key, created_at, text, title, mentions FROM posts WHERE key = ? AND source = 'afterwrd'").bind(body.old).first() : null;
  if (!row) return json({ error: "That post has come over already, or isn't here." }, 404);
  const until = await broughtUntil(env);
  const prepared = await prepare(env, row, until);
  if (prepared.waiting) return json({ error: "That event waits for everyone it's for to move to afterwrd 2." }, 409);
  const post = sentRecord(body.sent);
  const photosSent = Array.isArray(body.photos) ? body.photos.slice(0, 21) : [];
  const photos = photosSent.map(sentRecord);
  const wrong = await mismatch(env, host, prepared, post, photos, body);
  if (typeof wrong === "string") return json({ error: wrong }, 400);
  // After the 30 days (10f): the owner's own comments on it still come, signed by this browser straight after, so it
  // takes nothing new for a day while they do; nobody else's can come now.
  const late = now() >= until;
  let made;
  try {
    made = await takePost(env, host, { sent: body.sent, post, photosSent, photos, guests: wrong.guests },
      { bringing: true, media: prepared.media, frozen: late ? now() + LATE_FREEZE : until });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const db = env.DB;
  const at = now();
  const items = JSON.stringify([made.id, ...made.photos]);
  const others = `SELECT c.id FROM comments c JOIN brought b ON b.old = c.target WHERE b.item IN (SELECT value FROM json_each(?1)) AND c.origin != 'site'`;
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO brought (old, item, at) VALUES (?, ?, ?)").bind(prepared.old, made.id, at),
    // A photo's comments on afterwrd 1 were kept by its fingerprint, and its page showed the first one posted: the same
    // picture in a later post keeps that first one's address (posts come over oldest first).
    ...prepared.photos.map((p, i) => db.prepare("INSERT OR IGNORE INTO brought (old, item, at) VALUES (?, ?, ?)").bind(`photo-${p.hash}`, made.photos[i], at)),
    // Its own old rows: what's carried is in the item now. Its comments stay until they come over too (10c).
    ...["polls", "poll_votes", "events", "event_answers", "post_audience", "post_versions"]
      .map((t) => db.prepare(`DELETE FROM ${t} WHERE post_id = ?`).bind(prepared.id)),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(prepared.id),
    // Late, nobody else's comments on it can come now: they go first (10f).
    ...(late ? [db.prepare(`DELETE FROM comment_versions WHERE comment_id IN (${others})`).bind(items),
      db.prepare(`DELETE FROM comments WHERE id IN (${others})`).bind(items)] : []),
    // The comments made on it before, or on its photos, wait here for their writers to sign them (10c); an item nobody
    // commented on takes new records at once.
    db.prepare(`INSERT OR IGNORE INTO before_comments (id, item, origin, at) SELECT c.id, b.item, c.origin, c.created_at
      FROM comments c JOIN brought b ON b.old = c.target WHERE b.item IN (SELECT value FROM json_each(?1))`).bind(items),
    db.prepare(`UPDATE items SET before_until = NULL WHERE id IN (SELECT value FROM json_each(?1))
      AND NOT EXISTS (SELECT 1 FROM before_comments b WHERE b.item = items.id)`).bind(items),
  ]);
  // An event still to come: its guests are invited again, as afterwrd 2 invites them. Nothing else is new.
  if (post.content.type === "event" && finishedAt(post.content.event) > at && !post.content.event.cancelled) await queueItemNote(env, url.origin, made.id);
  return json({ item: made.id, left: await leftToBring(db) });
}

/**
 * Whether what the browser signed is exactly the prepared post: a message saying what's wrong, or {guests} (an event's,
 * checked against its audience fingerprint).
 */
async function mismatch(env, host, prepared, post, photos, body) {
  const ours = (r) => r?.record?.kind === "item" && r.record.author === host.person && r.record.host === host.person && r.record.before === prepared.before;
  if (!ours(post) || photos.length !== prepared.photos.length || photos.some((p) => !ours(p) || p.record.audience || p.record.mentions)) {
    return "That isn't the post from before.";
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (let i = 0; i < photos.length; i++) if (!same(photos[i].content, prepared.photos[i])) return "Those aren't the photos from before.";
  const filled = structuredClone(prepared.post);
  if (filled.photos) for (let i = 0; i < photos.length; i++) filled.photos[i].item = await fingerprintOf("record", photos[i].bytes);
  if (!same(post.content, filled) || !same(post.record.mentions ?? [], prepared.mentions)) return "That isn't the post from before.";
  if (!prepared.guests) return post.record.audience ? "That isn't the post from before." : { guests: [] };
  if (!post.record.audience) return "An event is for those invited.";
  const checked = await guestsFor(env, body.guests, body.salt, post.record.audience.fp);
  if (typeof checked === "string") return checked;
  if (!same(checked.map((g) => g.connection).sort((a, b) => a - b), prepared.guests.map((g) => g.id).sort((a, b) => a - b))) return "Those aren't the guests from before.";
  return { guests: checked };
}

// ---- 10c: the comments made before ----------------------------------------------------------------------------------

const ASK_SITES = 3; // friends' sites asked about the owner's old comments at one go
export const ASK_EVERY = 3600; // how often one is asked again, while it hasn't said
export const MAX_ASK = 500; // old comments asked about in one call
export const SAME_TIME = 86400; // how far apart the host's time for a comment and this site's may be, to sign it

/** An item's list now: {n, h}, the point a comment signed for it sees. */
export async function headNow(db, item) {
  const row = await db.prepare("SELECT n, head FROM lists WHERE id = ?").bind(item).first();
  return row ? { n: Number(row.n), h: String(row.head) } : null;
}

/**
 * The next set of the owner's old comments to sign, for one item: their own on their own posts (from this site's rows),
 * then theirs on friends' posts (from their copy, once the friend's site has said where each is now). For the browser:
 * {to ("own" or the friend's connection id), item, host, seen, prev (what the first follows: the owner's own post here,
 * nothing on a friend's), list: [{id, before, text}] in the order they were written}.
 */
async function nextComments(env, host, from) {
  const db = env.DB;
  const own = await db.prepare("SELECT item FROM before_comments WHERE origin = 'site' AND state = 'waiting' ORDER BY at, id LIMIT 1").first();
  if (own) {
    const item = String(own.item);
    const { results } = await db.prepare(`SELECT b.id, b.at, c.text FROM before_comments b JOIN comments c ON c.id = b.id
      WHERE b.item = ? AND b.origin = 'site' AND b.state = 'waiting' ORDER BY b.at, b.id`).bind(item).all();
    const row = await db.prepare("SELECT author_last FROM items WHERE id = ?").bind(item).first();
    const seen = await headNow(db, item);
    if (row && seen) {
      return { to: "own", item, host: host.person, seen, prev: String(row.author_last),
        list: results.map((r) => ({ id: Number(r.id), before: Number(r.at), text: String(r.text) })) };
    }
  }
  await askHosts(env, from);
  const ready = await db.prepare(`SELECT e.connection_id, e.item, c.identity FROM comments_elsewhere e
    JOIN connections c ON c.id = e.connection_id AND c.approved_at IS NOT NULL AND c.identity IS NOT NULL
    WHERE e.item IS NOT NULL ORDER BY e.host_at, e.remote_id LIMIT 1`).first();
  if (!ready) return null;
  const { results } = await db.prepare(`SELECT id, remote_id, text, host_at, seen FROM comments_elsewhere WHERE connection_id = ? AND item = ?
    ORDER BY host_at, remote_id`).bind(Number(ready.connection_id), String(ready.item)).all();
  return { to: Number(ready.connection_id), item: String(ready.item), host: String(ready.identity), seen: JSON.parse(String(results[0].seen)), prev: null,
    list: results.map((r) => ({ id: Number(r.id), before: Number(r.host_at), text: String(r.text) })) };
}

/**
 * Asks a few friends' sites about the owner's old comments there (POST /_p/before), with every old id in this site's
 * copy for each: where each is now (or that it's gone, or that its post hasn't come over yet). One whose time there is
 * more than a day from this site's is left: they don't agree it's the same comment.
 */
async function askHosts(env, from) {
  const db = env.DB;
  const { results: sites } = await db.prepare(`SELECT DISTINCT c.id, c.origin FROM comments_elsewhere e
    JOIN connections c ON c.id = e.connection_id AND c.approved_at IS NOT NULL AND c.identity IS NOT NULL
    WHERE e.item IS NULL AND COALESCE(e.asked_at, 0) < ? LIMIT ?`).bind(now() - ASK_EVERY, ASK_SITES).all();
  for (const site of sites) {
    const { results: rows } = await db.prepare("SELECT id, remote_id, created_at FROM comments_elsewhere WHERE connection_id = ? LIMIT ?")
      .bind(Number(site.id), MAX_ASK + 1).all();
    const asked = rows.slice(0, MAX_ASK);
    await db.prepare("UPDATE comments_elsewhere SET asked_at = ? WHERE connection_id = ?").bind(now(), Number(site.id)).run();
    let data;
    try {
      data = await callFriend(env, from, String(site.origin), "/_p/before", { body: { ask: asked.map((r) => Number(r.remote_id)), all: rows.length <= MAX_ASK } });
    } catch (error) {
      // Its 30 days are over (10f): nothing more can come over there.
      if (error?.status === 410) await db.batch(elsewhereGone(db, Number(site.id)));
      continue; // otherwise still on afterwrd 1, or away: asked again in an hour
    }
    const answers = new Map((Array.isArray(data?.answers) ? data.answers : []).map((a) => [Number(a?.id), a]));
    const statements = [];
    for (const r of asked) {
      const a = answers.get(Number(r.remote_id));
      if (!a || a.state === "later") continue; // its post hasn't come over yet
      const fits = a.item && /^[A-Za-z0-9_-]{43}$/.test(a.item) && Number.isSafeInteger(a.at) && Math.abs(a.at - Number(r.created_at)) <= SAME_TIME
        && Number.isSafeInteger(a.seen?.n) && typeof a.seen?.h === "string";
      statements.push(fits
        ? db.prepare("UPDATE comments_elsewhere SET item = ?, host_at = ?, seen = ?, until = ? WHERE id = ?")
          .bind(a.item, a.at, JSON.stringify({ n: a.seen.n, h: a.seen.h }), Number.isSafeInteger(a.until) ? a.until : null, Number(r.id))
        // Gone there, taken already, or not the same comment: nothing to bring over.
        : db.prepare("DELETE FROM comments_elsewhere WHERE id = ?").bind(Number(r.id)));
    }
    if (statements.length) await db.batch(statements);
  }
}

/** The owner's copies of what they said on a friend's site before (by connection), gone. */
export const elsewhereGone = (db, connection) => [
  db.prepare("DELETE FROM comments_elsewhere_versions WHERE comment_id IN (SELECT id FROM comments_elsewhere WHERE connection_id = ?)").bind(connection),
  db.prepare("DELETE FROM comments_elsewhere WHERE connection_id = ?").bind(connection),
];

/** What's wrong with a set of signed comments for an item (in order, `rows` the old ones they're for), or null. */
export async function commentsTrouble(env, { rows, records, author, host, item, seen, prev, texts }) {
  if (records.length !== rows.length) return "Those aren't all the comments from before.";
  let last = prev;
  for (let i = 0; i < rows.length; i++) {
    const r = records[i];
    const got = r && (await checkRecord(r.sent, { ...lookupsFor(env), at: now() }));
    const rec = got?.record;
    if (!rec || rec.kind !== "comment" || rec.author !== author || rec.host !== host || rec.item !== item || rec.before !== Number(rows[i].at)
      || rec.prev !== last || rec.seen?.n !== seen.n || rec.seen?.h !== seen.h || rec.mentions || Number(r.id) !== Number(rows[i].id)) {
      return "That isn't a comment from before, as it was.";
    }
    if (JSON.stringify(got.content) !== JSON.stringify({ text: texts.get(Number(rows[i].id)) })) return "Those aren't the words from before.";
    last = got.fp;
  }
  return null;
}

/** POST /_admin/before {to, item, records}: the owner's browser signed a set of their old comments. */
async function takeComments(env, host, from, body) {
  const db = env.DB;
  const records = Array.isArray(body.records) ? body.records.slice(0, MAX_ASK) : [];
  const item = typeof body.item === "string" ? body.item : "";
  if (body.to === "own") {
    const { results: rows } = await db.prepare(`SELECT b.id, b.at, c.text FROM before_comments b JOIN comments c ON c.id = b.id
      WHERE b.item = ? AND b.origin = 'site' AND b.state = 'waiting' ORDER BY b.at, b.id`).bind(item).all();
    const owner = await db.prepare("SELECT author_last FROM items WHERE id = ?").bind(item).first();
    const seen = await headNow(db, item);
    if (!rows.length || !owner || !seen) return json({ error: "Those have come over already." }, 404);
    const wrong = await commentsTrouble(env, { rows, records, author: host.person, host: host.person, item, seen, prev: String(owner.author_last),
      texts: new Map(rows.map((r) => [Number(r.id), String(r.text)])) });
    if (wrong) return json({ error: wrong }, 400);
    await keepSigned(db, rows, records);
    await maybeBuild(env, host, item);
    return json({ ok: true });
  }
  // On a friend's post: sent there, and kept as sent (held until it's in their list: sentchecks.js).
  const connection = await db.prepare("SELECT id, origin, identity FROM connections WHERE id = ? AND approved_at IS NOT NULL AND identity IS NOT NULL").bind(Number(body.to)).first();
  if (!connection) return json({ error: "They aren't a friend here any more." }, 404);
  const { results: rows } = await db.prepare("SELECT id, remote_id, until FROM comments_elsewhere WHERE connection_id = ? AND item = ? ORDER BY host_at, remote_id")
    .bind(Number(connection.id), item).all();
  if (!rows.length || records.length !== rows.length || records.some((r, i) => Number(r?.id) !== Number(rows[i].id))) return json({ error: "Those aren't all the comments from before." }, 400);
  const first = sentRecord(records[0].sent);
  const delegation = first?.record && await db.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(first.record.key, now()).first();
  if (!delegation) return json({ error: "This browser can't sign for you any more. Sign out and sign in again." }, 409);
  const own = await db.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  let failed = null;
  try {
    await callFriend(env, from, String(connection.origin), "/_p/before", { body: {
      records: records.map((r, i) => ({ id: Number(rows[i].remote_id), sent: r.sent })),
      delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
      ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) } });
  } catch (error) { failed = error; }
  // Away: asked again later. Refused: their site won't take them (it doesn't agree they're as written), so they stay
  // only in this site's download, as before.
  if (failed && !(failed.status >= 400 && failed.status < 500)) {
    await db.prepare("UPDATE comments_elsewhere SET item = NULL, asked_at = ? WHERE connection_id = ? AND item = ?").bind(now(), Number(connection.id), item).run();
    return json({ error: failed.message }, 502);
  }
  const at = now();
  const statements = [];
  if (!failed) {
    for (const r of records) {
      const fp = await fingerprintOf("record", fromB64url(r.sent.record));
      const until = Number(rows[0].until) || at;
      statements.push(db.prepare(`INSERT OR IGNORE INTO sent (fp, host, item, kind, record, receipt, created_at, state, next_at)
        VALUES (?, ?, ?, 'comment', ?, NULL, ?, 'held', ?)`).bind(fp, String(connection.identity), item, JSON.stringify(r.sent), at, Math.max(until, at) + 86400));
    }
  }
  const ids = JSON.stringify(rows.map((r) => Number(r.id)));
  statements.push(db.prepare("DELETE FROM comments_elsewhere_versions WHERE comment_id IN (SELECT value FROM json_each(?))").bind(ids),
    db.prepare("DELETE FROM comments_elsewhere WHERE id IN (SELECT value FROM json_each(?))").bind(ids));
  await db.batch(statements);
  return failed ? json({ error: failed.message }, 409) : json({ ok: true });
}

/** Keeps signed comments from before, to go into their item's list once they're all in (build). */
export function keepSigned(db, rows, records) {
  const at = now();
  return db.batch(rows.map((r, i) => db.prepare("UPDATE before_comments SET state = 'signed', sent = ?, signed_at = ? WHERE id = ? AND state = 'waiting'")
    .bind(JSON.stringify(records[i].sent), at, Number(r.id))));
}

/**
 * POST /_p/before, from a friend's site (`caller`: {person, connection}): asking where its owner's old comments here
 * are now, or sending them signed.
 */
export async function answerBefore(env, caller, body) {
  const db = env.DB;
  const host = await ownHost(env);
  if (!host) return json({ error: "Not found." }, 404);
  // Its 30 days are over (10f): the caller's site drops its copies.
  if (now() >= (await broughtUntil(env))) return json({ error: "It's too late to bring anything from before afterwrd 2 over here." }, 410);
  const origin = String(caller.connection.origin);
  // Someone the owner's blocked: what they wrote before doesn't come over, with no more said than "gone".
  const blocked = await isBlocked(db, caller.person);
  if (Array.isArray(body?.ask)) {
    const ids = body.ask.slice(0, MAX_ASK).map(Number).filter(Number.isSafeInteger);
    if (blocked) return json({ answers: ids.map((id) => ({ id, state: "gone" })) });
    // Theirs here that their own copy doesn't have: not theirs to bring over.
    if (body.all === true) {
      const { results: dropped } = await db.prepare(`UPDATE before_comments SET state = 'declined' WHERE origin = ? AND state = 'waiting'
        AND id NOT IN (SELECT value FROM json_each(?)) RETURNING item`).bind(origin, JSON.stringify(ids)).all();
      for (const item of new Set(dropped.map((r) => String(r.item)))) await maybeBuild(env, host, item);
    }
    const answers = [];
    for (const id of ids) {
      const row = await db.prepare("SELECT b.item, b.at, b.state, i.before_until FROM before_comments b JOIN items i ON i.id = b.item WHERE b.id = ? AND b.origin = ?").bind(id, origin).first();
      if (row?.state === "waiting") {
        const seen = await headNow(db, String(row.item));
        answers.push(seen ? { id, item: String(row.item), at: Number(row.at), seen, until: row.before_until === null ? null : Number(row.before_until) } : { id, state: "gone" });
      } else if (row) answers.push({ id, state: row.state === "signed" ? "taken" : "gone" });
      else answers.push({ id, state: (await db.prepare("SELECT 1 FROM comments WHERE id = ? AND origin = ?").bind(id, origin).first()) ? "later" : "gone" });
    }
    return json({ answers });
  }
  const records = Array.isArray(body?.records) ? body.records.slice(0, MAX_ASK) : [];
  const first = records[0] && sentRecord(records[0].sent);
  const item = first?.record?.item;
  if (!item || typeof item !== "string") return json({ error: "That didn't work." }, 400);
  const { results: rows } = await db.prepare(`SELECT b.id, b.at, c.text FROM before_comments b JOIN comments c ON c.id = b.id
    WHERE b.item = ? AND b.origin = ? AND b.state = 'waiting' ORDER BY b.at, b.id`).bind(item, origin).all();
  if (!rows.length) return json({ error: "Those have come over already, or aren't here." }, 404);
  const decline = async (why) => {
    await db.prepare("UPDATE before_comments SET state = 'declined' WHERE item = ? AND origin = ? AND state = 'waiting'").bind(item, origin).run();
    await maybeBuild(env, host, item);
    return json({ error: why }, 409);
  };
  if (blocked) return decline("That wasn't taken.");
  // Allowed by a delegation from their identity, kept to pass on with what they signed once each checks with it.
  if (!(await keepIfSigned(env, await sentDelegationOf(env, caller.person, body.delegation, first.record.key), records))) {
    return json({ error: "That isn't signed by them." }, 400);
  }
  const seen = await headNow(db, item);
  if (!seen) return json({ error: "That post isn't here any more." }, 404);
  const wrong = await commentsTrouble(env, { rows, records, author: caller.person, host: host.person, item, seen, prev: null,
    texts: new Map(rows.map((r) => [Number(r.id), String(r.text)])) });
  if (wrong) return decline(wrong);
  await keepSigned(db, rows, records);
  await maybeBuild(env, host, item);
  return json({ ok: true });
}

/**
 * Puts an item's comments from before into its list, once none is waiting. In a group (step 10e: beforehistory.js),
 * `group`: {rules (the group's, for takeRecord), table: 'group_comments'}, where its old comments were.
 */
export async function maybeBuild(env, host, item, group = null) {
  const waiting = await env.DB.prepare("SELECT 1 FROM before_comments WHERE item = ? AND state = 'waiting' LIMIT 1").bind(item).first();
  if (!waiting) await build(env, host, item, group);
}

/**
 * Items whose 30 days are up: their comments from before go in with what came (Home, and friends' pulls, ask; in a
 * group, members' pulls). `group` as for maybeBuild.
 */
export async function buildDue(env, group = null) {
  const host = await ownHost(env);
  if (!host) return;
  const { results } = await env.DB.prepare(`SELECT DISTINCT b.item FROM before_comments b JOIN items i ON i.id = b.item
    WHERE i.before_until IS NOT NULL AND i.before_until <= ? LIMIT 5`).bind(now()).all();
  for (const r of results) await build(env, host, String(r.item), group);
  // One brought over with no comments from before left waiting (all declined, say), still frozen: open again.
  await env.DB.prepare(`UPDATE items SET before_until = NULL WHERE before_until IS NOT NULL AND before_until <= ?
    AND NOT EXISTS (SELECT 1 FROM before_comments b WHERE b.item = items.id)`).bind(now()).run();
}

/** Before a friend (or a group's member) reads an item: its comments from before go in first, if its time is up. */
export async function buildIfDue(env, item, group = null) {
  const due = await env.DB.prepare("SELECT 1 FROM items WHERE id = ? AND before_until IS NOT NULL AND before_until <= ?").bind(item, now()).first();
  if (!due) return;
  const host = await ownHost(env);
  if (host) await build(env, host, item, group);
}

/**
 * An item's comments from before, into its list in the order they were first written (each taken at the time it came,
 * so its delegation checks); what never came is dropped, with its old row. Then it takes new records again, and its
 * changed time moves on, so friends' sites ask for it again.
 */
async function build(env, host, item, group = null) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT id, state, sent, signed_at FROM before_comments WHERE item = ? ORDER BY at, id").bind(item).all();
  const lookups = lookupsFor(env);
  for (const r of results.filter((x) => x.state === "signed")) {
    await takeRecord(db, { sent: JSON.parse(String(r.sent)), host, lookups, taken: Number(r.signed_at), bringing: true, group: group?.rules ?? null }).catch(() => null);
  }
  const ids = JSON.stringify(results.map((r) => Number(r.id)));
  const [table, versions] = group ? ["group_comments", "group_comment_versions"] : ["comments", "comment_versions"];
  await db.batch([
    db.prepare("DELETE FROM before_comments WHERE item = ?").bind(item),
    db.prepare(`DELETE FROM ${versions} WHERE comment_id IN (SELECT value FROM json_each(?))`).bind(ids),
    db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).bind(ids),
    db.prepare("UPDATE items SET before_until = NULL, changed_at = ? WHERE id = ?").bind(now(), item),
  ]);
  await refreshItem(db, item);
}
