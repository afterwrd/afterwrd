// What became of what the owner sent (afterwrd 2, step 7: docs/signed-conversations.md, "7 in detail", section 7
// "Checking"). Every record the owner signs for somewhere else (a comment on a friend's post, a post or vote in a group,
// a group's members list) is kept in `sent`. Their site asks each host, in the background, what became of it: daily for
// a week, weekly for three months, then monthly, while they're friends or members. Anything removed, or gone with
// nothing signed saying why, is told in Notifications; a delete or leave the host hasn't taken is sent again at each
// round, and said on Home until it's taken. And anything signed as the owner that their site never sent (T6: a stolen
// key used elsewhere) is said on Home.
//
// A host answers (friendhost.js, groupposts.js):
//   POST /_p/records/check   {points: [{fp, list}…]} -> {results: [{fp, state, marker?}…], delegations, people, roles}:
//                            what became of each of the caller's records here, from the host's index (authored) and one
//                            page row of the list each. state: there, deleted, removed (each with the signed `marker` that
//                            did it), gone (the post's been deleted, or the caller can't see it any more), or missing. A
//                            group's `roles` prove its admins who removed something (their join and the owner's role).
// and each `GET /_p/items?since` also gives `mine`: the caller's records taken there since (mineSince).
// (`/_p/check-*` and `/_p/checked` are the checks of a site's code: checks.js, friendchecks.js.)
import { rateWindow } from "./limits.js";
import { callFriend } from "./calls.js";
import { delegationsFor, peopleFor } from "./friendhost.js";
import { checkProfile, identityState, learnIdentity, parseChain } from "./identities.js";
import { ID_RE, ownHost } from "./items.js";
import { listOf, PAGE, parseListId } from "./lists.js";
import { checkRecord } from "./records.js";
import { checkRoles } from "./groupcopies.js";
import { contentOf, parseRecord } from "../public/static/records.js";
import { decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { now } from "./util.js";

const MAX_POINTS = 200; // in one check (section 9)
const SITES_A_ROUND = 10;
const RESENDS_A_SITE = 20;
const RETRY_DAYS = 30; // a delete or leave the host hasn't taken is sent again for this long
const GRACE = 300; // a record of the owner's taken this recently may not be in `sent` yet (it's written after the answer)
const MINE_OVERLAP = 600; // `mine` reaches this far back before `since`, so a record taken just before isn't missed

/** SQL: a `sent` row the host has taken, as far as this site knows (what an owner's next record there may follow). */
export const TAKEN_SQL = "(state IS NULL OR state NOT IN ('unsure', 'waiting', 'stopped'))";

/**
 * A "day" of the schedule: shorter only on local test sites (TEST_SENT_SECONDS), so a test can see rounds go by, and
 * in a squeezed scale test (limits.js rateWindow), so its day has a day's checks.
 */
const dayOf = (env) => (env.ALLOW_LOCAL_SITES && Number(env.TEST_SENT_SECONDS) > 0 ? Number(env.TEST_SENT_SECONDS) : rateWindow(86400));
/** How often a round of checks may run: hourly, or as often as a day lets. */
const roundOf = (env) => Math.min(rateWindow(3600), dayOf(env));

/** When to ask about a record sent at `created` again, asked at `at`: daily for a week, weekly to 3 months, then monthly. */
export function nextAt(env, created, at) {
  const day = dayOf(env);
  const age = at - created;
  return at + (age < 7 * day ? day : age < 90 * day ? 7 * day : 30 * day);
}

// ---- The writer's side: keeping what was sent ----

/**
 * Keeps the owner's record as sent to its host: once the host has answered (`receipt`, perhaps null) or failed to
 * (`error`, as callFriend throws it). A delete or leave that didn't go through is kept to send again ('waiting'); any
 * other record the host plainly refused isn't kept (the owner was told, and its words are theirs to send again); one
 * with no answer at all is kept as 'unsure' (the host may have taken it: the next check finds out). `list`: the list
 * it's on (lists.js listOf, by default). Returns its fingerprint.
 */
export async function keepSent(env, { record, sent, list = null, receipt = null, error = null }) {
  const fp = await fingerprintOf("record", fromB64url(sent.record));
  list ??= listOf(record, fp);
  const again = error && error.status === 409 && error.message === "duplicate"; // taken before: a resend
  const retry = record.kind === "delete" || record.kind === "leave";
  if (error && !again && !retry && error.status >= 400 && error.status < 500) return fp;
  const state = !error || again ? null : retry ? "waiting" : "unsure";
  const at = now();
  await env.DB.prepare(`INSERT INTO sent (fp, host, item, kind, record, receipt, created_at, state, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fp) DO UPDATE SET receipt = COALESCE(excluded.receipt, sent.receipt), state = excluded.state, next_at = excluded.next_at`)
    .bind(fp, record.host, list, record.kind, JSON.stringify(sent), receipt ? JSON.stringify(receipt) : null, at, state,
      state === "waiting" ? at : at + dayOf(env)).run();
  return fp;
}

/** What a Refusal should say when a delete or leave didn't go through, and is kept to send again. */
export const willRetry = (record) => (record.kind === "delete" || record.kind === "leave"
  ? " Your site will keep asking, and Home says so until it's taken." : "");

// ---- The host's side ----

/**
 * The answer to `POST /_p/records/check` from `person` (the caller's owner): what became of each of their records
 * here. `mayRead(item)`: whether they may still see that item (a friend uninvited from an event may not). `rolesOf(people)`:
 * in a group, what shows those who removed something are admins (groupposts.js roleProofs).
 */
/** @param {any} env @param {string} person @param {any} body @param {{ host: string, mayRead?: (item: string) => Promise<boolean>, rolesOf?: (people: string[]) => Promise<Record<string, any>> }} options */
export async function answerCheck(env, person, body, { host, mayRead = async (_item) => true, rolesOf = async (_people) => ({}) }) {
  const db = env.DB;
  // More than a check may ask is refused, not cut short, so the asker never takes part of an answer for all of it (T31).
  if (Array.isArray(body?.points) && body.points.length > MAX_POINTS) return { error: `At most ${MAX_POINTS} at a time.`, status: 413 };
  const points = (Array.isArray(body?.points) ? body.points : [])
    .filter((p) => ID_RE.test(p?.fp ?? "") && typeof p.list === "string" && (ID_RE.test(p.list) || parseListId(p.list)));
  if (!points.length) return { results: [], delegations: {}, people: {} };
  const [indexRows, listRows] = await db.batch([
    db.prepare("SELECT fp, author, list, n FROM authored WHERE fp IN (SELECT value FROM json_each(?))").bind(JSON.stringify(points.map((p) => p.fp))),
    db.prepare("SELECT id, deleted_at FROM lists WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...new Set(points.map((p) => p.list))])),
  ]);
  const index = new Map(indexRows.results.map((r) => [String(r.fp), r]));
  const lists = new Map(listRows.results.map((r) => [String(r.id), r]));
  // The page rows needed: each record's, and each marker's.
  const pages = new Map(); // "list\npage" -> entries
  const pageOf = async (list, n) => {
    const key = `${list}\n${Math.floor((n - 1) / PAGE)}`;
    if (!pages.has(key)) {
      const row = await db.prepare("SELECT entries FROM list_pages WHERE list = ? AND page = ?").bind(list, Math.floor((n - 1) / PAGE)).first();
      pages.set(key, row ? JSON.parse(String(row.entries)) : []);
    }
    return pages.get(key);
  };
  const results = [];
  const markers = [];
  for (const p of points) {
    const l = lists.get(p.list);
    const i = index.get(p.fp);
    const item = parseListId(p.list)?.item ?? p.list;
    if (!l) { results.push({ fp: p.fp, state: "missing" }); continue; }
    if (l.deleted_at || !(await mayRead(item))) { results.push({ fp: p.fp, state: "gone" }); continue; }
    // Not here, somewhere else, or someone else's: missing, as far as the caller's told.
    if (!i || String(i.list) !== p.list || (i.author !== null && String(i.author) !== person)) { results.push({ fp: p.fp, state: "missing" }); continue; }
    const entry = (await pageOf(p.list, Number(i.n))).find((e) => e.n === Number(i.n));
    if (!entry || entry.fp !== p.fp) { results.push({ fp: p.fp, state: "missing" }); continue; }
    if (entry.sent) { results.push({ fp: p.fp, state: i.author === null ? "missing" : "there" }); continue; }
    // Emptied: by the delete or removal its entry names.
    const by = Number.isSafeInteger(entry.by_n) ? (await pageOf(p.list, entry.by_n)).find((e) => e.n === entry.by_n && e.fp === entry.by) : null;
    const record = by?.sent ? parseRecord(fromB64url(by.sent.record)) : null;
    if (!record || (record.kind !== "delete" && record.kind !== "remove") || record.about !== p.fp) { results.push({ fp: p.fp, state: "missing" }); continue; }
    results.push({ fp: p.fp, state: record.kind === "delete" ? "deleted" : "removed", marker: { sent: by.sent, taken: by.taken } });
    markers.push(record);
  }
  const removers = [...new Set(markers.filter((r) => r.kind === "remove" && r.author !== host).map((r) => r.author))];
  const roles = removers.length ? await rolesOf(removers) : {};
  const roleKeys = Object.values(roles).flatMap((p) => [p.join, p.role]).map((x) => parseRecord(fromB64url(x.record))?.key);
  return { results, delegations: await delegationsFor(db, [...markers.map((r) => r.key), ...roleKeys].filter(Boolean)),
    people: await peopleFor(db, [...new Set(markers.map((r) => r.author).filter((a) => a !== host))]), roles };
}

/** The caller's records taken here since `since` (this site's clock), for a pull's `mine` (T6). */
export async function mineSince(db, person, since) {
  const { results } = await db.prepare("SELECT fp, list, taken FROM authored WHERE author = ? AND taken >= ? ORDER BY taken LIMIT 200")
    .bind(person, Math.max(0, since - MINE_OVERLAP)).all();
  return { now: now(), records: results.map((r) => ({ fp: String(r.fp), list: String(r.list), taken: Number(r.taken) })) };
}

// ---- The writer's side: checking ----

/** Where a host is to this site: a friend ({connection}) or a group ({group}); null if neither now. */
async function whereIs(db, host) {
  const connection = await db.prepare("SELECT * FROM connections WHERE identity = ? AND approved_at IS NOT NULL AND connected_at IS NOT NULL").bind(host).first();
  if (connection) return { connection };
  const group = await db.prepare("SELECT * FROM groups WHERE identity = ? AND joined_at IS NOT NULL AND origin IS NOT NULL").bind(host).first();
  return group ? { group } : null;
}

/** The post a notice about `list` points at: a photo's post (from the copy here), one date of an event, or the post. */
async function targetOf(db, list) {
  const parsed = parseListId(list);
  if (parsed?.date) return { item: parsed.item, target: `${parsed.item}?date=${parsed.date}` };
  const post = await db.prepare(`SELECT c.id, (SELECT key FROM json_each(c.content, '$.photos') p WHERE json_extract(p.value, '$.item') = ?1) AS i
    FROM copies c WHERE EXISTS (SELECT 1 FROM json_each(c.content, '$.photos') p WHERE json_extract(p.value, '$.item') = ?1) LIMIT 1`).bind(list).first();
  return post ? { item: list, target: `${post.id}/photos/${Number(post.i) + 1}` } : { item: list, target: list };
}

/** The start of what the owner said in a record kept in `sent`, if it has words. */
async function wordsOf(row) {
  try {
    const sent = JSON.parse(String(row.record));
    const record = parseRecord(fromB64url(sent.record));
    const content = record && sent.content ? await contentOf(record, sent.content, sent.salt) : null;
    return typeof content?.text === "string" ? content.text.replace(/\s+/g, " ").trim().slice(0, 200) : null;
  } catch { return null; }
}

/** What a record is, for a notice: "comment", "post", "photo", "vote", "answer", "edit"… */
const aboutOf = (row) => (row.kind === "item" ? "post" : String(row.kind));

/** A notice about one of the owner's records (sentchecks: 'removed', 'missing'; 'forged'), told once. */
async function notice(env, { kind, fp, where, list, actor = null, text = null, about = null }) {
  const { item, target } = await targetOf(env.DB, list);
  await env.DB.prepare(`INSERT OR IGNORE INTO notices (kind, fp, connection_id, group_id, own, item, target, actor, text, about, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`).bind(kind, fp, where.connection ? Number(where.connection.id) : null,
    where.group ? Number(where.group.id) : null, item, target, actor, text, about, now()).run();
}

/** Who someone is to the owner here: a friend's approved name, their signed name, or null. */
async function nameOf(env, person, learnt) {
  const friend = await env.DB.prepare("SELECT name FROM connections WHERE identity = ? AND approved_at IS NOT NULL").bind(person).first();
  return friend ? String(friend.name) : learnt.get(person) ?? null;
}

/** Identities and signed names a host sent, learnt and checked. */
async function learnPeople(env, people) {
  const names = new Map();
  for (const [p, info] of Object.entries(people ?? {}).slice(0, 50)) {
    if (!ID_RE.test(p)) continue;
    const chain = parseChain(info?.chain);
    const state = chain && (await learnIdentity(env, chain));
    if (!state || state.id !== p) continue;
    const profile = info.profile && (await checkProfile(info.profile, state));
    if (profile) names.set(p, profile.name);
  }
  return names;
}

/**
 * What became of one of the owner's records, as found (by a check, or a thread opened): updates `sent` and tells the
 * owner if it was removed, or went with nothing signed saying why. `found`: {state, removedBy?}.
 */
export async function settle(env, row, where, found, learnt = new Map()) {
  const db = env.DB;
  const at = now();
  const fp = String(row.fp);
  const unsure = row.state === "unsure";
  if (found.state === "there") {
    // A delete or leave, taken: nothing more to ask about it.
    const done = row.kind === "delete" || row.kind === "leave";
    await db.prepare("UPDATE sent SET state = NULL, checked_at = ?, next_at = ? WHERE fp = ?").bind(at, done ? null : nextAt(env, Number(row.created_at), at), fp).run();
    return;
  }
  if (found.state === "missing" && unsure) {
    // Never taken: it went nowhere, and the owner was told at the time.
    await db.prepare("DELETE FROM sent WHERE fp = ?").bind(fp).run();
    return;
  }
  if (row.state === found.state) {
    await db.prepare("UPDATE sent SET checked_at = ?, next_at = NULL WHERE fp = ?").bind(at, fp).run();
    return;
  }
  await db.prepare("UPDATE sent SET state = ?, removed_by = ?, checked_at = ?, next_at = NULL WHERE fp = ?")
    .bind(found.state, found.removedBy ?? null, at, fp).run();
  if (found.state === "removed" || found.state === "missing") {
    const actor = found.removedBy ? await nameOf(env, found.removedBy, learnt) : null;
    await notice(env, { kind: found.state, fp, where, list: String(row.item), actor: actor ?? (found.removedBy ? "Someone" : null),
      text: await wordsOf(row), about: aboutOf(row) });
  }
}

/**
 * A host's signed marker (a delete or removal) about `fp`, checked: who signed it, or null if it doesn't check, or if
 * they couldn't have removed it (`mayRemove`): a host can't pass off anyone's signed `remove` as a removal.
 */
async function checkMarker(env, marker, { fp, host, delegations, me, mayRemove }) {
  const got = marker?.sent && (await checkRecord(marker.sent, { identityOf: (p) => identityState(env, p), delegationOf: async (k) => delegations?.[k] ?? null,
    at: Number(marker.taken) || now() }));
  if (!got || got.record.host !== host || got.record.about !== fp) return null;
  if (got.record.kind === "delete") return got.record.author === me ? { state: "deleted" } : null;
  return got.record.kind === "remove" && (await mayRemove(got.record.author)) ? { state: "removed", removedBy: got.record.author } : null;
}

/**
 * Who may remove what the owner wrote at `host` (`where`: a friend's connection or a group): on a friend's post, that
 * friend; in a group, its owner, and admins the owner's signed `role` names (`data.roles`, as the group sent them).
 */
async function removersAt(env, host, where, data) {
  if (where.connection) return async (p) => p === host;
  const state = await identityState(env, host);
  const owner = state?.current.owner ? String(state.current.owner) : "";
  let admins = null;
  return async (p) => Boolean(owner) && (p === owner || (admins ??= await checkRoles(env, where.group, owner, data.roles, data.delegations)).has(p));
}

/** Sends a delete or leave the host hasn't taken again. Returns true once it's taken. */
async function resend(env, from, where, row) {
  const sent = JSON.parse(String(row.record));
  const record = parseRecord(fromB64url(sent.record));
  const delegation = record && (await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(record.key, now()).first());
  if (!delegation) return false; // signed by a browser that can't sign any more: the owner deletes it again
  const own = await env.DB.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  const body = { sent, delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
    ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) };
  // A group's members list (leaving) is the group's own id; everything else is on a post.
  const path = record.item === record.host ? "/_group/records" : "/_p/records";
  const origin = String((where.connection ?? where.group).origin);
  try {
    const answer = await callFriend(env, from, origin, path, { body, timeout: 15_000 });
    await keepSent(env, { record, sent, list: String(row.item), receipt: answer.receipt ?? null });
    return true;
  } catch (error) {
    if (error.status === 409 && error.message === "duplicate") {
      await keepSent(env, { record, sent, list: String(row.item), error });
      return true;
    }
    return false;
  }
}

/**
 * One round of checks, in the background from Home: at most once an hour (a "day" of the schedule on test sites), up
 * to SITES_A_ROUND hosts, one call each. Self-hosted sites have no daily run (app.js daily), so this is where it happens
 * everywhere; a site nobody visits isn't checked, and nobody's there to tell.
 */
export async function checkSentRound(env, from) {
  const db = env.DB;
  const at = now();
  const every = roundOf(env);
  const last = await db.prepare("SELECT value FROM settings WHERE key = 'sent_round_at'").first();
  if (last && at - Number(last.value) < every) return;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('sent_round_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(at)).run();
  const me = await ownHost(env);
  if (!me) return;
  const { results } = await db.prepare("SELECT * FROM sent WHERE next_at <= ? ORDER BY next_at LIMIT 2000").bind(at).all();
  const byHost = new Map();
  for (const r of results) {
    if (!byHost.has(String(r.host))) byHost.set(String(r.host), []);
    byHost.get(String(r.host)).push(r);
  }
  for (const [host, rows] of [...byHost].slice(0, SITES_A_ROUND)) {
    const where = await whereIs(db, host);
    if (!where) {
      // No longer a friend or member: they won't answer.
      await db.prepare("UPDATE sent SET state = COALESCE(state, 'unchecked'), next_at = NULL WHERE host = ? AND next_at IS NOT NULL").bind(host).run();
      continue;
    }
    await checkHost(env, from, me, host, where, rows).catch(() => null);
  }
}

/** Checks the owner's records at one host (`rows`, due now), and sends again what's waiting. */
async function checkHost(env, from, me, host, where, rows) {
  const db = env.DB;
  const at = now();
  for (const row of rows.filter((r) => r.state === "waiting").slice(0, RESENDS_A_SITE)) {
    if (await resend(env, from, where, row)) continue;
    const late = at - Number(row.created_at) > RETRY_DAYS * dayOf(env);
    await db.prepare("UPDATE sent SET checked_at = ?, next_at = ? WHERE fp = ?").bind(at, late ? null : at + roundOf(env), String(row.fp)).run();
  }
  const asking = rows.filter((r) => r.state !== "waiting").slice(0, MAX_POINTS);
  if (!asking.length) return;
  const origin = String((where.connection ?? where.group).origin);
  let data;
  try {
    data = await callFriend(env, from, origin, "/_p/records/check", { body: { points: asking.map((r) => ({ fp: String(r.fp), list: String(r.item) })) }, timeout: 15_000 });
  } catch {
    // Not answering: asked again at the next round after a day.
    await db.prepare(`UPDATE sent SET next_at = ? WHERE fp IN (SELECT value FROM json_each(?))`).bind(at + dayOf(env), JSON.stringify(asking.map((r) => String(r.fp)))).run();
    return;
  }
  const learnt = await learnPeople(env, data.people);
  const mayRemove = await removersAt(env, host, where, data);
  const answers = new Map((Array.isArray(data.results) ? data.results : []).map((r) => [r?.fp, r]));
  for (const row of asking) {
    const a = answers.get(String(row.fp));
    if (!a) continue;
    let found = { state: a.state };
    if (a.state === "deleted" || a.state === "removed") {
      // Who did it, from what they signed: a host can't say an admin removed something they didn't.
      found = (await checkMarker(env, a.marker, { fp: String(row.fp), host, delegations: data.delegations, me: me.person, mayRemove })) ?? { state: "missing" };
    } else if (!["there", "gone", "missing"].includes(a.state)) continue;
    await settle(env, row, where, found, learnt);
  }
}

// ---- Seen on arrival: threads and pulls ----

/**
 * A thread just opened and checked (lists.js checkList entries), compared with what the owner sent to it: their records
 * removed or left out are told (as a check would), and anything signed as them that their site never sent.
 */
export async function compareThread(env, { where, host, list, entries, me, names = new Map(), askedAt = 0 }) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT * FROM sent WHERE item = ?").bind(list).all();
  const mine = new Map(results.map((r) => [String(r.fp), r]));
  for (const e of entries) {
    const row = mine.get(e.fp);
    if (row) {
      if (e.state === "removed") await settle(env, row, where, { state: "removed", removedBy: e.removedBy ?? null }, names);
      else if (e.state === "left-out") await settle(env, row, where, { state: "missing" }, names);
      else if (e.state === "deleted" && row.state !== "deleted") await settle(env, row, where, { state: "deleted" }, names);
      else if (e.state === "ok" && row.state === "unsure") await settle(env, row, where, { state: "there" }, names);
    } else if (e.record?.author === me && e.state === "ok") {
      await forged(env, where, list, e.fp);
    }
  }
  // Taken here (its receipt says at which point) before the thread was asked for (`askedAt`), and not in what the host
  // shows from that point on: the host has shown a version without it (T13). Only from the first point shown (a thread
  // read from a checkpoint doesn't have the start). A host can only leave out the newest records this way: one that
  // others had seen breaks the list.
  const shownFps = new Set(entries.map((e) => e.fp));
  const first = entries[0]?.n ?? Infinity;
  for (const row of results) {
    if (shownFps.has(String(row.fp)) || !row.receipt || !(row.state === null || row.state === "there" || row.state === "unsure")) continue;
    if (!(Number(row.created_at) < askedAt)) continue;
    let at = null;
    try { at = decode(fromB64url(JSON.parse(String(row.receipt)).bytes))?.n; } catch {}
    if (Number.isSafeInteger(at) && at >= first) await settle(env, row, where, { state: "missing" }, names);
  }
}

/** Records by the owner a host says it took (a pull's `mine`), compared with what their site sent (T6). */
export async function compareMine(env, where, mine) {
  const records = (Array.isArray(mine?.records) ? mine.records : []).slice(0, 200)
    .filter((r) => ID_RE.test(r?.fp ?? "") && typeof r.list === "string" && Number.isSafeInteger(r.taken));
  const hostNow = Number.isSafeInteger(mine?.now) ? mine.now : now();
  const settled = records.filter((r) => hostNow - r.taken > Math.min(GRACE, dayOf(env)));
  if (!settled.length) return;
  const { results } = await env.DB.prepare("SELECT fp FROM sent WHERE fp IN (SELECT value FROM json_each(?))").bind(JSON.stringify(settled.map((r) => r.fp))).all();
  const known = new Set(results.map((r) => String(r.fp)));
  for (const r of settled) if (!known.has(r.fp)) await forged(env, where, r.list, r.fp);
}

/** Something signed as the owner that their site never sent: said on Home until they clear it. */
async function forged(env, where, list, fp) {
  await notice(env, { kind: "forged", fp, where, list });
}

// ---- Home ----

/** What Home says about what the owner sent: deletes and leaves not taken yet, and anything signed as them they didn't send. */
export async function sentTrouble(db) {
  const [waiting, forgedRows] = await db.batch([
    db.prepare(`SELECT s.fp, s.kind, s.item, s.created_at, s.next_at, c.id AS connection_id, c.name AS friend, g.id AS group_id, g.name AS group_name
      FROM sent s LEFT JOIN connections c ON c.identity = s.host AND c.approved_at IS NOT NULL LEFT JOIN groups g ON g.identity = s.host
      WHERE s.state = 'waiting' ORDER BY s.created_at LIMIT 5`),
    db.prepare(`SELECT n.id, n.item, n.target, n.created_at, c.id AS connection_id, c.name AS friend, g.id AS group_id, g.name AS group_name
      FROM notices n LEFT JOIN connections c ON c.id = n.connection_id LEFT JOIN groups g ON g.id = n.group_id
      WHERE n.kind = 'forged' AND n.dismissed_at IS NULL ORDER BY n.created_at DESC LIMIT 5`),
  ]);
  return { waiting: waiting.results, forged: forgedRows.results };
}

/** POST /_admin/sent/stop (fp): stop sending a delete or leave again. POST /_admin/notices/dismiss (id): clear a notice. */
export async function handleSentAdmin(request, env, url) {
  const form = await request.formData().catch(() => new FormData());
  if (url.pathname === "/_admin/sent/stop") {
    await env.DB.prepare("UPDATE sent SET state = 'stopped', next_at = NULL WHERE fp = ? AND state = 'waiting'").bind(String(form.get("fp") ?? "")).run();
  } else if (url.pathname === "/_admin/notices/dismiss") {
    await env.DB.prepare("UPDATE notices SET dismissed_at = ? WHERE id = ? AND kind = 'forged'").bind(now(), Number(form.get("id")) || 0).run();
  } else return new Response("Not found", { status: 404 });
  return Response.redirect(`${url.origin}/`, 303);
}
