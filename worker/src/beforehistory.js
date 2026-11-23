// A group's posts and comments from afterwrd 1 (afterwrd 2, step 10e: docs/signed-conversations.md, "10e in detail"),
// brought over once the group has (10d: beforegroups.js), the way a person's were (10b and 10c: before.js). Each is
// re-signed by whoever wrote it, from their own copy (group_mine), and the group's site takes it only if it matches its
// own row, so neither side can put words in anyone's mouth or add to what was said. Two rounds:
//   - a post: the group's site offers exactly what its signed item will say (its words, its photos as they are here,
//     its poll or event, its time); the writer's site checks that against its own copy, and their browser signs it at
//     their next visit, with no prompt, saying when it was first written (`before`). What only the group kept is taken
//     on its word, since it can only make a post more closed (Ste, 22 Nov): a poll closed early by hand, and an event, or
//     some dates of a repeating one, called off (those dates signed by the writer as `calloff`s, as they may call one
//     off). If anyone commented on it, it takes nothing new until those comments are in (items.before_until), or the
//     group's 30 days are up.
//   - the comments on it: exactly as 10c, from each writer's copy, held aside, then put in the order they were written
//     (before.js build, with the group's rules).
// Anyone with words there may bring them over, by their site's address, whether they're in the group now or not (Ste,
// 22 Nov: afterwrd 1 kept someone's posts after they left). What never comes over is left behind; votes, event answers,
// mentions and @here aren't carried, and nobody is notified about any of it.
//
// The group's site (a signed call from the writer's site; for 30 days from when the group came over):
//   POST /_group/before   {ask: [{kind: "post" | "comment", id}…], all} -> {answers: [{kind, id, state: "ready", at,
//                           offer: {post, photos, calloffs}} (a post) | {kind, id, state: "ready", item, at, seen, prev,
//                           until} (a comment) | {kind, id, state: "later" | "taken" | "gone"}]}
//                         {post: id, sent, photos: [sent…], calloffs: [sent…], delegation, profile} -> {item, receipt}
//                         {records: [{id, sent}…], delegation, profile}: one item's comments -> {ok}
// The writer's site, through /_admin/before (before.js): `groupPost` and `groupComments` for the owner's browser, and
//   POST /_admin/before {groupPost: its id in group_mine, sent, photos, calloffs} | {groupItem, records: [{id, sent}]}
import { bodyBytes, bodyJson, callFriend, siteCalling } from "./calls.js";
import { fetchIdentity, identityState } from "./identities.js";
import { checkDelegation } from "./identity.js";
import { ID_RE, lookupsFor, refreshDate, sentRecord } from "./items.js";
import { takeRecord } from "./hosted.js";
import { ASK_EVERY, MAX_ASK, SAME_TIME, commentsTrouble, headNow, keepSigned, maybeBuild, windowOf } from "./before.js";
import { groupRules, hostOf, keepProfile, takeGroupPost } from "./groupposts.js";
import { cleanEvent, EVENT_FIELDS, hasDate } from "./calendar.js";
import { pollTrouble } from "./itemkinds.js";
import { MAX_GROUP_PHOTOS } from "./groups.js";
import { removeUnusedFiles } from "./posts.js";
import { keepSent } from "./sentchecks.js";
import { decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";

const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];
const ASK_GROUPS = 3; // groups' sites asked about the owner's words there at one go
const MAX_DATES = 60; // dates of a repeating event called off, brought over with it
const BODY_LIMIT = 1_000_000; // a call to bring things over: an item's comments may be many

/** Words as both sides keep them, compared: line endings as the browser sends them, no space at either end. */
const words = (t) => String(t ?? "").replace(/\r\n?/g, "\n").trim();
const parsed = (v) => { try { return JSON.parse(String(v ?? "null")); } catch { return null; } };

// --- the group's site --------------------------------------------------------------------------------------------------

/** When the 30 days to bring an afterwrd 1 group's posts over end, on its own site (from when it came over: 10d). */
export async function groupUntil(env) {
  const row = await env.DB.prepare(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'group_brought_at'),
    (SELECT created_at FROM own_identity WHERE id = 1)) AS at`).first();
  return (Number(row?.at) || now()) + windowOf(env);
}

/**
 * Exactly what an old post (a `group_posts` row) will say as a signed item, from the group's rows: {id, before (when it
 * was written), post (its content, its photos' `item` still to fill in), photos (each photo item's content), calloffs
 * (dates of a repeating event called off)}.
 */
async function prepare(env, row) {
  const db = env.DB;
  const id = Number(row.id);
  const [shots, poll, event, skips] = await Promise.all([
    db.prepare("SELECT hash, thumb_hash, width, height, size FROM group_photos WHERE post_id = ? ORDER BY id").bind(id).all(),
    db.prepare("SELECT options, multiple, closes_at, closed_at FROM group_polls WHERE post_id = ?").bind(id).first(),
    db.prepare("SELECT * FROM group_events WHERE post_id = ?").bind(id).first(),
    db.prepare("SELECT date FROM group_event_skips WHERE post_id = ? ORDER BY date").bind(id).all(),
  ]);
  const before = Number(row.created_at);
  const photos = shots.results.slice(0, MAX_GROUP_PHOTOS).map((m) => ({ type: "photo", hash: String(m.hash), thumb_hash: String(m.thumb_hash),
    width: Number(m.width), height: Number(m.height), size: Number(m.size) }));
  const post = /** @type {Record<string, any>} */ ({ type: "post", text: words(row.text),
    photos: photos.map((p) => ({ item: null, ...Object.fromEntries(PHOTO_FIELDS.map((f) => [f, p[f]])) })) });
  // A poll closed by hand closes at the time it was closed (a second after it was asked, at the earliest, as a poll
  // must), so it stays closed with nothing more to sign.
  if (poll) {
    const closes = [poll.closes_at, poll.closed_at].filter((t) => t !== null && t !== undefined).map(Number);
    const asked = { options: parsed(poll.options), multiple: Number(poll.multiple) ? 1 : 0, closes_at: closes.length ? Math.max(Math.min(...closes), before + 1) : null };
    if (!pollTrouble(asked, before)) post.poll = asked;
  }
  let calloffs = [];
  if (event) {
    const e = { ...Object.fromEntries(EVENT_FIELDS.map((f) => [f, event[f] ?? null])), ...(event.rrule ? { rrule: String(event.rrule) } : {}),
      ...(event.cancelled_at ? { cancelled: true } : {}) };
    if (cleanEvent(e, { repeats: true })) {
      post.type = "event";
      post.event = e;
      delete post.photos;
      delete post.poll;
      if (e.rrule && !e.cancelled) calloffs = skips.results.map((s) => String(s.date)).filter((d) => hasDate(e, d)).slice(0, MAX_DATES);
    }
  }
  return { id, before, post, photos: post.type === "event" ? [] : photos, calloffs };
}

/** An old post's own rows on the group's site (not its comments: those wait to come over, or go with it). */
const postRowsGone = (db, id) => [
  ...["group_polls", "group_poll_votes", "group_events", "group_event_skips", "group_answers", "group_post_versions"]
    .map((t) => db.prepare(`DELETE FROM ${t} WHERE post_id = ?`).bind(id)),
  db.prepare("DELETE FROM group_photos WHERE post_id = ?").bind(id),
  db.prepare("DELETE FROM group_posts WHERE id = ?").bind(id),
];

/** An old post that will never come over (its writer has no copy of it), with its comments and its photos' files. */
async function dropPost(env, id) {
  const db = env.DB;
  const files = (await db.prepare("SELECT hash, thumb_hash FROM group_photos WHERE post_id = ?").bind(id).all()).results;
  await db.batch([
    ...postRowsGone(db, id),
    db.prepare("DELETE FROM group_comment_versions WHERE comment_id IN (SELECT id FROM group_comments WHERE post_id = ?)").bind(id),
    db.prepare("DELETE FROM group_comments WHERE post_id = ?").bind(id),
  ]);
  await removeUnusedFiles(env, files.flatMap((f) => [String(f.hash), String(f.thumb_hash)]));
}

/**
 * A delegation from `person`'s identity allowing `key`, as their site sent it with what they signed: checked, and kept to
 * pass on with it (as before.js answerBefore does). Whether it checked.
 */
async function keepDelegation(env, person, delegation, key) {
  try {
    const state = await identityState(env, person);
    const bytes = typeof delegation?.bytes === "string" ? fromB64url(delegation.bytes) : null;
    if (!key || !state || !bytes || (await checkDelegation(bytes, delegation.proof, state, now())) !== key) return false;
    const { expires } = decode(bytes);
    await env.DB.prepare(`INSERT OR REPLACE INTO known_delegations (key, person, bytes, proof, expires_at, learnt_at) VALUES (?, ?, ?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER))`)
      .bind(key, person, delegation.bytes, JSON.stringify(delegation.proof), expires).run();
    return true;
  } catch { return false; }
}

/** POST /_group/before, from a writer's site: asking about what they wrote here before afterwrd 2, or bringing it over. */
export async function answerGroupBefore(request, env, url) {
  const bytes = await bodyBytes(request, BODY_LIMIT);
  if (!bytes) return json({ error: "That's too much at once." }, 413);
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller) return json({ error: "Your site's signature didn't check." }, 401);
  const self = await hostOf(env);
  if (!self) return json({ error: "This group hasn't come over to afterwrd 2 yet." }, 409);
  const until = await groupUntil(env);
  if (now() >= until) return json({ error: "It's too late to bring anything from before afterwrd 2 over here." }, 410);
  const db = env.DB;
  const has = await db.prepare("SELECT EXISTS (SELECT 1 FROM group_posts WHERE origin = ?1) OR EXISTS (SELECT 1 FROM group_comments WHERE origin = ?1) AS n")
    .bind(caller.from).first();
  if (!Number(has?.n)) return json({ error: "Nothing you wrote before afterwrd 2 is here." }, 403);
  const body = bodyJson(bytes);
  const group = { rules: await groupRules(env, self, false), table: "group_comments" };
  if (Array.isArray(body.ask)) return json({ answers: await answerAsk(env, self, caller, body, group) });
  if (body.post !== undefined) return takeBroughtPost(env, self, caller, body, until, group);
  if (Array.isArray(body.records)) return takeBroughtComments(env, self, caller, body, group);
  return json({ error: "That didn't work." }, 400);
}

/** {ask, all}: where each of the caller's old posts and comments here is now (see the top). */
async function answerAsk(env, self, caller, body, group) {
  const db = env.DB;
  const origin = caller.from;
  const asked = body.ask.slice(0, MAX_ASK).filter((a) => (a?.kind === "post" || a?.kind === "comment") && Number.isSafeInteger(a.id));
  const posts = asked.filter((a) => a.kind === "post").map((a) => a.id);
  const comments = asked.filter((a) => a.kind === "comment").map((a) => a.id);
  // Theirs here that their own copy doesn't have: not theirs to bring over. A post goes, with its comments.
  if (body.all === true) {
    const { results: dropped } = await db.prepare("SELECT id FROM group_posts WHERE origin = ? AND id NOT IN (SELECT value FROM json_each(?))")
      .bind(origin, JSON.stringify(posts)).all();
    for (const r of dropped) await dropPost(env, Number(r.id));
    const { results: declined } = await db.prepare(`UPDATE before_comments SET state = 'declined' WHERE origin = ? AND state = 'waiting'
      AND id NOT IN (SELECT value FROM json_each(?)) RETURNING item`).bind(origin, JSON.stringify(comments)).all();
    for (const item of new Set(declined.map((r) => String(r.item)))) await maybeBuild(env, self, item, group);
    await db.batch([
      db.prepare(`DELETE FROM group_comment_versions WHERE comment_id IN (SELECT id FROM group_comments WHERE origin = ?1
        AND id NOT IN (SELECT value FROM json_each(?2)) AND id NOT IN (SELECT id FROM before_comments))`).bind(origin, JSON.stringify(comments)),
      db.prepare(`DELETE FROM group_comments WHERE origin = ?1 AND id NOT IN (SELECT value FROM json_each(?2))
        AND id NOT IN (SELECT id FROM before_comments)`).bind(origin, JSON.stringify(comments)),
    ]);
  }
  const answers = [];
  for (const id of posts) {
    const row = await db.prepare("SELECT * FROM group_posts WHERE id = ? AND origin = ?").bind(id, origin).first();
    if (row) {
      const p = await prepare(env, row);
      answers.push({ kind: "post", id, state: "ready", at: p.before, offer: { post: p.post, photos: p.photos, calloffs: p.calloffs } });
    } else {
      const brought = await db.prepare("SELECT 1 FROM brought WHERE old = ?").bind(`gpost-${id}`).first();
      answers.push({ kind: "post", id, state: brought ? "taken" : "gone" });
    }
  }
  for (const id of comments) {
    const row = await db.prepare(`SELECT b.item, b.at, b.state, i.author, i.author_last, i.before_until FROM before_comments b
      JOIN items i ON i.id = b.item WHERE b.id = ? AND b.origin = ?`).bind(id, origin).first();
    if (row?.state === "waiting") {
      const seen = await headNow(db, String(row.item));
      // Their first comment follows their own post, if it's theirs; anyone else's follows nothing.
      answers.push(seen ? { kind: "comment", id, state: "ready", item: String(row.item), at: Number(row.at), seen,
        prev: String(row.author) === caller.person ? String(row.author_last) : null, until: row.before_until === null ? null : Number(row.before_until) }
        : { kind: "comment", id, state: "gone" });
    } else if (row) answers.push({ kind: "comment", id, state: row.state === "signed" ? "taken" : "gone" });
    else {
      // Its post hasn't come over yet.
      const waiting = await db.prepare("SELECT 1 FROM group_comments WHERE id = ? AND origin = ?").bind(id, origin).first();
      answers.push({ kind: "comment", id, state: waiting ? "later" : "gone" });
    }
  }
  return answers;
}

/**
 * Whether what the writer's browser signed is exactly the prepared post (`prepared`): a message saying what's wrong, or
 * null. `calloffs`: the dates called off, each a `calloff` by the writer on that date's own list, which it starts.
 */
async function postTrouble(prepared, post, photos, calloffs, author, host) {
  const ours = (r) => r?.record?.kind === "item" && r.record.author === author && r.record.host === host && r.record.before === prepared.before
    && !r.record.audience && !r.record.mentions;
  if (!ours(post) || photos.length !== prepared.photos.length || photos.some((p) => !ours(p))) return "That isn't the post from before.";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (let i = 0; i < photos.length; i++) if (!same(photos[i].content, prepared.photos[i])) return "Those aren't the photos from before.";
  const filled = structuredClone(prepared.post);
  if (filled.photos) for (let i = 0; i < photos.length; i++) filled.photos[i].item = await fingerprintOf("record", photos[i].bytes);
  if (!same(post.content, filled)) return "That isn't the post from before.";
  const id = await fingerprintOf("record", post.bytes);
  if (calloffs.length !== prepared.calloffs.length) return "Those aren't the dates called off before.";
  for (let i = 0; i < calloffs.length; i++) {
    const r = calloffs[i]?.record;
    if (!r || r.kind !== "calloff" || r.author !== author || r.host !== host || r.item !== id || r.about !== id || r.date !== prepared.calloffs[i]
      || r.seen !== null || r.prev !== null || r.before !== undefined || r.mentions || r.role_at) return "Those aren't the dates called off before.";
  }
  return null;
}

/** {post, sent, photos, calloffs, delegation, profile}: one of the caller's posts from before, signed by their browser. */
async function takeBroughtPost(env, self, caller, body, until, group) {
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM group_posts WHERE id = ? AND origin = ?").bind(Number(body.post), caller.from).first();
  if (!row) return json({ error: "That post has come over already, or isn't here." }, 404);
  const prepared = await prepare(env, row);
  const post = sentRecord(body.sent);
  const photosSent = Array.isArray(body.photos) ? body.photos.slice(0, MAX_GROUP_PHOTOS + 1) : [];
  const photos = photosSent.map(sentRecord);
  const calloffsSent = Array.isArray(body.calloffs) ? body.calloffs.slice(0, MAX_DATES + 1) : [];
  const calloffs = calloffsSent.map(sentRecord);
  if (!post?.record || !(await keepDelegation(env, caller.person, body.delegation, post.record.key))) return json({ error: "That isn't signed by them." }, 400);
  const wrong = await postTrouble(prepared, post, photos, calloffs, caller.person, self.person);
  if (wrong) return json({ error: wrong }, 400);
  await keepProfile(env, caller.person, body.profile);
  // Commented on before: it takes nothing new until those comments are in, or the group's 30 days are up.
  const commented = await db.prepare("SELECT 1 FROM group_comments WHERE post_id = ? LIMIT 1").bind(prepared.id).first();
  const made = await takeGroupPost(env, self, caller.person, { sent: body.sent, post, photosSent, photos }, { bringing: true, frozen: commented ? until : null });
  if (made.error) return json({ error: made.error }, 400);
  // The dates called off, each starting its own list (its writer's: step 6d).
  const lookups = lookupsFor(env);
  for (let i = 0; i < calloffsSent.length; i++) {
    const answer = await takeRecord(db, { sent: calloffsSent[i], host: self, lookups, group: group.rules, owner: caller.person, bringing: true });
    if (!answer.refused) await refreshDate(db, made.id, calloffs[i].record.date);
  }
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO brought (old, item, at) VALUES (?, ?, ?)").bind(`gpost-${prepared.id}`, made.id, now()),
    // Its own old rows: what's carried is in the item now (its photos' files are the photo items' now). Its comments
    // wait for their writers.
    ...postRowsGone(db, prepared.id),
    db.prepare(`INSERT OR IGNORE INTO before_comments (id, item, origin, at) SELECT id, ?, origin, created_at FROM group_comments WHERE post_id = ?`)
      .bind(made.id, prepared.id),
  ]);
  return json({ ok: true, item: made.id, receipt: made.receipt ?? null });
}

/** {records, delegation, profile}: the caller's comments from before on one item, signed by their browser (as 10c). */
async function takeBroughtComments(env, self, caller, body, group) {
  const db = env.DB;
  const records = body.records.slice(0, MAX_ASK);
  const first = records[0] && sentRecord(records[0].sent);
  const item = first?.record?.item;
  if (!item || typeof item !== "string" || !ID_RE.test(item)) return json({ error: "That didn't work." }, 400);
  const { results: rows } = await db.prepare(`SELECT b.id, b.at, c.text FROM before_comments b JOIN group_comments c ON c.id = b.id
    WHERE b.item = ? AND b.origin = ? AND b.state = 'waiting' ORDER BY b.at, b.id`).bind(item, caller.from).all();
  if (!rows.length) return json({ error: "Those have come over already, or aren't here." }, 404);
  const decline = async (why) => {
    await db.prepare("UPDATE before_comments SET state = 'declined' WHERE item = ? AND origin = ? AND state = 'waiting'").bind(item, caller.from).run();
    await maybeBuild(env, self, item, group);
    return json({ error: why }, 409);
  };
  if (!(await keepDelegation(env, caller.person, body.delegation, first.record.key))) return json({ error: "That isn't signed by them." }, 400);
  const seen = await headNow(db, item);
  const owner = await db.prepare("SELECT author, author_last FROM items WHERE id = ?").bind(item).first();
  if (!seen || !owner) return json({ error: "That post isn't here any more." }, 404);
  const wrong = await commentsTrouble(env, { rows, records, author: caller.person, host: self.person, item, seen,
    prev: String(owner.author) === caller.person ? String(owner.author_last) : null, texts: new Map(rows.map((r) => [Number(r.id), String(r.text)])) });
  if (wrong) return decline(wrong);
  await keepProfile(env, caller.person, body.profile);
  await keepSigned(db, rows, records);
  await maybeBuild(env, self, item, group);
  return json({ ok: true });
}

// --- the writer's site -------------------------------------------------------------------------------------------------

/** One of the owner's rows in group_mine, gone (brought over, left behind, or too late), with its earlier words. */
const mineGone = (db, ids) => [
  db.prepare("DELETE FROM group_mine_versions WHERE mine_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
  db.prepare("DELETE FROM group_mine WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
];

const norm = (v) => (v === undefined || v === "" ? null : v);

/**
 * Whether a post the group offered (`a`: its answer) is the owner's own, as this site's copy (`row`, in group_mine) has
 * it: the same words, photos (by fingerprint, in order), poll and event, written within a day of when this site sent it.
 * What only the group kept is taken on its word, as it can only make the post more closed: a poll closing earlier, the
 * event or some of its dates called off. Returns what the owner's browser is to sign ({host, before, post, photos,
 * calloffs}), or null.
 */
function offerFits(row, a, host) {
  const o = a?.offer;
  if (!o || typeof o !== "object" || !Number.isSafeInteger(a.at) || Math.abs(a.at - Number(row.created_at)) > SAME_TIME) return null;
  const post = o.post;
  if (!post || typeof post !== "object" || (post.type !== "post" && post.type !== "event")) return null;
  if (Object.keys(post).some((k) => !["type", "text", "photos", "poll", "event"].includes(k)) || post.text !== words(row.text)) return null;
  const hashes = parsed(row.photos) ?? [];
  const photos = Array.isArray(o.photos) ? o.photos : [];
  const calloffs = Array.isArray(o.calloffs) ? o.calloffs : [];
  if (post.type === "post") {
    if (!Array.isArray(post.photos) || post.photos.length !== hashes.length || photos.length !== hashes.length || calloffs.length || post.event !== undefined) return null;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const l = post.photos[i];
      const size = (n) => Number.isSafeInteger(n) && n > 0;
      if (!p || Object.keys(p).length !== 6 || p.type !== "photo" || p.hash !== hashes[i] || !/^[0-9a-f]{64}$/.test(p.thumb_hash ?? "")
        || !size(p.width) || !size(p.height) || !size(p.size)) return null;
      if (!l || l.item !== null || Object.keys(l).length !== 6 || PHOTO_FIELDS.some((f) => l[f] !== p[f])) return null;
    }
    const asked = parsed(row.poll);
    if (Boolean(asked) !== Boolean(post.poll)) return null;
    if (asked) {
      const p = post.poll;
      if (Object.keys(p).sort().join() !== "closes_at,multiple,options" || JSON.stringify(p.options) !== JSON.stringify(asked.options)
        || p.multiple !== (asked.multiple ? 1 : 0)) return null;
      const mine = asked.closes_at ?? null;
      const closedEarly = Number.isSafeInteger(p.closes_at) && p.closes_at > Number(row.created_at) - SAME_TIME && p.closes_at <= now()
        && (mine === null || p.closes_at < mine);
      if (p.closes_at !== mine && !closedEarly) return null;
    }
  } else {
    const mine = parsed(row.event);
    const e = post.event;
    if (!mine || !e || typeof e !== "object" || photos.length || hashes.length || post.photos !== undefined || post.poll !== undefined) return null;
    if (Object.keys(e).some((k) => !EVENT_FIELDS.includes(k) && k !== "rrule" && k !== "cancelled") || (e.cancelled !== undefined && e.cancelled !== true)) return null;
    if (!EVENT_FIELDS.every((f) => (f === "all_day" ? Number(Boolean(e[f])) === Number(Boolean(mine[f])) : norm(e[f]) === norm(mine[f])))
      || norm(e.rrule) !== norm(mine.rrule) || !cleanEvent(e, { repeats: true })) return null;
    if (calloffs.length > MAX_DATES || (calloffs.length && (!e.rrule || e.cancelled)) || new Set(calloffs).size !== calloffs.length
      || calloffs.some((d) => typeof d !== "string" || !hasDate(e, d))) return null;
  }
  return { host, before: a.at, post, photos: post.type === "post" ? photos : [], calloffs: post.type === "event" ? calloffs : [] };
}

/**
 * Asks a few groups' sites (those come over to afterwrd 2: with an identity at their address) about what the owner here
 * wrote there before, with every old id in this site's copy for each. A post offered as written is kept ready to sign;
 * a comment, where it is now. Anything gone there, taken already, or not as this site's copy has it is left behind.
 */
async function askGroups(env, from) {
  const db = env.DB;
  const { results: sites } = await db.prepare(`SELECT DISTINCT site FROM group_mine WHERE offer IS NULL AND item IS NULL AND COALESCE(asked_at, 0) < ? LIMIT ?`)
    .bind(now() - ASK_EVERY, ASK_GROUPS).all();
  for (const { site } of sites) {
    await db.prepare("UPDATE group_mine SET asked_at = ? WHERE site = ?").bind(now(), String(site)).run();
    const identity = await fetchIdentity(env, String(site)).catch(() => null);
    if (!identity) continue; // hasn't come over yet, or away: asked again in an hour
    const { results: rows } = await db.prepare("SELECT * FROM group_mine WHERE site = ? ORDER BY created_at, id LIMIT ?").bind(String(site), MAX_ASK + 1).all();
    const asked = rows.slice(0, MAX_ASK);
    let data;
    try {
      data = await callFriend(env, from, String(site), "/_group/before", {
        body: { ask: asked.map((r) => ({ kind: String(r.kind), id: Number(r.remote_id) })), all: rows.length <= MAX_ASK }, timeout: 25_000 });
    } catch (error) {
      // Its 30 days are over, or it has nothing of the owner's: nothing more can come over from there.
      if (error?.status === 410 || error?.status === 403) {
        const { results: all } = await db.prepare("SELECT id FROM group_mine WHERE site = ?").bind(String(site)).all();
        await db.batch(mineGone(db, all.map((r) => Number(r.id))));
      }
      continue;
    }
    const answers = new Map((Array.isArray(data?.answers) ? data.answers : []).map((a) => [`${a?.kind}:${Number(a?.id)}`, a]));
    const statements = [];
    const gone = [];
    for (const r of asked) {
      const a = answers.get(`${r.kind}:${Number(r.remote_id)}`);
      if (!a || a.state === "later") continue;
      if (r.kind === "post") {
        const offer = a.state === "ready" ? offerFits(r, a, identity.id) : null;
        if (offer) statements.push(db.prepare("UPDATE group_mine SET offer = ?, host = ?, host_at = ? WHERE id = ?").bind(JSON.stringify(offer), identity.id, a.at, Number(r.id)));
        else gone.push(Number(r.id));
        continue;
      }
      const fits = a.state === "ready" && ID_RE.test(a.item ?? "") && Number.isSafeInteger(a.at) && Math.abs(a.at - Number(r.created_at)) <= SAME_TIME
        && Number.isSafeInteger(a.seen?.n) && typeof a.seen?.h === "string" && (a.prev === null || ID_RE.test(a.prev ?? ""));
      if (fits) {
        statements.push(db.prepare("UPDATE group_mine SET item = ?, host = ?, host_at = ?, seen = ?, prev = ?, until = ? WHERE id = ?")
          .bind(a.item, identity.id, a.at, JSON.stringify({ n: a.seen.n, h: a.seen.h }), a.prev, Number.isSafeInteger(a.until) ? a.until : null, Number(r.id)));
      } else gone.push(Number(r.id));
    }
    if (gone.length) statements.push(...mineGone(db, gone));
    if (statements.length) await db.batch(statements);
  }
}

/**
 * What the owner's browser signs next from their groups' pasts: a post ({groupPost: {id, host, before, photos, post,
 * calloffs}}), then an item's comments ({groupComments: {item, host, seen, prev, list: [{id, before, text}]}}, in the
 * order they were written); or null.
 */
export async function nextGroupWork(env, from) {
  const db = env.DB;
  await askGroups(env, from);
  const post = await db.prepare("SELECT id, offer FROM group_mine WHERE kind = 'post' AND offer IS NOT NULL ORDER BY host_at, id LIMIT 1").first();
  if (post) {
    const o = JSON.parse(String(post.offer));
    return { groupPost: { id: Number(post.id), host: o.host, before: o.before, photos: o.photos, post: o.post, calloffs: o.calloffs } };
  }
  const ready = await db.prepare("SELECT site, item FROM group_mine WHERE kind = 'comment' AND item IS NOT NULL ORDER BY host_at, remote_id LIMIT 1").first();
  if (!ready) return null;
  const { results } = await db.prepare(`SELECT id, text, host, host_at, seen, prev FROM group_mine WHERE kind = 'comment' AND site = ? AND item = ?
    ORDER BY host_at, remote_id`).bind(String(ready.site), String(ready.item)).all();
  return { groupComments: { item: String(ready.item), host: String(results[0].host), seen: JSON.parse(String(results[0].seen)),
    prev: results[0].prev === null ? null : String(results[0].prev), list: results.map((r) => ({ id: Number(r.id), before: Number(r.host_at), text: String(r.text ?? "") })) } };
}

/** The delegation behind a record the owner's browser signed, and their signed name, to send with it. */
async function signedBy(db, key) {
  const delegation = key && (await db.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(key, now()).first());
  if (!delegation) return null;
  const own = await db.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  return { delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) }, ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) };
}

/** Away (asked again later), or refused (it stays only in this site's download until it's cleared out, as 10c). */
const refusedThere = (error) => error && error.status >= 400 && error.status < 500;

/** POST /_admin/before {groupPost, sent, photos, calloffs}: one of the owner's group posts from before, signed. */
export async function sendGroupPost(env, from, body) {
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM group_mine WHERE id = ? AND kind = 'post' AND offer IS NOT NULL").bind(Number(body.groupPost)).first();
  if (!row) return json({ error: "That has come over already." }, 404);
  const offer = JSON.parse(String(row.offer));
  const post = sentRecord(body.sent);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_GROUP_PHOTOS) : [];
  const calloffs = Array.isArray(body.calloffs) ? body.calloffs.slice(0, MAX_DATES) : [];
  if (!post?.record || post.record.kind !== "item" || post.record.host !== offer.host || post.record.before !== offer.before) return json({ error: "That isn't the post from before." }, 400);
  const by = await signedBy(db, post.record.key);
  if (!by) return json({ error: "This browser can't sign for you any more. Sign out and sign in again." }, 409);
  let reply = null;
  let failed = null;
  try {
    reply = await callFriend(env, from, String(row.site), "/_group/before", { body: { post: Number(row.remote_id), sent: body.sent, photos, calloffs, ...by }, timeout: 25_000 });
  } catch (error) { failed = error; }
  if (failed && !refusedThere(failed)) {
    await db.prepare("UPDATE group_mine SET offer = NULL, asked_at = ? WHERE id = ?").bind(now(), Number(row.id)).run();
    return json({ error: failed.message }, 502);
  }
  // Kept as sent, with the group's receipt for the post (sentchecks.js): photos and dates called off with it.
  if (!failed) {
    for (const [sent, receipt] of [[body.sent, reply?.receipt ?? null], ...photos.map((p) => [p, null]), ...calloffs.map((c) => [c, null])]) {
      const got = sentRecord(sent);
      if (got?.record) await keepSent(env, { record: got.record, sent, receipt });
    }
  }
  await db.batch(mineGone(db, [Number(row.id)]));
  // The last of the owner's posts there: its site is asked again at once, for where their comments on them are now.
  if (!(await db.prepare("SELECT 1 FROM group_mine WHERE site = ? AND offer IS NOT NULL LIMIT 1").bind(String(row.site)).first())) {
    await db.prepare("UPDATE group_mine SET asked_at = NULL WHERE site = ?").bind(String(row.site)).run();
  }
  return failed ? json({ error: failed.message }, 409) : json({ ok: true, item: reply?.item ?? null });
}

/** POST /_admin/before {groupItem, records}: the owner's comments from before on one group post, signed (as 10c). */
export async function sendGroupComments(env, from, body) {
  const db = env.DB;
  const item = typeof body.groupItem === "string" ? body.groupItem : "";
  const records = Array.isArray(body.records) ? body.records.slice(0, MAX_ASK) : [];
  const { results: rows } = await db.prepare(`SELECT id, site, remote_id, host, until FROM group_mine WHERE kind = 'comment' AND item = ?
    ORDER BY host_at, remote_id`).bind(item).all();
  if (!rows.length || records.length !== rows.length || records.some((r, i) => Number(r?.id) !== Number(rows[i].id))) return json({ error: "Those aren't all the comments from before." }, 400);
  const first = sentRecord(records[0].sent);
  const by = await signedBy(db, first?.record?.key);
  if (!by) return json({ error: "This browser can't sign for you any more. Sign out and sign in again." }, 409);
  let failed = null;
  try {
    await callFriend(env, from, String(rows[0].site), "/_group/before", { body: { records: records.map((r, i) => ({ id: Number(rows[i].remote_id), sent: r.sent })), ...by },
      timeout: 25_000 });
  } catch (error) { failed = error; }
  if (failed && !refusedThere(failed)) {
    await db.prepare("UPDATE group_mine SET item = NULL, asked_at = ? WHERE kind = 'comment' AND item = ?").bind(now(), item).run();
    return json({ error: failed.message }, 502);
  }
  const at = now();
  const statements = [];
  if (!failed) {
    // Held until they're in the post's list (sentchecks.js), checked once the group's 30 days are up.
    const until = Number(rows[0].until) || at;
    for (const r of records) {
      const fp = await fingerprintOf("record", fromB64url(r.sent.record));
      statements.push(db.prepare(`INSERT OR IGNORE INTO sent (fp, host, item, kind, record, receipt, created_at, state, next_at)
        VALUES (?, ?, ?, 'comment', ?, NULL, ?, 'held', ?)`).bind(fp, String(rows[0].host), item, JSON.stringify(r.sent), at, Math.max(until, at) + 86400));
    }
  }
  statements.push(...mineGone(db, rows.map((r) => Number(r.id))));
  await db.batch(statements);
  return failed ? json({ error: failed.message }, 409) : json({ ok: true });
}

/** Whether there may be something of the owner's groups' pasts for this browser now (Home loads the script for it). */
export async function groupWordsToBring(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM group_mine WHERE offer IS NOT NULL OR item IS NOT NULL OR COALESCE(asked_at, 0) < ?`)
    .bind(now() - ASK_EVERY).first();
  return Number(row?.n ?? 0);
}
