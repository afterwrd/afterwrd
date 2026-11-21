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
//
// A group's site (step 6c) sends notes to the same address, about its members' posts: groupcopies.js receiveGroupNote.
import { friendCalling } from "./calls.js";
import { signedGroup } from "./groupjoin.js";
import { receiveGroupNote } from "./groupcopies.js";
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
import { cleanEvent, eventChanged, eventWhen } from "./calendar.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";

const SNIPPET = 200;
const KEEP_SECONDS = 60 * 86400;
// Notices from one friend's site, as for the old notes (notify.js): plenty for a friend, few enough to be no flood.
const RATE = { count: 60, seconds: 600 };
const DAILY = 500;

const snippet = (text, size = SNIPPET) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, size) : "");

// --- sending ----------------------------------------------------------------------------------------------------------

/**
 * Tells every friend about the owner's new post `id`, a batch at a time (the Outbox), or, for an event, those invited.
 * `origin`: this site.
 */
export async function queueItemNote(env, origin, id) {
  const row = await env.DB.prepare("SELECT audience FROM items WHERE id = ?").bind(id).first();
  if (row?.audience === "invited") {
    const { results } = await env.DB.prepare("SELECT connection_id FROM item_guests WHERE item = ? ORDER BY connection_id").bind(id).all();
    if (results.length) await outbox(env).sendNote({ origin, kind: "item", item: id, recipients: results.map((r) => Number(r.connection_id)) });
    return;
  }
  await outbox(env).sendNote({ origin, kind: "item", item: id, audience: "friends" });
}

/**
 * After the owner changes their event `id` (`fp`: the change; none when it's been deleted): those just invited are sent
 * it (`added`), those whose invitation was taken back are told it's gone (`removed`, with `cancelled` if it was still
 * to come and they're to hear it's off), and everyone else invited is sent the change, which updates their copy (their
 * site decides whether to tell them).
 */
export async function queueChangeNotes(env, origin, id, fp, { added = [], removed = [], cancelled = false } = {}) {
  const box = outbox(env);
  if (added.length) await box.sendNote({ origin, kind: "item", item: id, recipients: added });
  if (removed.length) await box.sendNote({ origin, kind: cancelled ? "gone-off" : "gone", item: id, recipients: removed });
  if (!fp) return;
  const { results } = await env.DB.prepare("SELECT connection_id FROM item_guests WHERE item = ? ORDER BY connection_id").bind(id).all();
  const rest = results.map((r) => Number(r.connection_id)).filter((c) => !added.includes(c));
  if (rest.length) await box.sendNote({ origin, kind: "change", item: id, fp, recipients: rest });
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
  if (note.kind === "gone" || note.kind === "gone-off") return { v: 2, kind: "gone", item: note.item, cancelled: note.kind === "gone-off" };
  // An event's notes go only to those still invited when they're sent.
  const invited = await db.prepare("SELECT audience FROM items WHERE id = ?").bind(note.item).first();
  if (invited?.audience === "invited"
    && !(await db.prepare("SELECT 1 FROM item_guests WHERE item = ? AND connection_id = ?").bind(note.item, connection.id).first())) return null;
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
    v: 2, kind: note.kind === "change" ? "change" : "comment", item: note.item,
    ...(photo && { photo: { post: String(photo.post), index: Number(photo.position) + 1 } }),
    entry: { n: entry.n, fp: entry.fp, taken: entry.taken, prev: at > 0 ? entries[at - 1].head : "", sent: entry.sent },
    receipt, delegations: await delegationsFor(db, [record.key]), people: await peopleFor(db, [record.author]),
  };
}

// --- receiving --------------------------------------------------------------------------------------------------------

/**
 * Keeps a notice for the owner here, within the limits for `connection`'s site, or `group`'s (counted together, of
 * every kind), once per record and kind. Returns whether it was kept.
 */
export async function keepNotice(db, { kind, fp, connection = null, group = null, own = 0, item, target, actor, text }) {
  const at = now();
  const by = group === null ? "connection_id" : "group_id";
  const row = await db.prepare(`INSERT INTO notices (kind, fp, ${by}, own, target, actor, text, created_at, item)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?12
    WHERE (SELECT COUNT(*) FROM notices WHERE ${by} = ?3 AND created_at > ?8 - ?9) < ?10
      AND (SELECT COUNT(*) FROM notices WHERE ${by} = ?3 AND created_at > ?8 - 86400) < ?11
    ON CONFLICT (kind, fp) DO NOTHING RETURNING id`)
    .bind(kind, fp, group ?? connection, own, target, snippet(actor, 100) || null, snippet(text) || null, at, rateWindow(RATE.seconds), RATE.count, DAILY, item).first();
  // Only what's past keeping (notices_by_time).
  await db.prepare("DELETE FROM notices WHERE created_at < ?").bind(at - KEEP_SECONDS).run();
  return Boolean(row);
}

/** A mention said on the owner's phones that take mentions, within their allowance (notify.js pushAllowed). */
export async function tellMention(env, origin, work, { connection = null, group = null, title, actor, text, url, tag, comment = false }) {
  const by = group === null ? "connection_id" : "group_id";
  if (!(await pushAllowed(env.DB, `SELECT COUNT(*) AS n FROM notices WHERE ${by} = ?1 AND kind = 'mention' AND created_at > ?2`, group ?? connection, now()))) return;
  notifyLater(env, origin, work, { kind: "mention", title, text: `${actor === title ? "Mentioned you" : `${actor} mentioned you`}: ${snippet(text)}`,
    hidden: comment ? "Mentioned you in a comment" : "Mentioned you in a post", url, tag });
}

/** POST /_p/notes: a note from a friend's site, or from a group's (step 6c: groupcopies.js). */
export async function receiveNotes(request, env, url, work) {
  const group = await signedGroup(request, env, url);
  const body = new Uint8Array(await request.arrayBuffer());
  const caller = group ?? (await friendCalling(request, env, url, body));
  if (caller instanceof Response) return caller;
  let note = null;
  try { note = JSON.parse(new TextDecoder().decode(body)); } catch {}
  const me = await ownHost(env);
  if (!me || note?.v !== 2) return json({ error: "That didn't work." }, 400);
  if (group) return receiveGroupNote(env, url, work, group, me, note);
  if (note.kind === "item") return receiveItem(env, url, work, caller, me, note);
  if (note.kind === "comment" || note.kind === "change") return receiveComment(env, url, work, caller, me, note);
  if (note.kind === "gone") return receiveGone(env, url, work, caller, me, note);
  return json({ error: "That didn't work." }, 400);
}

async function receiveItem(env, url, work, { connection, person }, me, note) {
  const kept = await keepItem(env, connection, person, note.item, note.delegations);
  if (!kept) return json({ error: "That isn't a post of theirs." }, 400);
  await kept.statement.run();
  const id = String(note.item.id);
  const name = String(connection.name);
  // An invitation to their event: on Notifications and the owner's phones, as before.
  if (kept.content.event) {
    const words = eventWords(kept.content.event);
    if (await keepNotice(env.DB, { kind: "invite", fp: id, connection: connection.id, item: id, target: id, actor: name, text: words })) {
      notifyLater(env, url.origin, work, { title: name, text: `Invited you: ${words}`, hidden: "Invited you to an event",
        url: `/friend/${connection.id}/posts/${id}`, tag: `event-${connection.id}-${id}` });
    }
    return json({ ok: true }, 202);
  }
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
  if (!got || got.fp !== entry.fp || got.record.kind !== note.kind || got.record.host !== person || got.record.item !== item) {
    return json({ error: "That comment doesn't check." }, 400);
  }
  if (note.kind === "change") return receiveChange(env, url, work, { connection, person }, me, got, entry);
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


/** An event's title, when, and where: what a note about it says. */
const eventWords = (e) => `${e.title} · ${eventWhen(e)}${e.place ? ` · ${e.place}` : ""}`.slice(0, 400);

/**
 * The owner of a friend's event changed it (its signed `change`, checked by receiveComment): the copy here is brought up
 * to date, and, if it moved or was called off and the owner here hasn't said no, they're told, as before.
 */
async function receiveChange(env, url, work, { connection, person }, me, got, entry) {
  const id = got.record.item;
  if (got.record.author !== person) return json({ error: "That isn't theirs to change." }, 400);
  const copy = await env.DB.prepare("SELECT content, tally FROM copies WHERE id = ? AND connection_id = ?").bind(id, connection.id).first();
  if (!copy) return json({ ok: true }, 202);
  const was = JSON.parse(String(copy.content));
  const event = cleanEvent(got.content?.event);
  if (!was.event || !event) return json({ error: "That isn't a change to an event." }, 400);
  const cancelled = Boolean(event.cancelled) && !was.event.cancelled;
  const moved = eventChanged(was.event, event);
  const now_ = { ...was, event: { ...event, ...(event.cancelled ? { cancelled_at: was.event.cancelled_at ?? entry.taken } : {}) },
    ...(typeof got.content.text === "string" ? { text: got.content.text.slice(0, 5000) } : {}) };
  await env.DB.prepare("UPDATE copies SET content = ?, changed_at = ? WHERE id = ? AND connection_id = ?")
    .bind(JSON.stringify(now_), entry.taken, id, connection.id).run();
  const mine = JSON.parse(String(copy.tally ?? "{}"))?.answers?.[me.person]?.answer ?? null;
  if ((moved || cancelled) && mine !== "no") {
    const kind = cancelled ? "cancelled" : "changed";
    const words = eventWords(now_.event);
    if (await keepNotice(env.DB, { kind, fp: entry.fp, connection: connection.id, item: id, target: id, actor: String(connection.name), text: words })) {
      notifyLater(env, url.origin, work, { title: String(connection.name), text: `${cancelled ? "Called off" : "Changed"}: ${words}`,
        hidden: cancelled ? "Called off an event you were invited to" : "Changed an event you're invited to",
        url: `/friend/${connection.id}/posts/${id}`, tag: `event-${connection.id}-${id}` });
    }
  }
  return json({ ok: true }, 202);
}

/**
 * A friend's site saying the owner here may no longer see its post `item` (an invitation taken back, or the event
 * deleted): the copy goes, and what Notifications said about it, quietly; or, for an event still to come that's been
 * deleted (`cancelled`), they're told it's off, unless they'd said no.
 */
async function receiveGone(env, url, work, { connection }, me, note) {
  const id = String(note.item ?? "");
  if (!ID_RE.test(id)) return json({ error: "That didn't work." }, 400);
  const copy = await env.DB.prepare("SELECT content, tally FROM copies WHERE id = ? AND connection_id = ?").bind(id, connection.id).first();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM copies WHERE id = ? AND connection_id = ?").bind(id, connection.id),
    env.DB.prepare("DELETE FROM notices WHERE item = ? AND connection_id = ?").bind(id, connection.id),
  ]);
  const was = copy && JSON.parse(String(copy.content));
  const mine = copy && JSON.parse(String(copy.tally ?? "{}"))?.answers?.[me.person]?.answer;
  if (note.cancelled === true && was?.event && !was.event.cancelled && mine !== "no") {
    const words = eventWords(was.event);
    if (await keepNotice(env.DB, { kind: "cancelled", fp: `gone-${id}`, connection: connection.id, item: id, target: id, actor: String(connection.name), text: words })) {
      notifyLater(env, url.origin, work, { title: String(connection.name), text: `Called off: ${words}`, hidden: "Called off an event you were invited to",
        url: `/friend/${connection.id}/posts`, tag: `event-${connection.id}-${id}` });
    }
  }
  return json({ ok: true }, 202);
}
