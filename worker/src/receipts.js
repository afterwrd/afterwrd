// Mention receipts (afterwrd 2, step 5: docs/signed-conversations.md section 6, decision 18). When the owner here
// mentions someone in a comment on a friend's post, the host's note tells them (notes.js); this site also sends them the
// host's receipt itself, so they hear even if the host never says, and their site checks the host shows them the same
// conversation at that point. It's where showing different people different versions of a thread would hurt most: a
// reply aimed at someone. The writer and the person mentioned needn't be friends.
//   POST /_p/mention   {v: 2, kind: "receipt", host, item, photo?, sent, receipt, delegation, people}
//     a signed call from the writer's own site: their comment as signed (`sent`), the host's receipt for it (its
//     signed head where it took it), the delegation behind it, and the writer's identity and signed name (`people`).
// Taken only about a friend's post (the host must be a friend here), or a post in a group the owner's in (step 6c), and
// only when it mentions the owner here; anything else gets the same quiet answer, so nobody can learn from it who the
// owner is friends with. The writer's identity is
// fetched from their own address only once that much has checked.
import { isBlocked } from "./blocks.js";
import { callFriend, siteCalling } from "./calls.js";
import { friendThread } from "./friendcopies.js";
import { groupThread } from "./groupcopies.js";
import { checkProfile, identityState } from "./identities.js";
import { ID_RE, ownHost } from "./items.js";
import { checkHead } from "./lists.js";
import { keepNotice, tellMention } from "./notes.js";
import { outbox } from "./outbox.js";
import { checkRecord } from "./records.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";

const MAX_BODY = 64 * 1024;
// A host that can't be asked is asked again at the next pulls of its posts, for this long; then it's left unchecked.
const CHECK_SECONDS = 2 * 86400;

// --- sending ------------------------------------------------------------------------------------------------------------

/**
 * After the owner's comment `fp` (its record, `record`) was taken on a friend's item: everyone it mentions, apart from
 * the host (whose own site told it) and the owner, is sent the receipt, through the Outbox (retried for about two days).
 */
export async function queueReceipts(env, origin, record, fp) {
  const people = [...new Set(record.mentions ?? [])].filter((p) => p !== record.host && p !== record.author);
  if (record.kind !== "comment" || !people.length) return;
  await outbox(env).sendNote({ origin, kind: "receipt", item: String(record.item), fp, recipients: people });
}

/** The address of `person`'s site, as this site knows them (from the thread they're in); null if it doesn't. */
export async function receiptOrigin(env, person) {
  const row = await env.DB.prepare("SELECT origin FROM identities WHERE person = ? AND frozen_at IS NULL").bind(person).first();
  return row ? String(row.origin) : null;
}

/** The receipt note about the owner's comment `fp`, or null if there's nothing to send (deleted since, or never taken). */
export async function receiptFor(env, fp) {
  const db = env.DB;
  const row = await db.prepare("SELECT host, item, record, receipt FROM sent WHERE fp = ?").bind(fp).first();
  if (!row?.receipt) return null;
  const sent = JSON.parse(String(row.record));
  if (!sent.content) return null; // its words deleted since: nothing to tell anyone
  const record = parseRecord(fromB64url(sent.record));
  const delegation = record && (await db.prepare("SELECT bytes, proof FROM known_delegations WHERE key = ?1 UNION ALL SELECT bytes, proof FROM delegations WHERE key = ?1 LIMIT 1")
    .bind(record.key).first());
  const own = await db.prepare("SELECT person, chain, profile FROM own_identity WHERE id = 1").first();
  if (!record || !delegation || !own) return null;
  // A photo in a post: which post, and where, so the note can say where to look (as this site's copy of the post has it).
  const item = String(row.item);
  let photo = null;
  const { results } = await db.prepare("SELECT id, content FROM copies WHERE instr(content, ?) > 0 LIMIT 3").bind(item).all();
  for (const c of results) {
    const index = (JSON.parse(String(c.content)).photos ?? []).findIndex((p) => p.item === item);
    if (index >= 0) photo = { post: String(c.id), index: index + 1 };
  }
  return { v: 2, kind: "receipt", host: String(row.host), item, ...(photo && { photo }), sent, receipt: JSON.parse(String(row.receipt)),
    delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
    people: { [String(own.person)]: { chain: JSON.parse(String(own.chain)), ...(own.profile ? { profile: JSON.parse(String(own.profile)) } : {}) } } };
}

/** Sends the receipt note `note` (an Outbox row) to `person`. Throws as callFriend does; returns whether it sent one. */
export async function sendReceipt(env, note, person) {
  const to = await receiptOrigin(env, person);
  const body = to && (await receiptFor(env, String(note.fp)));
  if (!body) return false;
  await callFriend(env, String(note.origin), to, "/_p/mention", { body });
  return true;
}

// --- receiving ----------------------------------------------------------------------------------------------------------

/** POST /_p/mention. */
export async function receiveReceipt(request, env, url, work) {
  const quiet = () => json({ ok: true }, 202);
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length > MAX_BODY) return quiet();
  let note = null;
  try { note = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
  const me = await ownHost(env);
  const host = String(note?.host ?? "");
  const item = String(note?.item ?? "");
  if (!me || note?.v !== 2 || note.kind !== "receipt" || !ID_RE.test(host) || !ID_RE.test(item)) return quiet();
  // Only about a friend's post, or a post in a group the owner's in (step 6c): nothing is fetched or kept for anything else.
  const connection = await env.DB.prepare("SELECT * FROM connections WHERE identity = ? AND approved_at IS NOT NULL AND connected_at IS NOT NULL")
    .bind(host).first();
  const group = !connection && (await env.DB.prepare("SELECT * FROM groups WHERE identity = ? AND joined_at IS NOT NULL AND origin IS NOT NULL").bind(host).first());
  const record = typeof note.sent?.record === "string" ? parseRecord(fromB64url(note.sent.record)) : null;
  if ((!connection && !group) || !record || record.kind !== "comment" || record.host !== host || record.item !== item || record.author === me.person
    || !(record.mentions ?? []).includes(me.person)) return quiet();
  // From the writer's own site, signed by it (its identity fetched from its address only now).
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller || caller.person !== record.author || (await isBlocked(env.DB, record.author))) return quiet();
  const got = await checkRecord(note.sent, { identityOf: (p) => identityState(env, p),
    delegationOf: async (key) => (key === record.key && note.delegation ? note.delegation : null), at: now() });
  const hostState = got && (await identityState(env, host));
  const took = hostState && !hostState.frozen && (await checkHead(note.receipt, { hostingKey: hostState.current.hosting, host, list: item }));
  if (!took) return quiet();
  // Named as the owner here knows them: a friend, or as they sign themselves.
  const friend = await env.DB.prepare("SELECT name FROM connections WHERE identity = ? AND approved_at IS NOT NULL").bind(record.author).first();
  const writer = await identityState(env, record.author);
  const profile = note.people?.[record.author]?.profile;
  const signed = !friend && profile && writer ? await checkProfile(profile, writer) : null;
  const actor = friend ? String(friend.name) : signed?.name ?? "Someone";
  const photo = note.photo && ID_RE.test(note.photo.post ?? "") && Number.isSafeInteger(note.photo.index) && note.photo.index >= 1 && note.photo.index <= 20 ? note.photo : null;
  const target = photo ? `${photo.post}/photos/${photo.index}` : item;
  await env.DB.prepare(`INSERT OR IGNORE INTO mention_receipts (fp, connection_id, group_id, item, n, head, writer, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'unchecked', ?)`).bind(got.fp, connection ? connection.id : null, group ? group.id : null, item, took.n, took.head,
    record.author, now()).run();
  // The mention, whether or not the host's own note has come (the same notice either way: one per record).
  const text = got.content?.text ?? "";
  const holder = connection ? { connection: Number(connection.id) } : { group: Number(group.id) };
  const where = connection ? `/friend/${connection.id}/posts/${target}` : `/groups/${group.id}/posts/${target}`;
  if (await keepNotice(env.DB, { kind: "mention", fp: got.fp, ...holder, item, target, actor, text, author: record.author })) {
    await tellMention(env, url.origin, work, { ...holder, title: String((connection ?? group).name), actor, text, comment: true, author: record.author,
      url: where, tag: connection ? `mention-${connection.id}-${target}` : `mention-g${group.id}-${target}` });
  }
  // Then whether the host shows the owner here the same conversation at that point.
  const checking = (connection ? checkReceipts(env, url.origin, connection, got.fp) : checkGroupReceipts(env, url.origin, group, got.fp))
    .catch((error) => console.error("receipt check:", error.message));
  if (work?.waitUntil) work.waitUntil(checking);
  else await checking;
  return quiet();
}

// --- checking -----------------------------------------------------------------------------------------------------------

/** As checkReceipts, for a group the owner's in (`group`: its row here), whose site took the comment (step 6c). */
export async function checkGroupReceipts(env, from, group, only = null) {
  const db = env.DB;
  const { results } = only
    ? await db.prepare("SELECT * FROM mention_receipts WHERE fp = ?").bind(only).all()
    : await db.prepare("SELECT * FROM mention_receipts WHERE group_id = ? AND state = 'unchecked' AND created_at > ? ORDER BY created_at LIMIT 3")
      .bind(group.id, now() - CHECK_SECONDS).all();
  const threads = new Map();
  for (const r of results) {
    const item = String(r.item);
    if (!threads.has(item)) threads.set(item, await groupThread(env, from, group, item));
    const thread = threads.get(item);
    if (thread.error) continue;
    const at = thread.entries.find((e) => e.n === Number(r.n));
    const state = at && at.fp === r.fp && at.head === r.head ? "ok" : "hidden";
    await db.prepare("UPDATE mention_receipts SET state = ?, checked_at = ? WHERE fp = ?").bind(state, now(), r.fp).run();
    if (state === "hidden") {
      const said = await db.prepare("SELECT actor, target FROM notices WHERE kind = 'mention' AND fp = ?").bind(r.fp).first();
      await keepNotice(db, { kind: "hidden", fp: String(r.fp), group: Number(group.id), item, target: said ? String(said.target) : item,
        actor: said?.actor ? String(said.actor) : "Someone", text: null });
    }
  }
}

/**
 * Asks the host (`connection`) for each post a receipt here is about, and checks its list shows that comment where the
 * receipt says it took it, with the same running fingerprint: "ok". Otherwise it's "hidden", and the owner here is told
 * that the host isn't showing them what it told the writer it took. One receipt (`only`), or those not yet checked.
 */
export async function checkReceipts(env, from, connection, only = null) {
  const db = env.DB;
  const { results } = only
    ? await db.prepare("SELECT * FROM mention_receipts WHERE fp = ?").bind(only).all()
    : await db.prepare("SELECT * FROM mention_receipts WHERE connection_id = ? AND state = 'unchecked' AND created_at > ? ORDER BY created_at LIMIT 3")
      .bind(connection.id, now() - CHECK_SECONDS).all();
  const threads = new Map();
  for (const r of results) {
    const item = String(r.item);
    if (!threads.has(item)) threads.set(item, await friendThread(env, from, connection, item));
    const thread = threads.get(item);
    // The host away (or refusing the owner here: that's for its own notices): asked again later.
    if (thread.error) continue;
    const at = thread.entries.find((e) => e.n === Number(r.n));
    const state = at && at.fp === r.fp && at.head === r.head ? "ok" : "hidden";
    await db.prepare("UPDATE mention_receipts SET state = ?, checked_at = ? WHERE fp = ?").bind(state, now(), r.fp).run();
    if (state === "hidden") {
      const said = await db.prepare("SELECT actor, target FROM notices WHERE kind = 'mention' AND fp = ?").bind(r.fp).first();
      await keepNotice(db, { kind: "hidden", fp: String(r.fp), connection: connection.id, item, target: said ? String(said.target) : item,
        actor: said?.actor ? String(said.actor) : "Someone", text: null });
    }
  }
}
