// Friends' signed posts, as this site sees them (afterwrd 2, step 4b: docs/signed-conversations.md):
// - copies: their posts kept here for Home, asked for with `since` (friendhost.js), each post's first record checked
//   against their identity as it arrives (pullItems);
// - a post opened: its whole list read from their site and checked (checkList), with markers for what was deleted,
//   removed, or left out, and a notice if their site has changed what this site checked before (friendThread);
// - commenting on it: signed in the browser, passed on by this site in a signed call, and kept in `sent` with the host's
//   receipt (relayRecord):
//     POST /_admin/friend/<connection>/items/<id>/records   form: sent (JSON), back
import { rateWindow } from "./limits.js";
import { firstChanged, fitToKeep, keepThread, keptThread, withNew } from "./threads.js";
import { busyUntil, callFriend, friendPerson, switchConnection } from "./calls.js";
import { fetchIdentity, identityState, learnIdentity, parseChain, checkProfile } from "./identities.js";
import { ownMove } from "./keys.js";
import { checkReceipts, queueReceipts } from "./receipts.js";
import { compareMine, compareThread, keepSent, TAKEN_SQL, willRetry } from "./sentchecks.js";
import { checkRecord } from "./records.js";
import { checkHead, checkList } from "./lists.js";
import { DATE_RE, parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { itemFromList, namesFor, ownHost, shownMentions } from "./items.js";
import { friendsAmong, peopleShown } from "./names.js";
import { eventShown, pollShown, pollTrouble } from "./itemkinds.js";
import { ANSWERS, cleanEvent, hasDate } from "./calendar.js";
import { safeNext } from "./auth.js";
import { messagePage } from "./views/pages.js";
import { html, now } from "./util.js";

export const PULL_SECONDS = 3600; // how often a friend's site is asked (docs/signed-conversations.md decision 12)
// A friend's site that hasn't answered for a day (or says this site isn't connected) stops being mentioned on Home,
// and Friends says so instead, with a way to remove them (views/friends.js). It's still asked, once an hour.
export const QUIET_SECONDS = 86_400;
const PAGES = 3;
const FOLLOW_SECONDS = 14 * 86400;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Lookups for checking records from a friend's site: identities as known here; browser keys as `delegations` says. */
/** JSON from base64url (a signed record's content), or null. */
const fromB64json = (text) => { try { return JSON.parse(new TextDecoder().decode(fromB64url(text))); } catch { return null; } };

export const lookupsWith = (env, delegations) => ({
  identityOf: (person) => identityState(env, person),
  delegationOf: async (key) => delegations?.[key] ?? null,
});

/** @type {(db: D1Database, id: unknown) => Promise<Row<"connections"> | null>} */
export const connectionById = (db, id) => db.prepare("SELECT * FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL")
  .bind(Number(id) || 0).first();

/**
 * Remembers a friend's profile picture link (and when it stops working), from what their site just sent.
 * @param {D1Database} db
 * @param {Row<"connections">} connection
 * @param {{ thumbSrc?: string } | null | undefined} avatar
 */
export function rememberPicture(db, connection, avatar) {
  const exp = Number(/[?&]exp=(\d+)/.exec(avatar?.thumbSrc ?? "")?.[1]) || null;
  if (!exp || connection.avatar_url === avatar.thumbSrc) return null;
  connection.avatar_url = avatar.thumbSrc;
  connection.avatar_exp = exp;
  return db.prepare("UPDATE connections SET avatar_url = ?, avatar_exp = ? WHERE id = ?").bind(avatar.thumbSrc, exp, connection.id);
}

/**
 * Whether the owner here asked to be friends and is still waiting for them to approve: their site has been asked, is
 * there, and has never shared anything (noteAnswer). Home says so, and asks their site each time it opens (pullNew).
 */
export const waitingFor = (c) => Boolean(c.items_checked_at && !c.reached_at && !c.missing_since && !c.said_no);

/** Whether a friend's site has gone quiet, or says this site isn't connected any more: shown on Friends, not Home. */
export const gone = (c, at = now()) => Boolean(c.said_no || (c.missing_since && c.missing_since <= at - QUIET_SECONDS));

/**
 * Notes how a friend's site just answered (`error`: what callFriend threw, if anything) on `connection` itself, and
 * returns the statement that keeps it. 401 means their site doesn't know this one (calls.js friendCalling): they
 * removed the owner here. 403 means their owner hasn't approved the owner here yet: their site is there, so it isn't
 * missing (waitingFor). Any other error (or none reaching it: status 0) is their site not answering.
 * @param {D1Database} db
 * @param {Row<"connections">} connection
 * @param {any} [error]
 * @param {number} [at]
 */
export function noteAnswer(db, connection, error = null, at = now()) {
  // 409 and 410 are a site that's there, mid-move: they've moved (410), or this site isn't recognised at its new address
  // yet (409). 429 is a site that's there, saying this one has had its allowance there today (allowances.js). Not missing.
  Object.assign(connection, !error ? { reached_at: at, missing_since: null, said_no: 0 }
    : [403, 409, 410, 429].includes(error.status) ? { missing_since: null, said_no: 0 }
    : { missing_since: connection.missing_since ?? at, said_no: error.status === 401 ? 1 : 0 });
  return db.prepare("UPDATE connections SET reached_at = ?, missing_since = ?, said_no = ? WHERE id = ?")
    .bind(connection.reached_at ?? null, connection.missing_since, connection.said_no, connection.id);
}

/**
 * Asks a friend's site for the posts that changed since this site last asked, and keeps them, each post's first record
 * checked against their identity (it must be theirs, on their site). Returns how many came, or null if their site
 * couldn't be asked (not set up for signed posts yet, or away). Either way it's noted when it was asked, so a site
 * that's away isn't asked again for an hour (Home doesn't wait for it), and whether it answered (noteAnswer). A site
 * that says it doesn't know this one any more (they removed the owner here) has its posts forgotten at once.
 */
export async function pullItems(env, from, connection) {
  const failed = async (error) => {
    // Moved here in the last fortnight: a friend's site that doesn't know this address yet hasn't followed yet (it
    // waits its own 7 days from when it heard: calls.js). That's "not yet", not having been removed.
    if (error.status === 401) {
      const moved = await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1 AND moving_to = ? AND moving_at > ?").bind(from, now() - FOLLOW_SECONDS).first();
      if (moved) error = { status: 409 };
    }
    // Asked again in an hour; or, if their site says this one has had its allowance there today, once the day's over.
    const busy = busyUntil(error);
    await env.DB.batch([
      noteAnswer(env.DB, connection, error),
      env.DB.prepare("UPDATE connections SET items_checked_at = ? WHERE id = ?").bind(busy ? Math.max(now(), busy - rateWindow(PULL_SECONDS)) : now(), connection.id),
      ...(error.status === 401 ? [env.DB.prepare("DELETE FROM copies WHERE connection_id = ?").bind(connection.id)] : []),
    ]);
    return null;
  };
  const person = await friendPerson(env, connection);
  if (!person) return failed({ status: 0 });
  // A friend who has moved (their identity says so, in effect here): asked at their new address from now on.
  const known = await env.DB.prepare("SELECT json_array_length(chain) AS n, moving_to, moving_at FROM identities WHERE person = ?").bind(person).first();
  if (known?.moving_to && known.moving_to !== connection.origin && Number(known.moving_at) <= now()) await followMove(env, connection, person);
  let since = Number(connection.items_since ?? 0);
  let count = 0;
  for (let page = 0; page < PAGES; page++) {
    let data;
    try {
      data = await callFriend(env, from, String(connection.origin), `/_p/items?since=${since}`);
    } catch (error) {
      // Their site says they've moved: learn where from their identity there, and switch once it's in effect here.
      if (error.status === 410 && page === 0) {
        await fetchIdentity(env, String(connection.origin)).catch(() => null);
        if (await followMove(env, connection, person)) return pullItems(env, from, connection);
      }
      if (page === 0) return failed(error);
      return count;
    }
    // Their identity has changed since this site last read it (a new device, a move under way): read it again.
    if (page === 0 && Number.isSafeInteger(data.identity) && data.identity > Number(known?.n ?? 0)) {
      await fetchIdentity(env, String(connection.origin)).catch(() => null);
    }
    // Anything signed as the owner here that this site never sent (sentchecks.js).
    if (page === 0) await compareMine(env, { connection }, data.mine).catch(() => null);
    // Their signed name now (a rename shows on Friends: names.js).
    if (page === 0 && data.profile) {
      const state = await identityState(env, person);
      if (state && (await checkProfile(data.profile, state))) {
        await env.DB.prepare("UPDATE identities SET profile = ? WHERE person = ?").bind(JSON.stringify(data.profile), person).run();
      }
    }
    const statements = [noteAnswer(env.DB, connection)];
    for (const item of Array.isArray(data.items) ? data.items : []) {
      const kept = await keepItem(env, connection, person, item, data.delegations);
      if (!kept) continue;
      statements.push(kept.statement);
      count++;
    }
    for (const id of Array.isArray(data.gone) ? data.gone : []) {
      if (ID_RE.test(id)) statements.push(env.DB.prepare("DELETE FROM copies WHERE id = ? AND connection_id = ?").bind(id, connection.id));
    }
    since = Number.isSafeInteger(data.until) ? Math.max(since, data.until) : since;
    statements.push(env.DB.prepare("UPDATE connections SET items_since = ?, items_checked_at = ? WHERE id = ?").bind(since, now(), connection.id));
    await env.DB.batch(statements);
    if (!data.more) break;
  }
  // Mention receipts its site couldn't be asked about before (receipts.js): it's answering now.
  await checkReceipts(env, from, connection).catch(() => null);
  return count;
}

/**
 * A friend's post as their site sent it (`/_p/items?since`, or a new-post note: notes.js), checked: its first record
 * must be theirs (`person`), on their own site, and be what its id says. Returns {statement (keeping the copy), record,
 * content} or null.
 */
export function keepItem(env, connection, person, item, delegations) {
  return keepCopy(env, { connection: Number(connection.id), host: person, author: person }, item, delegations);
}

/**
 * A post as its host sent it, checked, for keeping as a copy here: a friend's (`connection`: on their own site, by them),
 * or a group's (`group`: on the group's site, `host`, by any of its members). Neither site is the writer's browser, so
 * a post is worked out from what's signed (signedNow), not from what its host says it says; `rules` ({owner, admins})
 * say who may call off someone's event in a group. Returns {statement (keeping it), record, content} or null.
 */
export async function keepCopy(env, { connection = null, group = null, host, author = null, rules = null }, item, delegations) {
  if (!ID_RE.test(item?.id ?? "")) return null;
  const got = await checkRecord(item.sent, { ...lookupsWith(env, delegations), at: Number(item.taken) });
  if (!got || got.fp !== item.id || got.record.kind !== "item" || got.record.host !== host || (author && got.record.author !== author)) return null;
  // Its words and details as its signed records make them, never as its host says: a friend's site isn't its writer's
  // browser either, and could be taken over or run by a bad release (section 10).
  item = { ...item, ...(await signedNow(env, got, item, delegations, { host, rules })) };
  // A poll is as its signed first record asked it; an event is as its site says it is now (its changes are signed
  // records too, checked when they're sent as notes or its thread is opened), and only if its first record said it's
  // one: for those invited, from a friend; for every member, in a group.
  const isEvent = got.content?.type === "event" && (group ? !got.record.audience : Boolean(got.record.audience));
  // In a group, an event may repeat (step 6d), with the dates called off as their signed calloffs say (signedNow).
  const event = isEvent ? cleanEvent(stripCancelled(item.content?.event), { repeats: Boolean(group) }) : null;
  const skipped = group && event?.rrule && Array.isArray(item.content.event.skipped)
    ? item.content.event.skipped.filter((d) => typeof d === "string" && hasDate(event, d)).slice(0, 60) : [];
  const content = { text: typeof item.content?.text === "string" ? item.content.text.slice(0, 5000) : "",
    photos: (Array.isArray(item.content?.photos) ? item.content.photos : []).slice(0, 20).filter((p) => /^https?:\/\//.test(p?.src ?? "")),
    ...(Array.isArray(got.content?.mentions) && { mentions: shownMentions(got.record, got.content) }),
    ...(group && got.content?.here === true && { here: true }),
    ...(got.content?.poll && !pollTrouble(got.content.poll, Number(item.taken)) && { poll: got.content.poll }),
    ...(event && { type: "event", event: { ...event, ...(event.cancelled && Number.isSafeInteger(item.content.event.cancelled_at) ? { cancelled_at: item.content.event.cancelled_at } : {}),
      ...(skipped.length && { skipped }) } }),
    // What a vote or answer names now (the item, or the owner's latest change that moved their event).
    ...(ID_RE.test(item.version ?? "") && { version: item.version }) };
  if (got.content?.type === "event" && !event) return null;
  const tally = cleanTally(item.tally);
  const list = Number.isSafeInteger(item.list?.n) && item.list.n >= 1 && ID_RE.test(item.list.head ?? "") ? item.list : null;
  // Kept only for where it came from: a copy is never moved from one friend or group to another.
  const statement = env.DB.prepare(`INSERT INTO copies (id, connection_id, group_id, author, record, content, earlier, edited_at, comments, created_at,
    changed_at, tally, list_n, list_head)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, earlier = excluded.earlier,
    edited_at = excluded.edited_at, comments = excluded.comments, changed_at = excluded.changed_at, tally = excluded.tally,
    list_n = excluded.list_n, list_head = excluded.list_head
    WHERE copies.connection_id IS excluded.connection_id AND copies.group_id IS excluded.group_id`)
    .bind(item.id, connection, group, got.record.author, JSON.stringify(item.sent), JSON.stringify(content), JSON.stringify(Array.isArray(item.earlier) ? item.earlier.slice(0, 20) : []),
      Number.isSafeInteger(item.edited_at) ? item.edited_at : null, item.comments > 0 ? 1 : 0, Number(item.taken), Number(item.changed_at) || now(),
      tally ? JSON.stringify(tally) : null, list?.n ?? null, list?.head ?? null);
  return { statement, record: got.record, content };
}

/**
 * A post as its signed records say it is now (afterwrd 2, step 6c; friends' since step 9a): its first record, then those
 * its host sent with it (`item.records`: its writer's edits and changes, and in a group an admin calling it off), each
 * checked, worked out as its host works it out (items.js itemFromList). Returns what replaces the host's own word:
 * {content (its words, photos with the host's links to them, event), earlier, edited_at}.
 */
async function signedNow(env, got, item, delegations, { host, rules }) {
  const entries = [{ n: 1, fp: got.fp, taken: Number(item.taken), sent: item.sent }];
  for (const x of Array.isArray(item.records) ? item.records.slice(0, 60) : []) {
    if (!Number.isSafeInteger(x?.taken)) continue;
    const r = await checkRecord(x.sent, { ...lookupsWith(env, delegations), at: x.taken });
    if (!r || r.record.item !== item.id || r.record.host !== host) continue;
    // One date of a repeating event called off (step 6d, from that date's list): by the event's writer too.
    if (r.record.date !== undefined && (r.record.kind !== "calloff" || x.date !== r.record.date)) continue;
    const runs = rules && (r.record.author === rules.owner || rules.admins.has(r.record.author));
    if (r.record.kind === "calloff" ? !(runs || (r.record.date && r.record.author === got.record.author)) : r.record.author !== got.record.author) continue;
    entries.push({ n: entries.length + 1, fp: r.fp, taken: x.taken, sent: x.sent });
  }
  const worked = itemFromList(item.id, { author: got.record.author, content: "{}", audience: "group" }, entries, null);
  const now_ = JSON.parse(worked.content);
  // Its photos as signed, each with the group's link to its file, if the group sent one for that very photo.
  const links = new Map((Array.isArray(item.content?.photos) ? item.content.photos : []).map((p) => [p?.item, p]));
  const photos = (Array.isArray(now_.photos) ? now_.photos : []).flatMap((p) => {
    const l = links.get(p.item);
    return l && l.hash === p.hash && l.thumb_hash === p.thumb_hash ? [{ ...p, src: l.src, thumbSrc: l.thumbSrc }] : [];
  });
  return { content: { ...now_, photos }, earlier: worked.earlier ? JSON.parse(worked.earlier) : [], edited_at: worked.edited_at };
}

/**
 * An event's details as a host sends them, without what cleanEvent doesn't take (when it was called off, and by whom,
 * and a repeating one's dates called off).
 */
export const stripCancelled = (e) => (e && typeof e === "object" ? Object.fromEntries(Object.entries(e).filter(([k]) => !["cancelled_at", "called_off_by", "skipped"].includes(k))) : null);

const MAX_TALLY = 2000; // people in one poll's or event's totals
/**
 * A host's totals for a poll ({votes: {person: choices}, ended_at}) or an event ({answers: {person: {answer, version}},
 * invited}), kept only in that shape. They're the host's word until the thread is opened and counted again.
 */
export function cleanTally(t) {
  if (!t || typeof t !== "object") return null;
  const entries = (o) => (o && typeof o === "object" ? Object.entries(o).slice(0, MAX_TALLY).filter(([p]) => ID_RE.test(p)) : []);
  if (t.votes) {
    return { votes: Object.fromEntries(entries(t.votes).filter(([, m]) => Number.isSafeInteger(m) && m > 0 && m < 1024)),
      ended_at: Number.isSafeInteger(t.ended_at) ? t.ended_at : null };
  }
  if (t.answers) {
    const answers = (o) => Object.fromEntries(entries(o).filter(([, a]) => ANSWERS.includes(a?.answer))
      .map(([p, a]) => [p, { answer: a.answer, version: ID_RE.test(a.version ?? "") ? a.version : null }]));
    // A repeating event's (a group's, step 6d): each date's answers, whether it's off, and where its list is up to.
    const dates = t.dates && typeof t.dates === "object" ? Object.fromEntries(Object.entries(t.dates).slice(0, 60)
      .filter(([d, x]) => DATE_RE.test(d) && x && typeof x === "object")
      .map(([d, x]) => [d, { answers: answers(x.answers), off: x.off && ID_RE.test(x.off.by ?? "") && Number.isSafeInteger(x.off.at) ? { by: x.off.by, at: x.off.at } : null,
        list: Number.isSafeInteger(x.list?.n) && x.list.n >= 1 && ID_RE.test(x.list.head ?? "") ? { n: x.list.n, head: x.list.head } : null }])) : null;
    return { answers: answers(t.answers), ...(dates && { dates }),
      invited: Number.isSafeInteger(t.invited) && t.invited >= 0 && t.invited <= 10_000 ? t.invited : null };
  }
  return null;
}

/** Switches `connection` to where `person`'s identity says they are now, if that's in effect here; returns whether it did. */
async function followMove(env, connection, person) {
  const state = await identityState(env, person);
  if (!state || state.frozen || state.problem || state.current.origin === connection.origin) return false;
  return switchConnection(env, connection, state.current.origin);
}

/** Asks every friend's site not asked in the last hour (in the background, from Home). */
export async function pullFriends(env, from) {
  if ((await ownMove(env.DB, from))?.done) return; // moved away: this site only says where (calls.js)
  const { results } = await env.DB.prepare(`SELECT * FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND COALESCE(items_checked_at, 0) < ? ORDER BY COALESCE(items_checked_at, 0) LIMIT 40`).bind(now() - rateWindow(PULL_SECONDS)).all();
  await Promise.all(results.map((c) => pullItems(env, from, c).catch(() => null)));
}

/**
 * Asks, while Home waits, the sites of friends whose posts this site has never had: never asked, or not yet approving
 * the owner here (waitingFor), so their posts show as soon as they do. For at most `ms`: everyone else is asked after
 * the page has gone (pullFriends).
 */
export async function pullNew(env, from, ms = 4000) {
  if ((await ownMove(env.DB, from))?.done) return;
  const { results } = await env.DB.prepare(`SELECT * FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND (items_checked_at IS NULL OR (reached_at IS NULL AND missing_since IS NULL AND said_no = 0)) LIMIT 10`).all();
  if (!results.length) return;
  await Promise.race([Promise.all(results.map((c) => pullItems(env, from, c).catch(() => null))), new Promise((r) => setTimeout(r, ms))]);
}

/** Friends' posts kept here, newest first, with who they're from. */
export async function friendItems(db, { limit = 100, connection = null } = {}) {
  const { results } = await db.prepare(`SELECT c.*, k.name, k.origin, k.avatar_url FROM copies c JOIN connections k ON k.id = c.connection_id
    WHERE k.approved_at IS NOT NULL ${connection ? "AND c.connection_id = ?" : ""} ORDER BY c.created_at DESC LIMIT ?`)
    .bind(...(connection ? [connection, limit] : [limit])).all();
  return copiesShown(db, results);
}

/** Friends' events kept here (copies), as pages show them: for the calendar and invitations (Events). */
export async function friendEvents(db) {
  const { results } = await db.prepare(`SELECT c.*, k.name, k.origin, k.avatar_url FROM copies c JOIN connections k ON k.id = c.connection_id
    WHERE k.approved_at IS NOT NULL AND json_extract(c.content, '$.type') = 'event' ORDER BY c.created_at DESC LIMIT 500`).all();
  return copiesShown(db, results);
}

export async function friendItem(db, connection, id) {
  const row = await db.prepare(`SELECT c.*, k.name, k.origin, k.avatar_url FROM copies c JOIN connections k ON k.id = c.connection_id
    WHERE c.id = ? AND c.connection_id = ?`).bind(id, connection).first();
  return row ? (await copiesShown(db, [row]))[0] : null;
}

/** Copies as pages show them, with their polls and events, voters and guests named as the owner here knows them. */
async function copiesShown(db, rows) {
  const people = rows.flatMap((r) => {
    const t = r.tally ? JSON.parse(String(r.tally)) : null;
    return Object.keys(t?.votes ?? t?.answers ?? {});
  });
  const [names, me, mine, known] = await Promise.all([namesFor(db, people), db.prepare("SELECT person FROM own_identity WHERE id = 1").first(),
    // The owner's newest record on each (what their next one follows: lists.js prev).
    rows.length ? db.prepare(`SELECT item, fp FROM sent WHERE item IN (SELECT value FROM json_each(?)) AND ${TAKEN_SQL} ORDER BY created_at, rowid`)
      .bind(JSON.stringify(rows.map((r) => String(r.id)))).all() : { results: [] }, friendsAmong(db, people)]);
  const last = new Map(mine.results.map((r) => [String(r.item), String(r.fp)]));
  return rows.map((r) => ({ ...copyFromRow(r, { names, me: me ? String(me.person) : null, known }),
    list: r.list_n && me ? { host: String(r.author), me: String(me.person), seen: { n: Number(r.list_n), h: String(r.list_head) },
      mine: last.get(String(r.id)) ?? null } : null }));
}

export function copyFromRow(r, { names = new Map(), me = null, known = null } = {}) {
  const content = JSON.parse(String(r.content));
  const tally = r.tally ? JSON.parse(String(r.tally)) : null;
  for (const [p] of Object.entries(tally?.answers ?? {})) if (p === String(r.author)) names.set(p, String(r.name));
  return { id: String(r.id), connection: { id: Number(r.connection_id), name: String(r.name), origin: String(r.origin),
    avatar: r.avatar_url ? { thumbSrc: String(r.avatar_url) } : null },
    version: content.version ?? String(r.id), tally,
    poll: content.poll ? pollShown(content.poll, tally, { viewer: me, names, me, known }) : null,
    event: content.event ? eventShown(content, tally, { viewer: me, names, me, version: content.version ?? null, invited: tally?.invited ?? null, known }) : null,
    author: String(r.author), text: content.text ?? "", photos: content.photos ?? [], mentions: Array.isArray(content.mentions) ? content.mentions : [],
    here: content.here === true, earlier: r.earlier ? JSON.parse(String(r.earlier)) : [],
    edited_at: r.edited_at ? Number(r.edited_at) : null, comments: Number(r.comments), created_at: Number(r.created_at),
    checked: r.checked_n ? { n: Number(r.checked_n), head: String(r.checked_head) } : null };
}

/**
 * A friend's post opened: its list read from their site and checked. Returns {entries (as lists.js checkList shows
 * them, with each comment's writer's name), problem, changed, seen, mine}, or {error}.
 */
export async function friendThread(env, from, connection, id) {
  const db = env.DB;
  const person = await friendPerson(env, connection);
  if (!person) return { error: "Their site doesn't take signed comments yet." };
  const copy = await db.prepare("SELECT author, checked_n, checked_head FROM copies WHERE id = ?").bind(id).first();
  // What this site checked before, kept (threads.js): then only what's after it is asked for, and checked from there.
  const kept = copy?.checked_n ? await keptThread(db, id, Number(copy.checked_n), String(copy.checked_head)) : null;
  const askedAt = now();
  const fetchList = async (after) => {
    try { return await callFriend(env, from, String(connection.origin), after ? `/_p/items/${id}?after=${after}` : `/_p/items/${id}`); } catch (error) {
      return { error: busyUntil(error) ? `${connection.name}'s site has had a lot of requests from you today. Try tomorrow.` : error.message };
    }
  };
  let data = await fetchList(kept ? Number(copy.checked_n) : 0);
  if (data.error && typeof data.error === "string" && !Array.isArray(data.entries)) return { error: data.error };
  // Everyone in it: their identities as their site passed them on (each checked as it's learnt), and their names.
  const names = new Map();
  const me = await ownHost(env);
  const learn = async (people) => {
    for (const [p, info] of Object.entries(people ?? {})) {
      if (!ID_RE.test(p)) continue;
      const chain = parseChain(info?.chain);
      const state = chain && (await learnIdentity(env, chain));
      if (!state || state.id !== p) continue;
      const profile = info.profile && (await checkProfile(info.profile, state));
      if (profile) {
        names.set(p, profile.name);
        // Kept, so pages elsewhere (a poll's voters, an event's guests) can name them too.
        await db.prepare("UPDATE identities SET profile = ? WHERE person = ?").bind(JSON.stringify(info.profile), p).run();
      }
    }
  };
  await learn(data.people);
  const hostState = await identityState(env, person);
  if (!hostState) return { error: "Their site's identity couldn't be checked." };
  const check = (entries, from) => checkList({ host: person, hostingKey: hostState.current.hosting, list: id, owner: copy ? String(copy.author) : String(data.owner ?? person),
    entries, signedHead: data.signedHead, from, lookups: lookupsWith(env, data.delegations) });
  let result = null;
  let changed = false;
  if (kept) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const next = await check(entries, { n: Number(copy.checked_n), head: String(copy.checked_head) });
    if (!next.problem) {
      const heads = new Map(entries.map((e) => [e.n, e.head]));
      const fresh = next.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null }));
      result = { entries: withNew(kept, fresh), problem: null };
      if (fresh.length && fitToKeep(fresh)) await keepThread(db, id, result.entries, firstChanged(result.entries, fresh));
      else if (fresh.length) await db.prepare("DELETE FROM thread_cache WHERE list = ?").bind(id).run(); // read whole next time
    } else {
      // Doesn't follow on from where this site got to: the whole conversation, as before, to show what it is now.
      data = await fetchList(0);
      if (data.error && !Array.isArray(data.entries)) return { error: data.error };
      await learn(data.people);
    }
  }
  if (!result) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const from0 = data.checkpoint && (await checkHead(data.checkpoint, { hostingKey: hostState.current.hosting, host: person, list: id }));
    const whole = await check(entries, from0 ? { n: from0.n, head: from0.head } : null);
    // What this site checked before must still be there.
    const before = copy?.checked_n ? entries.find((e) => e.n === Number(copy.checked_n)) : null;
    changed = Boolean(copy?.checked_n && (!before || before.head !== copy.checked_head));
    const heads = new Map(entries.map((e) => [e.n, e.head]));
    result = { entries: whole.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null })), problem: whole.problem };
    if (copy && !whole.problem && !changed && result.entries.length && fitToKeep(result.entries)) await keepThread(db, id, result.entries);
  }
  names.set(person, String(connection.name));
  const last = result.entries.at(-1);
  if (copy && !result.problem && !changed && last && last.n !== Number(copy.checked_n ?? 0)) {
    await db.prepare("UPDATE copies SET checked_n = ?, checked_head = ? WHERE id = ?").bind(last.n, last.head, id).run();
  }
  // What the owner here sent to it, compared with what their site shows (sentchecks.js).
  if (me && !result.problem) await compareThread(env, { where: { connection }, host: person, list: id, entries: result.entries, me: me.person, names, askedAt }).catch(() => null);
  const mine = [...result.entries].reverse().find((e) => e.record?.author === me?.person)?.fp ?? null;
  // Named as the owner here knows them (names.js): friends by the name they approved, others as "friend of Ann".
  const shown = await peopleShown(db, result.entries.map((e) => e.by), { signed: names, friendHost: { person, name: String(connection.name) }, me: me?.person ?? null });
  return { entries: result.entries.map((e) => ({ ...e, name: e.by ? shown.names.get(e.by) ?? names.get(e.by) ?? "Someone" : null,
    ...(e.by && shown.tags.get(e.by)) })), problem: result.problem, changed,
    seen: last ? { n: last.n, h: last.head } : null, mine, host: person };
}

/** POST /_admin/friend/<connection>/items/<id>/records: the owner's signed record, passed on to their friend's site. */
export async function relayRecord(request, env, url, connectionId, id) {
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
  const refused = (message) => html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), 400);
  let sent = null;
  try { sent = JSON.parse(String(form.get("sent") ?? "")); } catch {}
  if (!sent) return refused("This browser can't sign for you yet. Sign out and in again, or set it up in Your devices.");
  const connection = await env.DB.prepare("SELECT * FROM connections WHERE id = ? AND approved_at IS NOT NULL").bind(connectionId).first();
  const me = await ownHost(env);
  const record = typeof sent.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
  if (!connection || !me || !record || record.author !== me.person || record.item !== id) return refused("That didn't work. Try again.");
  // This site passes on only what its owner's browsers signed: the delegation behind it, kept here.
  const delegation = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(record.key, now()).first();
  if (!delegation) return refused("This browser can't sign for you any more. Sign out and sign in again.");
  // With the owner's signed name, so the host can name them to everyone else in the thread, friends of theirs or not.
  const own = await env.DB.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  let answer;
  try {
    answer = await callFriend(env, url.origin, String(connection.origin), "/_p/records",
      { body: { sent, delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
        ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) } });
  } catch (error) {
    // Kept if it may have been taken, or is a delete to send again (sentchecks.js).
    await keepSent(env, { record, sent, list: id, error });
    if (error.status === 409 && error.message === "duplicate") answer = {};
    else return refused(`Couldn't send it: ${error.message}.${willRetry(record)}`);
  }
  const fp = await keepSent(env, { record, sent, list: id, receipt: answer.receipt ?? null });
  // Those it mentions are sent the host's receipt too, from here (receipts.js).
  if (answer.receipt) await queueReceipts(env, url.origin, record, fp);
  // The owner's own vote or answer, in their copy's totals at once (their site's are fetched again soon anyway).
  if (record.kind === "vote" || record.kind === "answer") {
    const copy = await env.DB.prepare("SELECT content, tally FROM copies WHERE id = ? AND connection_id = ?").bind(id, connection.id).first();
    const content = sent.content ? fromB64json(sent.content) : null;
    if (copy && content) {
      const tally = JSON.parse(String(copy.tally ?? "null")) ?? (record.kind === "vote" ? { votes: {}, ended_at: null } : { answers: {} });
      if (record.kind === "vote") {
        const mask = (Array.isArray(content.choices) ? content.choices : []).reduce((m, i) => (Number.isInteger(i) && i >= 0 && i < 10 ? m | (1 << i) : m), 0);
        tally.votes ??= {};
        if (mask) tally.votes[me.person] = mask;
        else delete tally.votes[me.person];
      } else if (ANSWERS.includes(content.answer)) {
        tally.answers ??= {};
        tally.answers[me.person] = { answer: content.answer, version: record.version ?? null };
      }
      await env.DB.prepare("UPDATE copies SET tally = ? WHERE id = ? AND connection_id = ?").bind(JSON.stringify(tally), id, connection.id).run();
    }
  }
  // Its copy here no longer knows whether it has comments: ask again soon.
  await env.DB.prepare("UPDATE connections SET items_checked_at = 0 WHERE id = ?").bind(connection.id).run();
  back.hash = `fi${connection.id}-${id}`;
  return Response.redirect(back.href, 303);
}

