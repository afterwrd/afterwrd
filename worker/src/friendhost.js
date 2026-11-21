// What this site tells friends' sites about the owner's signed posts (afterwrd 2, step 4b: docs/signed-conversations.md),
// only in signed calls from friends' sites (calls.js friendCalling):
//   GET  /_p/items?since=<t>   the owner's posts changed since `t` (this site's clock), oldest change first, up to 50:
//                              each with its first record as signed, its words now, whether it has comments, its photos
//                              (with links to their files for this friend, as before), where its list is up to, and the
//                              delegations behind its records; the posts deleted since; and how long the owner's identity
//                              is, so a friend's site can tell when to read it again. "Nothing new" reads a row or three.
//   GET  /_p/items/<id>        one post's whole list, with the signed head, and the delegations, identity chains and
//                              signed profiles of everyone in it, so a reader can check comments from people it doesn't know.
//   POST /_p/records           {sent, delegation, profile?}: the calling site's owner's own signed record (a comment, an
//                              edit, a delete) on one of the owner's posts, with the delegation behind it, and their signed
//                              name (kept, to name them to others in the thread). Answers with the receipt.
//                              A comment tells the owner here, and those it's news to (notes.js).
// (And POST /_p/notes, a friend's site telling this one about something new: notes.js.)
import { friendCalling } from "./calls.js";
import { listEntries, readList } from "./hosted.js";
import { checkProfile, identityState } from "./identities.js";
import { checkDelegation } from "./identity.js";
import { ownHost, recordOn } from "./items.js";
import { signedFile } from "./share.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";
import { noticeOwn } from "./notes.js";

const PAGE = 50;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** The delegations behind records signed with `keys` (browser keys): the owner's own, or ones friends' sites sent. */
export async function delegationsFor(db, keys) {
  const list = [...new Set(keys)];
  if (!list.length) return {};
  const json = JSON.stringify(list);
  const [own, known] = await db.batch([
    db.prepare("SELECT key, bytes, proof FROM delegations WHERE key IN (SELECT value FROM json_each(?))").bind(json),
    db.prepare("SELECT key, bytes, proof FROM known_delegations WHERE key IN (SELECT value FROM json_each(?))").bind(json),
  ]);
  return Object.fromEntries([...own.results, ...known.results].map((r) => [String(r.key), { bytes: String(r.bytes), proof: JSON.parse(String(r.proof)) }]));
}

/** Identity chains and signed profiles of `people`: the owner's own, and those this site knows. */
export async function peopleFor(db, people) {
  const out = {};
  const own = await db.prepare("SELECT person, chain, profile FROM own_identity WHERE id = 1").first();
  const others = people.filter((p) => p !== own?.person);
  const { results } = others.length ? await db.prepare("SELECT person, chain, profile FROM identities WHERE person IN (SELECT value FROM json_each(?)) AND frozen_at IS NULL")
    .bind(JSON.stringify(others)).all() : { results: [] };
  for (const r of [...(own && people.includes(String(own.person)) ? [own] : []), ...results]) {
    out[String(r.person)] = { chain: JSON.parse(String(r.chain)), ...(r.profile ? { profile: JSON.parse(String(r.profile)) } : {}) };
  }
  return out;
}

/**
 * One of the owner's posts (an `items` row joined with its list's n and head, as list_n and list_head) as a friend's
 * site is sent it: its first record as signed, its words now, its photos with links to their files for that friend
 * (`connectionId`), and where its list is up to. Sent by `/_p/items?since` and in new-post notes (notes.js).
 */
export async function itemForFriend(env, origin, r, connectionId) {
  const [first] = await listEntries(env.DB, String(r.id));
  const content = JSON.parse(String(r.content));
  const photos = await Promise.all((content.photos ?? []).map(async (p) => ({ ...p,
    src: await signedFile(env, origin, p.hash, { friend: connectionId }), thumbSrc: await signedFile(env, origin, p.thumb_hash, { friend: connectionId }) })));
  // A poll's votes or an event's answers, as this site counts them (the reader counts again when it opens one), and how
  // many are invited to an event.
  const tally = r.tally ? JSON.parse(String(r.tally)) : null;
  const invited = r.audience === "invited"
    ? Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM item_guests WHERE item = ?").bind(String(r.id)).first())?.n ?? 0) : null;
  return { id: String(r.id), sent: first.sent, taken: first.taken, content: { ...content, photos },
    earlier: r.earlier ? JSON.parse(String(r.earlier)) : [], edited_at: r.edited_at, comments: Number(r.comments),
    changed_at: Number(r.changed_at), list: { n: Number(r.list_n), head: String(r.list_head) },
    ...(tally && { tally: { ...tally, ...(invited !== null && { invited }) } }), ...(r.version && { version: String(r.version) }) };
}

/** SQL: item `i` may be seen by friend ?1 (a connection id): everyone's, or an event they're invited to. */
const SEES = (i = "i") => `(${i}.audience = 'friends' OR EXISTS (SELECT 1 FROM item_guests g WHERE g.item = ${i}.id AND g.connection_id = ?1))`;

/** Whether friend `connectionId` may see item `id` (a post or photo here: a photo goes by the post it's in). */
export async function mayCallerSee(db, id, connectionId) {
  const row = await db.prepare(`SELECT 1 FROM items i WHERE i.id = COALESCE((SELECT post FROM item_photos WHERE photo = ?2), ?2) AND ${SEES()}`)
    .bind(connectionId, id).first();
  return Boolean(row);
}

export const keyOf = (sent) => parseRecord(fromB64url(sent.record))?.key;

export async function handleFriendItems(request, env, url, work) {
  const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
  const caller = await friendCalling(request, env, url, body);
  if (caller instanceof Response) return caller;
  const db = env.DB;
  if (request.method === "GET" && url.pathname === "/_p/items") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const { results } = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
      WHERE i.type = 'post' AND i.changed_at > ?2 AND ${SEES()} ORDER BY i.changed_at LIMIT ?3`).bind(caller.connection.id, since, PAGE + 1).all();
    const more = results.length > PAGE;
    const rows = results.slice(0, PAGE);
    // Deleted since, and events this friend's invitation to was taken back from (nobody else learns they exist).
    const { results: gone } = await db.prepare(`SELECT id FROM lists WHERE deleted_at > ?2
      UNION SELECT item FROM item_uninvited WHERE connection_id = ?1 AND at > ?2`).bind(caller.connection.id, since).all();
    const items = await Promise.all(rows.map((r) => itemForFriend(env, url.origin, r, caller.connection.id)));
    // Up to the last change sent, but never this second: something changing later this second would otherwise be
    // missed (times are to the second), so the next ask covers this second again (taking a copy twice is harmless).
    const until = more ? Number(rows.at(-1).changed_at) : Math.min(Number(rows.at(-1)?.changed_at ?? since), Math.max(since, now() - 1));
    // identity: how many documents the owner's identity has, so a friend's site whose copy is shorter (a new device, a
    // move under way) reads it again (friendcopies.js pullItems).
    const own = await db.prepare("SELECT json_array_length(chain) AS n FROM own_identity WHERE id = 1").first();
    return json({ v: 2, items, gone: gone.map((g) => String(g.id)), until, more, identity: Number(own?.n ?? 0),
      delegations: await delegationsFor(db, items.map((i) => keyOf(i.sent))) });
  }
  const one = /^\/_p\/items\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (request.method === "GET" && one) {
    if (!(await mayCallerSee(db, one[1], caller.connection.id))) return json({ error: "Not found." }, 404);
    const host = await ownHost(env);
    const list = host && (await readList(db, one[1], { host }));
    if (!list) return json({ error: "Not found." }, 404);
    if (list.deleted) return json({ error: "Deleted.", deleted: true }, 410);
    const records = list.entries.filter((e) => e.sent).map((e) => parseRecord(fromB64url(e.sent.record))).filter(Boolean);
    return json({ v: 2, owner: list.owner, entries: list.entries, signedHead: list.signedHead, checkpoint: list.checkpoint ?? null,
      delegations: await delegationsFor(db, records.map((r) => r.key)), people: await peopleFor(db, [...new Set(records.map((r) => r.author))]) });
  }
  if (request.method === "POST" && url.pathname === "/_p/records") {
    let sent = null, delegation = null, profile = null;
    try { ({ sent, delegation, profile = null } = JSON.parse(new TextDecoder().decode(body))); } catch {}
    const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
    if (!record || !ID_RE.test(record.item ?? "")) return json({ error: "That didn't work." }, 400);
    // A site passes on only its own owner's records, allowed by a delegation from their identity, on what they may see.
    if (record.author !== caller.person) return json({ error: "That isn't your site's to send." }, 403);
    if (!(await mayCallerSee(db, record.item, caller.connection.id))) return json({ error: "That post isn't here any more." }, 404);
    const state = await identityState(env, caller.person);
    const dBytes = typeof delegation?.bytes === "string" ? fromB64url(delegation.bytes) : null;
    if (!state || !dBytes || (await checkDelegation(dBytes, delegation.proof, state, now())) !== record.key) return json({ error: "That isn't signed by them." }, 400);
    const { expires } = JSON.parse(new TextDecoder().decode(dBytes));
    await db.prepare(`INSERT OR REPLACE INTO known_delegations (key, person, bytes, proof, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(record.key, caller.person, delegation.bytes, JSON.stringify(delegation.proof), expires).run();
    // Their signed name, kept to pass on with the thread (peopleFor), so others in it can name them.
    const named = profile && (await checkProfile(profile, state));
    if (named) await db.prepare("UPDATE identities SET profile = ? WHERE person = ?").bind(JSON.stringify(profile), caller.person).run();
    const host = await ownHost(env);
    const answer = await recordOn(env, host, record.item, sent, url.origin);
    if (answer.refused) return json({ error: answer.refused }, 409);
    if (answer.entry) await noticeOwn(env, url.origin, work, { item: record.item, record, content: answer.content, fp: answer.entry.fp, connection: caller.connection });
    return json({ ok: true, receipt: answer.receipt ?? null, n: answer.entry?.n ?? null });
  }
  return json({ error: "Not found." }, 404);
}
