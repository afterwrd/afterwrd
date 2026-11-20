// Notes between friends' sites about signed posts (afterwrd 2, step 4c: docs/signed-conversations.md, section 6), so a
// friend's site hears of something new without asking every site in turn. Each is a "fat note": it carries what it's
// about, signed, so the site it reaches checks it there and then and needn't call back.
//   POST /_p/notes   a signed call from a friend's site (calls.js friendCalling), one of:
//     {v: 2, kind: "item", item, delegations}
//         a new post of its owner's, exactly as /_p/items?since sends it (friendhost.js itemForFriend), with links to
//         its photos for this friend. Kept in `copies` at once; a notice for the live bar; and, if its record mentions
//         the owner here, a mention.
//     {v: 2, kind: "comment", item, photo?: {post, index}, entry: {n, fp, taken, prev, sent}, receipt, delegations, people}
//         a comment on one of its owner's items (`photo`: a photo in a post, for linking to it), with the list's head
//         before it and the host's receipt for it, so the receiver can work the head out again and check the host took
//         it there. Kept as a mention if it mentions the owner here, or as "also commented" if they've commented there
//         (`sent`); otherwise nothing.
// Sent by the Outbox (outbox.js), one row per note (queueItemNote, queueCommentNote), each built for its recipient as
// it's sent (noteFor): a post's photo links are per friend.
//
// The owner's own posts: a friend's comment, or the owner's, also tells the owner here (notices, own), when it's someone
// else's: noticeOwn.
import { friendCalling } from "./calls.js";
import { delegationsFor, itemForFriend, keyOf, peopleFor } from "./friendhost.js";
import { keepItem } from "./friendcopies.js";
import { listEntries } from "./hosted.js";
import { identityState, learnIdentity, parseChain, checkProfile } from "./identities.js";
import { ID_RE, ownHost } from "./items.js";
import { checkHead, headOf, signHead } from "./lists.js";
import { rateWindow } from "./limits.js";
import { pushAllowed } from "./notify.js";
import { outbox } from "./outbox.js";
import { notifyLater } from "./push.js";
import { checkRecord } from "./records.js";
import { json, now } from "./util.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";

const SNIPPET = 200;
const KEEP_SECONDS = 60 * 86400;
// Notices from one friend's site, as for the old notes (notify.js): plenty for a friend, few enough to be no flood.
const RATE = { count: 60, seconds: 600 };
const DAILY = 500;

const snippet = (text, size = SNIPPET) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, size) : "");

// --- sending ----------------------------------------------------------------------------------------------------------

/** Tells every friend about the owner's new post `id`, a batch at a time (the Outbox). `origin`: this site. */
export async function queueItemNote(env, origin, id) {
  await outbox(env).sendNote({ origin, kind: "item", item: id, audience: "friends" });
}

/**
 * Tells those who'll want to know about a comment (`fp`) on one of the owner's items (`item`): everyone it mentions
 * and everyone else who has commented there, as friends of this site, apart from its writer.
 */
export async function queueCommentNote(env, origin, item, record, fp) {
  const entries = await listEntries(env.DB, item);
  const people = new Set(record.mentions ?? []);
  for (const e of entries) {
    const r = e.sent && keyOfRecord(e.sent);
    if (r?.kind === "comment") people.add(r.author);
  }
  people.delete(record.author);
  if (!people.size) return;
  const { results } = await env.DB.prepare(`SELECT id FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND identity IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(JSON.stringify([...people])).all();
  if (!results.length) return;
  await outbox(env).sendNote({ origin, kind: "comment", item, fp, recipients: results.map((r) => Number(r.id)) });
}

/** The record an entry holds (as stored: {record, sig, …}), read. */
const keyOfRecord = (sent) => (typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null);

/**
 * A note (an Outbox row: {kind, item, fp}) as `connection` is sent it, or null if what it's about has gone meanwhile
 * (nothing is sent).
 */
export async function noteFor(env, note, connection) {
  const db = env.DB;
  if (note.kind === "item") {
    const row = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
      WHERE i.id = ? AND i.type = 'post' AND l.deleted_at IS NULL`).bind(note.item).first();
    if (!row) return null;
    const item = await itemForFriend(env, note.origin, row, connection.id);
    return { v: 2, kind: "item", item, delegations: await delegationsFor(db, [keyOf(item.sent)]) };
  }
  const host = await ownHost(env);
  const entries = host ? await listEntries(db, note.item) : [];
  const at = entries.findIndex((e) => e.fp === note.fp);
  const entry = entries[at];
  if (!entry?.sent) return null; // deleted since
  const record = keyOfRecord(entry.sent);
  const receipt = await signHead(host.privateKey, { host: host.person, list: note.item, n: entry.n, head: entry.head });
  // A photo in a post: which post, and where in it, so the note can say where to look.
  const photo = await db.prepare("SELECT post, position FROM item_photos WHERE photo = ?").bind(note.item).first();
  return {
    v: 2, kind: "comment", item: note.item,
    ...(photo && { photo: { post: String(photo.post), index: Number(photo.position) + 1 } }),
    entry: { n: entry.n, fp: entry.fp, taken: entry.taken, prev: at > 0 ? entries[at - 1].head : "", sent: entry.sent },
    receipt, delegations: await delegationsFor(db, [record.key]), people: await peopleFor(db, [record.author]),
  };
}

// --- receiving --------------------------------------------------------------------------------------------------------

/**
 * Keeps a notice for the owner here, within the limits for `connection`'s site (counted together, of every kind), once
 * per record and kind. Returns whether it was kept.
 */
async function keepNotice(db, { kind, fp, connection, own = 0, item, target, actor, text }) {
  const at = now();
  const row = await db.prepare(`INSERT INTO notices (kind, fp, connection_id, own, target, actor, text, created_at, item)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?12
    WHERE (SELECT COUNT(*) FROM notices WHERE connection_id = ?3 AND created_at > ?8 - ?9) < ?10
      AND (SELECT COUNT(*) FROM notices WHERE connection_id = ?3 AND created_at > ?8 - 86400) < ?11
    ON CONFLICT (kind, fp) DO NOTHING RETURNING id`)
    .bind(kind, fp, connection, own, target, snippet(actor, 100) || null, snippet(text) || null, at, rateWindow(RATE.seconds), RATE.count, DAILY, item).first();
  // Only what's past keeping (notices_by_time).
  await db.prepare("DELETE FROM notices WHERE created_at < ?").bind(at - KEEP_SECONDS).run();
  return Boolean(row);
}

/** A mention said on the owner's phones that take mentions, within their allowance (notify.js pushAllowed). */
async function tellMention(env, origin, work, { connection, title, actor, text, url, tag, comment = false }) {
  if (!(await pushAllowed(env.DB, "SELECT COUNT(*) AS n FROM notices WHERE connection_id = ?1 AND kind = 'mention' AND created_at > ?2", connection, now()))) return;
  notifyLater(env, origin, work, { kind: "mention", title, text: `${actor === title ? "Mentioned you" : `${actor} mentioned you`}: ${snippet(text)}`,
    hidden: comment ? "Mentioned you in a comment" : "Mentioned you in a post", url, tag });
}

/** POST /_p/notes: a note from a friend's site. */
export async function receiveNotes(request, env, url, work) {
  const body = new Uint8Array(await request.arrayBuffer());
  const caller = await friendCalling(request, env, url, body);
  if (caller instanceof Response) return caller;
  let note = null;
  try { note = JSON.parse(new TextDecoder().decode(body)); } catch {}
  const me = await ownHost(env);
  if (!me || note?.v !== 2) return json({ error: "That didn't work." }, 400);
  if (note.kind === "item") return receiveItem(env, url, work, caller, me, note);
  if (note.kind === "comment") return receiveComment(env, url, work, caller, me, note);
  return json({ error: "That didn't work." }, 400);
}

async function receiveItem(env, url, work, { connection, person }, me, note) {
  const kept = await keepItem(env, connection, person, note.item, note.delegations);
  if (!kept) return json({ error: "That isn't a post of theirs." }, 400);
  await kept.statement.run();
  const id = String(note.item.id);
  const name = String(connection.name);
  const text = kept.content.text || (kept.content.photos.length ? "Shared photos." : "");
  await keepNotice(env.DB, { kind: "post", fp: id, connection: connection.id, item: id, target: id, actor: name, text });
  if ((kept.record.mentions ?? []).includes(me.person)
    && (await keepNotice(env.DB, { kind: "mention", fp: id, connection: connection.id, item: id, target: id, actor: name, text }))) {
    await tellMention(env, url.origin, work, { connection: connection.id, title: name, actor: name, text,
      url: `/friend/${connection.id}/posts/${id}`, tag: `mention-${connection.id}-${id}` });
  }
  return json({ ok: true }, 202);
}

async function receiveComment(env, url, work, { connection, person }, me, note) {
  const { entry, receipt } = note;
  const item = String(note.item ?? "");
  if (!ID_RE.test(item) || !Number.isSafeInteger(entry?.n) || entry.n < 2 || !Number.isSafeInteger(entry.taken)
    || !ID_RE.test(entry.fp ?? "") || typeof entry.prev !== "string") return json({ error: "That didn't work." }, 400);
  // The host took it at that point: the head worked out again, and signed by the host.
  const hostState = await identityState(env, person);
  if (!hostState) return json({ error: "Their identity couldn't be checked." }, 400);
  const head = await headOf({ host: person, list: item, prev: entry.prev, n: entry.n, fp: entry.fp, taken: entry.taken });
  const took = await checkHead(receipt, { hostingKey: hostState.current.hosting, host: person, list: item });
  if (!took || took.n !== entry.n || took.head !== head) return json({ error: "That receipt doesn't check." }, 400);
  // Its writer: anyone in the thread, whose identity (and signed name) the note carries.
  let name = null;
  for (const [p, info] of Object.entries(note.people ?? {}).slice(0, 2)) {
    const chain = parseChain(info?.chain);
    const state = chain && (await learnIdentity(env, chain));
    if (!state || state.id !== p) continue;
    const profile = info.profile && (await checkProfile(info.profile, state));
    if (profile) name = profile.name;
  }
  const got = await checkRecord(entry.sent, { identityOf: (p) => identityState(env, p), delegationOf: async (key) => note.delegations?.[key] ?? null, at: entry.taken });
  if (!got || got.fp !== entry.fp || got.record.kind !== "comment" || got.record.host !== person || got.record.item !== item) {
    return json({ error: "That comment doesn't check." }, 400);
  }
  const author = got.record.author;
  if (author === me.person) return json({ ok: true }, 202); // the owner's own comment
  const mentioned = (got.record.mentions ?? []).includes(me.person);
  const there = !mentioned && (await env.DB.prepare("SELECT 1 FROM sent WHERE item = ? AND kind = 'comment' LIMIT 1").bind(item).first());
  if (!mentioned && !there) return json({ ok: true }, 202);
  // Named as the owner here knows them: the friend whose site it is, another friend, or as they sign themselves.
  const friend = author === person ? connection : await env.DB.prepare("SELECT name FROM connections WHERE identity = ? AND approved_at IS NOT NULL").bind(author).first();
  const actor = friend ? String(friend.name) : name ?? "Someone";
  const photo = note.photo && ID_RE.test(note.photo.post ?? "") && Number.isSafeInteger(note.photo.index) && note.photo.index >= 1 && note.photo.index <= 20 ? note.photo : null;
  const target = photo ? `${photo.post}/photos/${photo.index}` : item;
  const text = got.content?.text ?? "";
  const kept = await keepNotice(env.DB, { kind: mentioned ? "mention" : "comment", fp: entry.fp, connection: connection.id, item, target, actor, text });
  if (kept && mentioned) {
    await tellMention(env, url.origin, work, { connection: connection.id, title: String(connection.name), actor, text, comment: true,
      url: `/friend/${connection.id}/posts/${target}`, tag: `mention-${connection.id}-${target}` });
  }
  return json({ ok: true }, 202);
}

/**
 * A comment on one of the owner's own items by someone else (a friend, through /_p/records): a notice for the owner
 * here, as a mention if it names them. `item` is where it is: the post, or a photo in one.
 */
export async function noticeOwn(env, origin, work, { item, record, content, fp, connection }) {
  const me = await ownHost(env);
  if (!me || record.author === me.person || record.kind !== "comment") return;
  const photo = await env.DB.prepare("SELECT post, position FROM item_photos WHERE photo = ?").bind(item).first();
  const target = photo ? `${photo.post}/photos/${Number(photo.position) + 1}` : item;
  const mentioned = (record.mentions ?? []).includes(me.person);
  const kept = await keepNotice(env.DB, { kind: mentioned ? "mention" : "comment", fp, connection: connection.id, own: 1, item, target,
    actor: String(connection.name), text: content?.text ?? "" });
  if (kept && mentioned) {
    await tellMention(env, origin, work, { connection: connection.id, title: String(connection.name), actor: String(connection.name),
      text: content?.text ?? "", comment: true, url: `/posts/${photo ? String(photo.post) : item}`, tag: `mention-own-${target}` });
  }
}

