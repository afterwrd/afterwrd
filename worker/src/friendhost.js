// What this site tells friends' sites about the owner's signed posts (afterwrd 2, step 4b: docs/signed-conversations.md),
// only in signed calls from friends' sites (calls.js friendCalling):
//   GET  /_p/items?since=<t>   the owner's posts changed since `t` (this site's clock), oldest change first, up to 50:
//                              each with its first record as signed, its words now, how many comments it has, its photos
//                              (with links to their files for this friend, as before), where its list is up to, and the
//                              delegations behind its records; the posts deleted since; and how long the owner's identity
//                              is, so a friend's site can tell when to read it again. "Nothing new" reads a row or three.
//   GET  /_p/items/<id>        one post's whole list, with the signed head, and the delegations, identity chains and
//                              signed profiles of everyone in it, so a reader can check comments from people it doesn't know.
//   POST /_p/records/check     what became of the caller's owner's records here (sentchecks.js answerCheck)
//   POST /_p/records           {sent, delegation, profile?}: the calling site's owner's own signed record (a comment, an
//                              edit, a delete) on one of the owner's posts, with the delegation behind it, and their signed
//                              name (kept, to name them to others in the thread). Answers with the receipt.
//                              A comment tells the owner here, and those it's news to (notes.js).
//   POST /_p/before            the calling site's owner's comments from before afterwrd 2 on posts brought over: where
//                              they are now, and then signed (before.js answerBefore).
// (And POST /_p/notes, a friend's site telling this one about something new: notes.js.)
import { isBlocked } from "./blocks.js";
import { friendCalling } from "./calls.js";
import { DAILY_RECORDS_SAID, listEntries, overDailyRecords, readList } from "./hosted.js";
import { checkProfile, identityState, keepNewerProfile } from "./identities.js";
import { ownHost, recordOn, sentDelegationOf } from "./items.js";
import { signedFile } from "./share.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";
import { noticeOwn } from "./notes.js";
import { answerCheck, mineSince } from "./sentchecks.js";
import { answerBefore, buildIfDue } from "./before.js";
import { tidyBefore } from "./clearout.js";

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
  // The owner's own last, so they're what's sent for the owner's keys.
  return Object.fromEntries([...known.results, ...own.results].map((r) => [String(r.key), { bytes: String(r.bytes), proof: JSON.parse(String(r.proof)) }]));
}

/**
 * Those of `keys` (delegations) and `people` (identities and profiles) that this site learnt, or saw change, after
 * `since` (its own clock): all a reader who asked before can be missing, found by when, not by listing every one (a
 * list of keys is read row by row: the scale run's group of 1,000 read about 2 million rows a day so). A little before
 * `since` too, as times are to the second. A reader missing an older one asks for it (POST /_p/people).
 * @param {D1Database} db @param {string[]} keys @param {string[]} people @param {number} since
 */
export async function learntSince(db, keys, people, since) {
  const [wantKeys, wantPeople] = [new Set(keys), new Set(people)];
  const from = since - 60;
  const [own, known, identities, self] = /** @type {D1Result<any>[]} */ (await db.batch([
    db.prepare("SELECT key, bytes, proof FROM delegations WHERE created_at > ?").bind(from),
    db.prepare("SELECT key, bytes, proof FROM known_delegations WHERE learnt_at > ?").bind(from),
    db.prepare("SELECT person, chain, profile FROM identities WHERE updated_at > ? AND frozen_at IS NULL").bind(from),
    db.prepare("SELECT person, chain, profile FROM own_identity WHERE id = 1"),
  ]));
  const delegations = Object.fromEntries([...known.results, ...own.results].filter((r) => wantKeys.has(String(r.key)))
    .map((r) => [String(r.key), { bytes: String(r.bytes), proof: JSON.parse(String(r.proof)) }]));
  const out = {};
  for (const r of [...identities.results, ...self.results.filter((o) => wantPeople.has(String(o.person)))]) {
    if (!wantPeople.has(String(r.person))) continue;
    out[String(r.person)] = { chain: JSON.parse(String(r.chain)), ...(r.profile ? { profile: JSON.parse(String(r.profile)) } : {}) };
  }
  return { delegations, people: out };
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
 * (`connectionId`), and where its list is up to. Sent by `/_p/items?since` and in new-post notes (notes.js). With it,
 * `records`: its writer's signed edits and changes, each with when it was taken, so the friend's site works out its
 * words and details from what's signed, not from this site's say-so (friendcopies.js keepCopy). A group's site adds
 * calling off (groupposts.js memberItem), and passes the list's `entries` when it has them already.
 */
export async function itemForFriend(env, origin, r, connectionId, entries = null) {
  const [first, ...rest] = entries ?? (await listEntries(env.DB, String(r.id)));
  const records = [];
  for (const e of rest) {
    const x = e.sent && parseRecord(fromB64url(e.sent.record));
    if (x && x.author === String(r.author) && ((x.kind === "edit" && x.about === String(r.id)) || x.kind === "change")) {
      records.push({ n: e.n, fp: e.fp, taken: e.taken, sent: e.sent });
    }
  }
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
    // Brought over from afterwrd 1 and waiting for its old comments: none new until then (before.js, hosted.js).
    ...(Number(r.before_until) > now() && { before_until: Number(r.before_until) }),
    ...(tally && { tally: { ...tally, ...(invited !== null && { invited }) } }), ...(r.version && { version: String(r.version) }), records };
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
    // Posts brought over from afterwrd 1 whose 30 days are up: their comments from before go in first (before.js), and
    // once the site's are, what's left from before is cleared out (clearout.js).
    await tidyBefore(env);
    const { results } = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
      WHERE i.type = 'post' AND i.changed_at > ?2 AND ${SEES()} ORDER BY i.changed_at LIMIT ?3`).bind(caller.connection.id, since, PAGE + 1).all();
    const more = results.length > PAGE;
    const rows = results.slice(0, PAGE);
    // Deleted since (an event only to those it was for), and events this friend's invitation to was taken back from, or
    // that were deleted while they were invited: nobody else learns they existed.
    const { results: gone } = await db.prepare(`SELECT id FROM lists WHERE deleted_at > ?2 AND invited = 0
      UNION SELECT item FROM item_uninvited WHERE connection_id = ?1 AND at > ?2`).bind(caller.connection.id, since).all();
    const items = await Promise.all(rows.map((r) => itemForFriend(env, url.origin, r, caller.connection.id)));
    // Up to the last change sent, but never this second: something changing later this second would otherwise be
    // missed (times are to the second), so the next ask covers this second again (taking a copy twice is harmless).
    const until = more ? Number(rows.at(-1).changed_at) : Math.min(Number(rows.at(-1)?.changed_at ?? since), Math.max(since, now() - 1));
    // identity: how many documents the owner's identity has, so a friend's site whose copy is shorter (a new device, a
    // move under way) reads it again (friendcopies.js pullItems).
    const own = await db.prepare("SELECT json_array_length(chain) AS n, profile FROM own_identity WHERE id = 1").first();
    // mine: the caller's owner's records taken here since, for their site to compare with what it sent (sentchecks.js).
    return json({ v: 2, items, gone: gone.map((g) => String(g.id)), until, more, identity: Number(own?.n ?? 0),
      delegations: await delegationsFor(db, items.flatMap((i) => [i.sent, ...i.records.map((x) => x.sent)]).map(keyOf)), mine: await mineSince(db, caller.person, since),
      // The owner's signed name now, so a friend's site can show a rename (names.js).
      ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) });
  }
  const one = /^\/_p\/items\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (request.method === "GET" && one) {
    if (!(await mayCallerSee(db, one[1], caller.connection.id))) return json({ error: "Not found." }, 404);
    await buildIfDue(env, one[1]);
    const host = await ownHost(env);
    // ?after=: a reader that checked up to there asks only for what's after (threads.js).
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    const list = host && (await readList(db, one[1], { host, after }));
    if (!list) return json({ error: "Not found." }, 404);
    if (list.deleted) return json({ error: "Deleted.", deleted: true }, 410);
    const records = list.entries.filter((e) => e.sent).map((e) => parseRecord(fromB64url(e.sent.record))).filter(Boolean);
    return json({ v: 2, owner: list.owner, entries: list.entries, signedHead: list.signedHead, checkpoint: list.checkpoint ?? null,
      delegations: await delegationsFor(db, records.map((r) => r.key)), people: await peopleFor(db, [...new Set(records.map((r) => r.author))]) });
  }
  if (request.method === "POST" && url.pathname === "/_p/records/check") {
    let asked = null;
    try { asked = JSON.parse(new TextDecoder().decode(body)); } catch {}
    const host = await ownHost(env);
    if (!host) return json({ error: "Not found." }, 404);
    const answer = await answerCheck(env, caller.person, asked, { host: host.person, mayRead: (id) => mayCallerSee(db, id, caller.connection.id) });
    return json(answer, answer.status ?? 200);
  }
  if (request.method === "POST" && url.pathname === "/_p/before") {
    let asked = null;
    try { asked = JSON.parse(new TextDecoder().decode(body)); } catch {}
    return answerBefore(env, caller, asked);
  }
  if (request.method === "POST" && url.pathname === "/_p/records") {
    let sent = null, delegation = null, profile = null;
    try { ({ sent, delegation, profile = null } = JSON.parse(new TextDecoder().decode(body))); } catch {}
    const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
    if (!record || !ID_RE.test(record.item ?? "")) return json({ error: "That didn't work." }, 400);
    // A site passes on only its own owner's records, allowed by a delegation from their identity, on what they may see.
    if (record.author !== caller.person) return json({ error: "That isn't your site's to send." }, 403);
    // Someone the owner's blocked (blocks.js): not taken, with no more said than any refusal.
    if (await isBlocked(db, caller.person)) return json({ error: "That wasn't taken." }, 409);
    if (!(await mayCallerSee(db, record.item, caller.connection.id))) return json({ error: "That post isn't here any more." }, 404);
    // At most so many a day from one writer, across all the owner's posts (hosted.js).
    if (await overDailyRecords(db, caller.person, String(record.kind))) return json({ error: DAILY_RECORDS_SAID }, 429);
    const allowed = await sentDelegationOf(env, caller.person, delegation, record.key);
    if (!allowed) return json({ error: "That isn't signed by them." }, 400);
    // Their signed name, kept to pass on with the thread (peopleFor), so others in it can name them.
    const state = await identityState(env, caller.person);
    const named = profile && state && (await checkProfile(profile, state));
    if (named) await keepNewerProfile(db, caller.person, profile, named.at);
    const host = await ownHost(env);
    const answer = await recordOn(env, host, record.item, sent, url.origin, { delegation: allowed });
    if (answer.refused) return json({ error: answer.refused }, 409);
    if (answer.entry) await noticeOwn(env, url.origin, work, { item: record.item, record, content: answer.content, fp: answer.entry.fp, connection: caller.connection });
    return json({ ok: true, receipt: answer.receipt ?? null, n: answer.entry?.n ?? null });
  }
  return json({ error: "Not found." }, 404);
}
