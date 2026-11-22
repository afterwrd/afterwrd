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
//   - it takes no new comments until then, or the end of the 30 days after the update (items.before_until: hosted.js).
// No notes go out for it (it isn't new), except an upcoming event's invitations. An upcoming event waits until everyone
// it's for has moved to afterwrd 2 (their identity is known here), or the 30 days are up, then goes with those who have.
//
//   GET  /_admin/before   -> {next: {old, before, photos, post, mentions, guests} | null, left, waiting}
//   POST /_admin/before   {old, sent, photos, guests, salt} -> {item, left}
import { guestsFor, ownHost, sentRecord, takePost } from "./items.js";
import { queueItemNote } from "./notes.js";
import { pollTrouble } from "./itemkinds.js";
import { cleanEvent, EVENT_FIELDS, finishedAt } from "./calendar.js";
import { says } from "../public/static/records.js";
import { fingerprintOf } from "../public/static/signed.js";
import { json, now } from "./util.js";

const WINDOW_SECONDS = 30 * 86400;
const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];

/** How long everything has to come over in: 30 days, or less on a local test site (TEST_BEFORE_SECONDS). */
const windowOf = (env) => (env.ALLOW_LOCAL_SITES && Number(env.TEST_BEFORE_SECONDS) > 0 ? Number(env.TEST_BEFORE_SECONDS) : WINDOW_SECONDS);

/** When the 30 days after the update to afterwrd 2 end (migration 0046 noted when it came). */
export async function broughtUntil(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'crossover_at'").first();
  return (Number(row?.value) || now()) + windowOf(env);
}

/** How many of the owner's posts from before are still to come over (for Home's line). */
export async function leftToBring(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'").first();
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
    const asked = { options: JSON.parse(String(poll.options)), multiple: Number(poll.multiple) ? 1 : 0, closes_at: closes.length ? Math.min(...closes) : null };
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
    return json({ next: shown, left, waiting });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => ({}));
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
  let made;
  try {
    made = await takePost(env, host, { sent: body.sent, post, photosSent, photos, guests: wrong.guests },
      { bringing: true, media: prepared.media, frozen: now() < until ? until : null });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const db = env.DB;
  const at = now();
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO brought (old, item, at) VALUES (?, ?, ?)").bind(prepared.old, made.id, at),
    // A photo's comments on afterwrd 1 were kept by its fingerprint, and its page showed the first one posted: the same
    // picture in a later post keeps that first one's address (posts come over oldest first).
    ...prepared.photos.map((p, i) => db.prepare("INSERT OR IGNORE INTO brought (old, item, at) VALUES (?, ?, ?)").bind(`photo-${p.hash}`, made.photos[i], at)),
    // Its own old rows: what's carried is in the item now. Its comments stay until they come over too (10c).
    ...["polls", "poll_votes", "events", "event_answers", "post_audience", "post_versions"]
      .map((t) => db.prepare(`DELETE FROM ${t} WHERE post_id = ?`).bind(prepared.id)),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(prepared.id),
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
