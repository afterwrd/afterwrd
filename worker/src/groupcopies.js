// A group's signed posts, from a member's own site (afterwrd 2, step 6c: docs/signed-conversations.md, "6c in detail"),
// as a friend's are (friendcopies.js), for groups with an identity:
// - copies: the group's newest posts (KEEP, and events still to come) kept here, asked for with `since` while its page
//   opens and hourly in the background (pullGroup, pullGroups), each post's first record checked as it arrives; older
//   pages are read from the group with `before`, checked, and not kept;
// - a post opened: its whole list read from the group and checked (groupThread), admins' removals by the owner's
//   signed `role` records the group sends with it;
// - what the owner here does there, signed in their browser and passed on in a signed call, kept in `sent` with the
//   group's receipt:
//     POST /_groups/<id>/items                  {sent, photos: [sent…], files: [{hash, thumb_hash}…]}: a new post (its
//                                               photos uploaded here first, and sent as signed links) or event
//     POST /_groups/<id>/items/<item>/records   form: sent (JSON), back: a comment, edit, delete, vote, answer, end,
//                                               change, or (an admin) remove or calloff
// - notes from the group (POST /_p/notes, notes.js): receiveGroupNote.
import { rateWindow } from "./limits.js";
import { blockedAmong, isBlocked } from "./blocks.js";
import { busyUntil, callFriend } from "./calls.js";
import { ANSWERS, cleanEvent, eventChanged, eventWhen, finishedAt, hasDate, onDate } from "./calendar.js";
import { dateTally } from "./itemkinds.js";
import { cleanTally, copyFromRow, keepCopy, lookupsWith } from "./friendcopies.js";
import { identityState, learnPeopleIn, signersIn } from "./identities.js";
import { checkDelegation } from "./identity.js";
import { frozenUntil, ID_RE, keepKnown, namesFor, ownHost } from "./items.js";
import { checkHead, checkList, dateList, headOf } from "./lists.js";
import { firstChanged, fitToKeep, keepThread, keptThread, withNew } from "./threads.js";
import { CLOSE_SECONDS, MAX_GROUP_PHOTOS } from "./groups.js";
import { parseGroup, refresh } from "./membership.js";
import { keepNotice, tellMention } from "./notes.js";
import { pushAllowed, writerMayBuzz } from "./notify.js";
import { checkPhotos, removeUnusedFiles } from "./posts.js";
import { notifyLater } from "./push.js";
import { checkGroupReceipts, queueReceipts } from "./receipts.js";
import { friendsAmong, peopleShown } from "./names.js";
import { compareMine, compareThread, keepSent as keepSentAs, TAKEN_SQL, willRetry } from "./sentchecks.js";
import { checkRecord } from "./records.js";
import { signedFile } from "./share.js";
import { safeNext } from "./auth.js";
import { messagePage } from "./views/pages.js";
import { DATE_RE, parseRecord, writtenAt } from "../public/static/records.js";
import { decode, fromB64url } from "../public/static/signed.js";
import { html, json, now, Refusal } from "./util.js";
import { keepGroupUsage } from "./allowances.js";

export const KEEP = 50; // a group's newest posts kept here (docs/signed-conversations.md section 3)
const PULL_SECONDS = 3600;
const PAGES = 3;
const PAGE_SIZE = 20;
const SNIPPET = 200;

const snippet = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, SNIPPET) : "");

/**
 * Those a group sent (`people`: {person: {chain, profile}}) who signed something in what it sent (`sent`: the answer or
 * note), learnt and checked here, with their signed names (identities.js learnPeopleIn).
 */
const learnPeople = (env, people, sent) => learnPeopleIn(env, people, signersIn(sent));

/** What to say when a group's site refused a call: if it's had a lot from this one today (allowances.js), that. */
const busyMessage = (group, error) => (busyUntil(error) ? `${group.name}'s site has had a lot of requests from you today. Try tomorrow.` : error.message);

/** A call to a group's site, signed by this one. Throws as callFriend does. */
const ask = async (env, from, group, path, body = null) => callFriend(env, from, String(group.origin), path, { ...(body !== null && { body }), timeout: 25_000 });

/**
 * Asks a group's site for the posts that changed since this site last asked, and keeps them (each post's first record
 * checked: on the group's site, signed by whoever wrote it). Returns the group as the member sees it (its name, members
 * and their role: membership.js parseGroup), or throws as callFriend does.
 */
export async function pullGroup(env, from, group) {
  const db = env.DB;
  let since = Number(group.items_since ?? 0);
  let info = null;
  for (let page = 0; page < PAGES; page++) {
    let data;
    try {
      data = await ask(env, from, group, `/_p/items?since=${since}`);
    } catch (error) {
      // Asked again in an hour; or, if the group's site says this one has had its allowance there today, once the day's over.
      const busy = busyUntil(error);
      await db.prepare("UPDATE groups SET items_checked_at = ? WHERE id = ?").bind(busy ? Math.max(now(), busy - rateWindow(PULL_SECONDS)) : now(), group.id).run();
      if (page === 0) throw error;
      break;
    }
    if (page === 0) info = parseGroup(data.context, String(group.origin), Number(group.remote_id), env);
    // A group the owner here started: how busy its site has been, for Home's busy-account warning (allowances.js).
    if (page === 0 && data.usage) await keepGroupUsage(db, Number(group.id), data.usage).catch(() => null);
    // Anything signed as the owner here that this site never sent (sentchecks.js).
    if (page === 0) await compareMine(env, { group }, data.mine).catch(() => null);
    const sentKeys = await fillGaps(env, from, group, data);
    await learnPeople(env, data.people, data);
    await keepSentKeys(env, sentKeys);
    const rules = await copyRules(env, group, data);
    const statements = [];
    for (const item of Array.isArray(data.items) ? data.items.slice(0, 60) : []) {
      const kept = await keepCopy(env, { group: Number(group.id), host: String(group.identity), site: String(group.origin), rules }, item, data.delegations);
      if (kept) statements.push(kept.statement);
    }
    for (const id of Array.isArray(data.gone) ? data.gone.slice(0, 500) : []) {
      if (ID_RE.test(id)) statements.push(db.prepare("DELETE FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id));
    }
    since = Number.isSafeInteger(data.until) ? Math.max(since, data.until) : since;
    statements.push(db.prepare("UPDATE groups SET items_since = ?, items_checked_at = ? WHERE id = ?").bind(since, now(), group.id));
    await db.batch(statements);
    if (!data.more) break;
  }
  group.items_since = since;
  await trim(env, group);
  // Mention receipts the group's site couldn't be asked about before (receipts.js): it's answering now.
  await checkGroupReceipts(env, from, group).catch(() => null);
  if (info) await refresh(db, group, info);
  return info;
}

/**
 * After a pull (`data`), which sends only the people and delegations new to the group since this site last asked
 * (friendhost.js learntSince): the delegations this site already keeps are added in, anyone or any delegation still
 * missing is asked for (POST /_p/people). Returns the delegations it was sent, for keepSentKeys to keep for next time
 * once the people in the pull are learnt.
 */
async function fillGaps(env, from, group, data) {
  const db = env.DB;
  const sents = [];
  for (const item of Array.isArray(data.items) ? data.items.slice(0, 60) : []) {
    sents.push(item?.sent, ...(Array.isArray(item?.records) ? item.records.slice(0, 60).map((x) => x?.sent) : []));
  }
  for (const proof of Object.values(data.roles ?? {}).slice(0, 50)) sents.push(proof?.join, proof?.role);
  const records = sents.map((x) => (typeof x?.record === "string" ? parseRecord(fromB64url(x.record)) : null)).filter(Boolean);
  if (!records.length) return [];
  const sent = data.delegations && typeof data.delegations === "object" ? data.delegations : {};
  data.delegations = { ...sent };
  const keys = [...new Set(records.map((r) => String(r.key)))];
  const authors = [...new Set(records.map((r) => String(r.author)))];
  const [kept, knownPeople] = /** @type {D1Result<any>[]} */ (await db.batch([
    db.prepare("SELECT key, bytes, proof FROM known_delegations WHERE key IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(keys.filter((k) => !sent[k]))),
    db.prepare("SELECT person FROM identities WHERE person IN (SELECT value FROM json_each(?)) AND frozen_at IS NULL")
      .bind(JSON.stringify(authors.filter((p) => !data.people?.[p]))),
  ]));
  for (const r of kept.results) data.delegations[String(r.key)] ??= { bytes: String(r.bytes), proof: JSON.parse(String(r.proof)) };
  const have = new Set([...knownPeople.results.map((r) => String(r.person)), ...Object.keys(data.people ?? {})]);
  const missingPeople = authors.filter((p) => !have.has(p));
  const missingKeys = keys.filter((k) => !data.delegations[k]);
  let asked = {};
  if (missingPeople.length || missingKeys.length) {
    const more = await ask(env, from, group, "/_p/people", { people: missingPeople.slice(0, 200), keys: missingKeys.slice(0, 200) }).catch(() => null);
    if (more) {
      data.people = { ...(data.people ?? {}), ...(more.people && typeof more.people === "object" ? more.people : {}) };
      asked = more.delegations && typeof more.delegations === "object" ? more.delegations : {};
      for (const [k, d] of Object.entries(asked)) if (keys.includes(k)) data.delegations[k] ??= d;
    }
  }
  // Those it was sent (not those it had), to keep once the people in it are learnt (keepSentKeys), each with the person
  // who signed a record here with that key.
  const signer = new Map(records.map((r) => [String(r.key), String(r.author)]));
  return Object.entries({ ...sent, ...asked }).filter(([key]) => signer.has(key)).map(([key, d]) => ({ key, person: signer.get(key), d }));
}

/**
 * Keeps the delegations a group sent (fillGaps), one row each, as people's devices sign in: only one that checks against
 * the identity of the person who signed with that key, so a group can't have this site keep someone's key as another's.
 */
async function keepSentKeys(env, sentKeys) {
  const states = new Map();
  for (const { key, person, d } of sentKeys ?? []) {
    const bytes = typeof d?.bytes === "string" ? fromB64url(d.bytes) : null;
    if (!bytes) continue;
    if (!states.has(person)) states.set(person, await identityState(env, person));
    const state = states.get(person);
    if (!state || state.frozen || (await checkDelegation(bytes, d.proof, state, now())) !== key) continue;
    await keepKnown(env.DB, { key, person, bytes: d.bytes, proof: d.proof, expires: decode(bytes).expires });
  }
}

/**
 * Keeps a group's newest KEEP posts here, and its events still to come, and anything the owner here has acted on in the
 * last 30 days; older ones are read from the group when they're wanted.
 */
async function trim(env, group) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT id, content FROM copies WHERE group_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
    .bind(group.id, KEEP).all();
  if (!results.length) return;
  // (`sent.item` is the list: one date's of a repeating event is "<post>/<date>".)
  const acted = new Set((await db.prepare("SELECT DISTINCT item FROM sent WHERE host = ? AND created_at > ?").bind(group.identity, now() - 30 * 86400).all())
    .results.map((r) => String(r.item).split("/")[0]));
  const old = results.filter((r) => {
    const content = JSON.parse(String(r.content));
    return !acted.has(String(r.id)) && !(content.event && !content.event.cancelled && finishedAt(content.event) > now());
  }).map((r) => String(r.id));
  if (old.length) await db.prepare("DELETE FROM copies WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))").bind(group.id, JSON.stringify(old)).run();
}

/** Asks every signed group's site not asked in the last hour (in the background, from Home). */
export async function pullGroups(env, from) {
  // Not a group that's closed and gone (its 30 days are up: groups.js), whose copies go now.
  await env.DB.prepare("DELETE FROM copies WHERE group_id IN (SELECT id FROM groups WHERE closed_at < ?)").bind(now() - CLOSE_SECONDS).run();
  const { results } = await env.DB.prepare(`SELECT * FROM groups WHERE identity IS NOT NULL AND joined_at IS NOT NULL AND origin IS NOT NULL
    AND COALESCE(closed_at, ?2) >= ?2 AND COALESCE(items_checked_at, 0) < ?1 ORDER BY COALESCE(items_checked_at, 0) LIMIT 20`)
    .bind(now() - rateWindow(PULL_SECONDS), now() - CLOSE_SECONDS).all();
  await Promise.all(results.map((g) => pullGroup(env, from, g).catch(() => null)));
}

/**
 * Copies as a group's pages show them: each with its writer named (as the owner here knows them, or as they sign
 * themselves), whether it's the owner's own, and where its list is up to for the signed forms on it.
 */
export async function groupCopiesShown(env, group, rows, people = []) {
  const db = env.DB;
  const me = await ownHost(env);
  const names = memberNames(people);
  people = rows.flatMap((r) => {
    const t = r.tally ? JSON.parse(String(r.tally)) : null;
    return [String(r.author), ...Object.keys(t?.votes ?? t?.answers ?? {}), ...Object.values(t?.dates ?? {}).flatMap((d) => Object.keys(d?.answers ?? {}))];
  });
  const [known, mine, friends] = await Promise.all([namesFor(db, people),
    rows.length ? db.prepare(`SELECT item, fp FROM sent WHERE item IN (SELECT value FROM json_each(?)) AND ${TAKEN_SQL} ORDER BY created_at, rowid`)
      .bind(JSON.stringify(rows.map((r) => String(r.id)))).all() : { results: [] }, friendsAmong(db, people)]);
  for (const [p, name] of known) names.set(p, name);
  // Someone the owner's blocked (blocks.js): their posts folded away, and they're counted in polls and events unnamed.
  const blocked = await blockedAmong(db, people);
  for (const p of blocked) names.set(p, "someone you've blocked");
  const last = new Map(mine.results.map((r) => [String(r.item), String(r.fp)]));
  // The owner's newest record on each date of a repeating event (step 6d: each date's list is its own).
  const repeating = rows.filter((r) => JSON.parse(String(r.content)).event?.rrule).map((r) => String(r.id));
  for (const id of repeating) {
    const { results } = await db.prepare(`SELECT item, fp FROM sent WHERE item > ? AND item < ? AND ${TAKEN_SQL} ORDER BY created_at, rowid`).bind(`${id}/`, `${id}0`).all();
    for (const x of results) last.set(String(x.item), String(x.fp));
  }
  return rows.map((r) => {
    const name = names.get(String(r.author)) ?? "Someone";
    const shown = Object.assign(copyFromRow({ ...r, name, origin: "", connection_id: 0 }, { names, me: me?.person ?? null, known: friends }),
      { blocked: blocked.has(String(r.author)) });
    const event = /** @type {any} */ (shown.event);
    if (event?.rrule && me) event.listBase = { host: String(group.identity), me: me.person };
    if (event?.dates && me) {
      event.dates = event.dates.map((d) => ({ ...d, list: { host: String(group.identity), me: me.person,
        seen: d.list ? { n: d.list.n, h: d.list.head } : null, mine: last.get(dateList(String(r.id), d.date)) ?? null } }));
    }
    return { ...shown, connection: null, name, mine: String(r.author) === me?.person,
      list: r.list_n && me ? { host: String(group.identity), me: me.person, seen: { n: Number(r.list_n), h: String(r.list_head) },
        mine: last.get(String(r.id)) ?? null, frozenUntil: frozenUntil(JSON.parse(String(r.content)).before_until) } : null };
  });
}

/**
 * A group's page of posts: its newest (after asking its site what's changed), or (`before`, a time) older ones, read
 * from its site and checked, not kept. Returns {info, posts, next (the `before` for the page after, or null), error}.
 */
export async function groupPosts(env, from, group, { before = null } = {}) {
  const db = env.DB;
  let info = null;
  let error = null;
  if (!before) {
    try { info = await pullGroup(env, from, group); } catch (e) { error = e; }
    const { results } = await db.prepare("SELECT * FROM copies WHERE group_id = ? ORDER BY created_at DESC LIMIT ?").bind(group.id, PAGE_SIZE + 1).all();
    const rows = results.slice(0, PAGE_SIZE);
    const posts = await groupCopiesShown(env, group, rows, info?.people);
    return { info, posts, error, next: results.length > PAGE_SIZE ? Number(rows.at(-1).created_at) : null };
  }
  let data;
  try { data = await ask(env, from, group, `/_p/items?before=${Number(before)}`); } catch (e) { return { info: null, posts: [], error: e, next: null }; }
  info = parseGroup(data.context, String(group.origin), Number(group.remote_id), env);
  await learnPeople(env, data.people, data);
  const rules = await copyRules(env, group, data);
  const rows = [];
  for (const item of Array.isArray(data.items) ? data.items.slice(0, PAGE_SIZE) : []) {
    // Checked as a copy would be, then shown from what was checked, without keeping it.
    const kept = await keepCopy(env, { group: Number(group.id), host: String(group.identity), site: String(group.origin), rules }, item, data.delegations);
    if (!kept) continue;
    rows.push({ id: item.id, group_id: group.id, author: kept.record.author, record: JSON.stringify(item.sent), content: JSON.stringify(kept.content),
      earlier: JSON.stringify(Array.isArray(item.earlier) ? item.earlier.slice(0, 20) : []), edited_at: Number.isSafeInteger(item.edited_at) ? item.edited_at : null,
      comments: item.comments > 0 ? 1 : 0, created_at: writtenAt(kept.record, Number(item.taken)), tally: cleanTally(item.tally) ? JSON.stringify(cleanTally(item.tally)) : null,
      list_n: Number.isSafeInteger(item.list?.n) ? item.list.n : null, list_head: typeof item.list?.head === "string" ? item.list.head : null,
      checked_n: null, checked_head: null });
  }
  const posts = await groupCopiesShown(env, group, rows, info?.people);
  return { info, posts, error: null, next: data.more === true && rows.length ? Number(rows.at(-1).created_at) : null };
}

/** One of a group's posts kept here, as pages show it; null if it isn't. */
export async function groupCopy(env, group, id, people = []) {
  const row = await env.DB.prepare("SELECT * FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id).first();
  return row ? (await groupCopiesShown(env, group, [row], people))[0] : null;
}

/**
 * Names for a group's members as its members list gives them (`people`: membership.js parseGroup's, with who they are),
 * for anyone whose own signed name, or a friend's name here, this site doesn't have.
 */
const memberNames = (people) => new Map((Array.isArray(people) ? people : []).filter((p) => p?.person && p.name).map((p) => [String(p.person), String(p.name)]));

/**
 * Who's an admin, as the owner's signed `role` records the group sent with a thread say (`roles`: {person: {join, role}},
 * each as signed): the owner made their `join` an admin. Readers take the group's word that they still were when they
 * acted (the group checks that, by the members list's `role_at`).
 */
export async function checkRoles(env, group, owner, roles, delegations) {
  const admins = new Set();
  const lookups = { ...lookupsWith(env, delegations), at: now() };
  for (const [person, proof] of Object.entries(roles ?? {}).slice(0, 50)) {
    if (!ID_RE.test(person)) continue;
    const join = await checkRecord(proof?.join, lookups);
    const role = await checkRecord(proof?.role, lookups);
    if (join && role && join.record.kind === "join" && join.record.author === person && join.record.host === group.identity
      && join.record.item === group.identity && role.record.kind === "role" && role.record.author === owner && role.record.host === group.identity
      && role.record.about === join.fp && role.content?.role === "admin") admins.add(person);
  }
  return admins;
}

/** Who may call off someone's event in `group`, for checking its posts (friendcopies.js keepCopy): its owner, and admins. */
async function copyRules(env, group, data) {
  const state = await identityState(env, String(group.identity));
  const owner = state?.current.owner ? String(state.current.owner) : "";
  return { owner, admins: owner ? await checkRoles(env, group, owner, data.roles, data.delegations) : new Set() };
}

/**
 * A group's post opened: its list read from the group and checked. Returns {entries (as lists.js checkList shows them,
 * with each writer's name), problem, changed, seen, mine, host, owner} or {error}.
 */
export async function groupThread(env, from, group, id, people = []) {
  const db = env.DB;
  const copy = await db.prepare("SELECT author, checked_n, checked_head FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id).first();
  // What this site checked before, kept (threads.js): then only what's after it is asked for, and checked from there.
  const kept = copy?.checked_n ? await keptThread(db, id, Number(copy.checked_n), String(copy.checked_head)) : null;
  const askedAt = now();
  let data;
  try { data = await ask(env, from, group, kept ? `/_p/items/${id}?after=${Number(copy.checked_n)}` : `/_p/items/${id}`); } catch (error) {
    return { error: busyMessage(group, error), status: error.status };
  }
  const state = await identityState(env, String(group.identity));
  if (!state || state.frozen || !state.current.owner) return { error: "The group's identity couldn't be checked." };
  const owner = String(state.current.owner);
  const host = String(group.identity);
  const me = await ownHost(env);
  let signed = await learnPeople(env, data.people, data);
  let admins = await checkRoles(env, group, owner, data.roles, data.delegations);
  const check = (entries, from, kept = null) => checkList({ host, hostingKey: state.current.hosting, list: id, owner: copy ? String(copy.author) : String(data.owner ?? ""),
    entries, signedHead: data.signedHead, from, kept, lookups: lookupsWith(env, data.delegations), group: { owner, admin: (p) => admins.has(p) } });
  // A removal by an admin says so, worked out from the owner's signed roles while they're at hand (and kept so).
  const flagged = (list) => list.map((e) => (e.removedBy ? { ...e, removedByAdmin: Boolean(e.removedByAdmin || (e.removedBy !== owner && admins.has(e.removedBy))) } : e));
  let result = null;
  let changed = false;
  if (kept) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    // Checked against what was kept, so a delete or removal of something from before is held to the same rules.
    const next = await check(entries, null, kept);
    if (!next.problem) {
      const heads = new Map(entries.map((e) => [e.n, e.head]));
      const fresh = next.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null }));
      result = { entries: flagged(withNew(kept, fresh)), problem: null };
      if (fresh.length && fitToKeep(fresh)) await keepThread(db, id, result.entries, firstChanged(result.entries, fresh));
      else if (fresh.length) await db.prepare("DELETE FROM thread_cache WHERE list = ?").bind(id).run(); // read whole next time
    } else {
      // Doesn't follow on from where this site got to: the whole conversation, as before, to show what it is now.
      try { data = await ask(env, from, group, `/_p/items/${id}`); } catch (error) { return { error: busyMessage(group, error), status: error.status }; }
      signed = new Map([...signed, ...(await learnPeople(env, data.people, data))]);
      admins = await checkRoles(env, group, owner, data.roles, data.delegations);
    }
  }
  if (!result) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const from0 = data.checkpoint && (await checkHead(data.checkpoint, { hostingKey: state.current.hosting, host, list: id }));
    const whole = await check(entries, from0 ? { n: from0.n, head: from0.head } : null);
    const before = copy?.checked_n ? entries.find((e) => e.n === Number(copy.checked_n)) : null;
    changed = Boolean(copy?.checked_n && (!before || before.head !== copy.checked_head));
    const heads = new Map(entries.map((e) => [e.n, e.head]));
    result = { entries: flagged(whole.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null }))), problem: whole.problem };
    if (copy && !whole.problem && !changed && result.entries.length && fitToKeep(result.entries)) await keepThread(db, id, result.entries);
  }
  const last = result.entries.at(-1);
  if (copy && !result.problem && !changed && last && last.n !== Number(copy.checked_n ?? 0)) {
    await db.prepare("UPDATE copies SET checked_n = ?, checked_head = ? WHERE id = ? AND group_id = ?").bind(last.n, last.head, id, group.id).run();
  }
  const known = await namesFor(db, [...new Set(result.entries.map((e) => e.by).filter(Boolean))]);
  const names = new Map([...memberNames(people), ...signed, ...known]);
  // Named as the owner here knows them (names.js): their friends marked, and look-alikes of friends, the owner or admins.
  const shown = await peopleShown(db, result.entries.map((e) => e.by), { signed: new Map([...memberNames(people), ...signed]),
    group: { owner, names, admins }, me: me?.person ?? null });
  // What the owner here sent to it, compared with what the group shows (sentchecks.js).
  if (me && !result.problem) await compareThread(env, { where: { group }, host, list: id, entries: result.entries, me: me.person, names, askedAt }).catch(() => null);
  const mine = [...result.entries].reverse().find((e) => e.record?.author === me?.person)?.fp ?? null;
  return { entries: result.entries.map((e) => ({ ...e, name: e.by ? shown.names.get(e.by) ?? names.get(e.by) ?? "Someone" : null,
    ...(e.by && shown.tags.get(e.by)) })),
  problem: result.problem, changed, seen: last ? { n: last.n, h: last.head } : null, mine, host, owner, admins, names: new Map([...names, ...shown.names]), tags: shown.tags };
}

/** The owner's signed record, with the delegation behind it and their signed name, ready to pass on to `group`. */
async function ready(env, group, sent, check) {
  const me = await ownHost(env);
  const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
  if (!me || !record || record.author !== me.person || record.host !== group.identity || !check(record)) throw new Refusal("That didn't work. Try again.");
  const delegation = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(record.key, now()).first();
  if (!delegation) throw new Refusal("This browser can't sign for you any more. Sign out and sign in again.");
  const own = await env.DB.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  return { record, delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
    ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) };
}

/**
 * Keeps the owner's own copy of what they sent a group, with the group's receipt. `item` is the list it's on (lists.js
 * listOf): for one date of a repeating event, that date's, so the owner's next answer to it follows this one (prev).
 */
const keepSent = (env, record, sent, receipt, error = null) => keepSentAs(env, { record, sent, receipt, error });

/**
 * POST /_groups/<id>/items: the owner's new post (or event) in `group`, signed by the composer, its photos (uploaded
 * here first: `files`) sent as signed links for the group to copy, then let go here. Returns {id}.
 */
export async function postSigned(env, url, group, body) {
  const files = Array.isArray(body?.files) ? body.files : [];
  const photos = Array.isArray(body?.photos) ? body.photos : [];
  try {
    if (photos.length !== files.length || photos.length > MAX_GROUP_PHOTOS) throw new Refusal(`Up to ${MAX_GROUP_PHOTOS} photos in a group post.`);
    if (files.length) {
      const trouble = await checkPhotos(env, files, MAX_GROUP_PHOTOS);
      if (trouble) throw new Refusal(trouble);
    }
    const post = await ready(env, group, body?.sent, (r) => r.kind === "item");
    for (const p of photos) await ready(env, group, p, (r) => r.kind === "item");
    const links = await Promise.all(files.map(async (f) => ({ src: await signedFile(env, url.origin, f.hash), thumbSrc: await signedFile(env, url.origin, f.thumb_hash) })));
    let reply;
    try {
      reply = await ask(env, url.origin, group, "/_p/items", { sent: body.sent, photos, files: links, delegation: post.delegation, ...(post.profile && { profile: post.profile }) });
    } catch (error) {
      // Kept if the group may have taken it (sentchecks.js).
      await keepSent(env, post.record, body.sent, null, error);
      throw new Refusal(`Couldn't post in ${group.name}: ${error.message}`);
    }
    const id = await keepSent(env, post.record, body.sent, reply.receipt ?? null);
    for (const p of photos) await keepSent(env, parseRecord(fromB64url(p.record)), p, null);
    // Asked again when the group's page opens, which shows it.
    await env.DB.prepare("UPDATE groups SET items_checked_at = 0 WHERE id = ?").bind(group.id).run();
    return { id };
  } finally {
    // The group has its own copies now (or the post wasn't made): these were only uploaded to be sent.
    await removeUnusedFiles(env, files.flatMap((f) => [f?.hash, f?.thumb_hash]).filter((h) => typeof h === "string"));
  }
}

/** POST /_groups/<id>/items/<item>/records: the owner's signed record on a group's post, passed on. */
export async function relayToGroup(request, env, url, group, id) {
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? `/groups/${group.id}`), url), url.origin);
  const refused = (message, status = 400) => html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), status);
  let sent = null;
  try { sent = JSON.parse(String(form.get("sent") ?? "")); } catch {}
  if (!sent) return refused("This browser can't sign for you yet. Sign out and in again, or set it up in Your devices.");
  let ready_;
  try { ready_ = await ready(env, group, sent, (r) => r.item === id && r.kind !== "item"); } catch (error) { return refused(error.message); }
  const { record } = ready_;
  let answer;
  try {
    answer = await ask(env, url.origin, group, "/_p/records", { sent, delegation: ready_.delegation, ...(ready_.profile && { profile: ready_.profile }) });
  } catch (error) {
    // Kept if it may have been taken, or is a delete to send again (sentchecks.js).
    await keepSent(env, record, sent, null, error);
    if (error.status === 409 && error.message === "duplicate") answer = {};
    else return refused(`Couldn't send it: ${error.message}.${willRetry(record)}`);
  }
  const fp = await keepSent(env, record, sent, answer.receipt ?? null);
  // Those it mentions are sent the group's receipt too, from here (receipts.js).
  if (answer.receipt) await queueReceipts(env, url.origin, record, fp);
  const db = env.DB;
  if (answer.deleted) {
    await db.prepare("DELETE FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id).run();
    return Response.redirect(`${url.origin}/groups/${group.id}`, 303);
  }
  // The owner's own vote or answer, in their copy's totals at once (the group's are asked for again when it opens).
  if (record.kind === "vote" || record.kind === "answer") {
    const copy = await db.prepare("SELECT tally FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id).first();
    const content = sent.content ? decode(fromB64url(sent.content)) : null;
    if (copy && content) {
      const tally = JSON.parse(String(copy.tally ?? "null")) ?? (record.kind === "vote" ? { votes: {}, ended_at: null } : { answers: {} });
      if (record.kind === "vote") {
        const mask = (Array.isArray(content.choices) ? content.choices : []).reduce((m, i) => (Number.isInteger(i) && i >= 0 && i < 10 ? m | (1 << i) : m), 0);
        tally.votes ??= {};
        if (mask) tally.votes[record.author] = mask;
        else delete tally.votes[record.author];
      } else if (ANSWERS.includes(content.answer) && record.date) {
        // One date of a repeating event (step 6d): that date's answers, and where its list is up to now (the receipt).
        const took = answer.receipt?.bytes ? decode(fromB64url(answer.receipt.bytes)) : null;
        const day = tally.dates?.[record.date] ?? { answers: {}, off: null, list: null };
        day.answers = { ...day.answers, [record.author]: { answer: content.answer, version: record.version ?? null } };
        if (Number.isSafeInteger(took?.n) && typeof took.head === "string") day.list = { n: took.n, head: took.head };
        tally.dates = { ...tally.dates, [record.date]: day };
      } else if (ANSWERS.includes(content.answer)) {
        tally.answers ??= {};
        tally.answers[record.author] = { answer: content.answer, version: record.version ?? null };
      }
      await db.prepare("UPDATE copies SET tally = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(tally), id, group.id).run();
    }
  }
  await db.prepare("UPDATE groups SET items_checked_at = 0 WHERE id = ?").bind(group.id).run();
  back.hash = record.date && back.pathname.endsWith(`/posts/${id}`) ? `d-${record.date}` : `gi-${id}`;
  return Response.redirect(back.href, 303);
}

// --- notes from a group ------------------------------------------------------------------------------------------------

/** Someone's name as a group's note says its members list has it: only when there's no better (memberNames). */
const groupSays = (note, person) => (typeof note.names?.[person] === "string" && note.names[person].trim() ? note.names[person].trim().slice(0, 100) : "Someone");

const eventWords = (e) => `${e.title} · ${eventWhen(e)}${e.place ? ` · ${e.place}` : ""}`.slice(0, 400);

/** What this site's owner answered to a group's event, as its copy here says. */
const myAnswer = (copy, me) => (copy ? JSON.parse(String(copy.tally ?? "{}"))?.answers?.[me]?.answer ?? null : null);

/**
 * A note from a group the owner's in (POST /_p/notes, a signed call from the group's site: groupjoin.js signedGroup),
 * checked as a friend's are (notes.js): a new post that mentions the owner or is for everyone (@here); a comment, with
 * the group's receipt; a change to an event, or its calling off; or a post gone.
 */
export async function receiveGroupNote(env, url, work, group, me, note) {
  const host = String(group.identity);
  const g = Number(group.id);
  const link = (target) => `/groups/${g}/posts/${target}`;
  if (note.kind === "item") {
    await learnPeople(env, note.people, note);
    const kept = await keepCopy(env, { group: g, host, site: String(group.origin), rules: await copyRules(env, group, {}) }, note.item, note.delegations);
    if (!kept) return json({ error: "That isn't a post in this group." }, 400);
    await kept.statement.run();
    const id = String(note.item.id);
    const author = kept.record.author;
    // Their own, or from someone the owner's blocked (kept, folded away on the group's page: blocks.js): nothing to tell.
    if (author === me.person || (await isBlocked(env.DB, author))) return json({ ok: true }, 202);
    const actor = (await namesFor(env.DB, [author])).get(author) ?? groupSays(note, author);
    const text = kept.content.text || (kept.content.photos.length ? "Shared photos." : "");
    if ((kept.record.mentions ?? []).includes(me.person)) {
      if (await keepNotice(env.DB, { kind: "mention", fp: id, group: g, item: id, target: id, actor, text, author })) {
        await tellMention(env, url.origin, work, { group: g, title: String(group.name), actor, text, url: link(id), tag: `mention-g${g}-${id}`, author });
      }
    } else if (note.here === true && kept.content.here) {
      // @here: on Notifications always; on the phone, only the first from this group in a day.
      const told = await env.DB.prepare("SELECT 1 FROM notices WHERE group_id = ? AND kind = 'here' AND created_at > ? LIMIT 1").bind(g, now() - 86400).first();
      if (await keepNotice(env.DB, { kind: "here", fp: id, group: g, item: id, target: id, actor, text, author }) && !told
        && (await pushAllowed(env.DB, "SELECT COUNT(*) AS n FROM notices WHERE group_id = ?1 AND kind IN ('mention', 'here') AND created_at > ?2", g, now()))
        && (await writerMayBuzz(env.DB, author))) {
        notifyLater(env, url.origin, work, { kind: "mention", title: String(group.name), text: `${actor} wrote to everyone: ${snippet(text)}`,
          hidden: "Wrote to everyone in a group", url: link(id), tag: `here-g${g}-${id}` });
      }
    }
    return json({ ok: true }, 202);
  }
  if (note.kind === "gone") {
    const id = String(note.item ?? "");
    if (!ID_RE.test(id)) return json({ error: "That didn't work." }, 400);
    const copy = await env.DB.prepare("SELECT content, tally FROM copies WHERE id = ? AND group_id = ?").bind(id, g).first();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM copies WHERE id = ? AND group_id = ?").bind(id, g),
      env.DB.prepare("DELETE FROM notices WHERE item = ? AND group_id = ?").bind(id, g),
    ]);
    const was = copy && JSON.parse(String(copy.content));
    if (note.cancelled === true && was?.event && !was.event.cancelled && myAnswer(copy, me.person) !== "no") {
      const words = eventWords(was.event);
      if (await keepNotice(env.DB, { kind: "cancelled", fp: `gone-${id}`, group: g, item: id, target: id, actor: String(group.name), text: words })) {
        notifyLater(env, url.origin, work, { title: String(group.name), text: `Called off: ${words}`, hidden: "Called off an event you were going to",
          url: `/groups/${g}`, tag: `event-g${g}-${id}` });
      }
    }
    return json({ ok: true }, 202);
  }
  if (note.kind === "closed") return groupClosed(env, url, group, me, note);
  if (!["comment", "change", "calloff"].includes(note.kind)) return json({ error: "That didn't work." }, 400);
  const { entry, receipt } = note;
  const item = String(note.item ?? "");
  // One date of a repeating event called off (step 6d): on that date's own list, where it may be the first entry.
  const date = note.kind === "calloff" && note.date !== undefined ? note.date : null;
  if (date !== null && (typeof date !== "string" || !DATE_RE.test(date))) return json({ error: "That didn't work." }, 400);
  const list = date ? dateList(item, date) : item;
  if (!ID_RE.test(item) || !Number.isSafeInteger(entry?.n) || entry.n < (date ? 1 : 2) || !Number.isSafeInteger(entry.taken)
    || !ID_RE.test(entry.fp ?? "") || typeof entry.prev !== "string") return json({ error: "That didn't work." }, 400);
  // The group took it at that point: the head worked out again, and signed by the group.
  const state = await identityState(env, host);
  if (!state) return json({ error: "The group's identity couldn't be checked." }, 400);
  const head = await headOf({ host, list, prev: entry.prev, n: entry.n, fp: entry.fp, taken: entry.taken });
  const took = await checkHead(receipt, { hostingKey: state.current.hosting, host, list });
  if (!took || took.n !== entry.n || took.head !== head) return json({ error: "That receipt doesn't check." }, 400);
  const signed = await learnPeople(env, note.people, note);
  const got = await checkRecord(entry.sent, { ...lookupsWith(env, note.delegations), at: entry.taken });
  if (!got || got.fp !== entry.fp || got.record.kind !== note.kind || got.record.host !== host || got.record.item !== item
    || (got.record.date ?? null) !== date) {
    return json({ error: "That doesn't check." }, 400);
  }
  const author = got.record.author;
  if (author === me.person) return json({ ok: true }, 202);
  if (note.kind === "comment" && (await isBlocked(env.DB, author))) return json({ ok: true }, 202); // blocks.js
  const actor = (await namesFor(env.DB, [author])).get(author) ?? signed.get(author) ?? groupSays(note, author);
  const photo = note.photo && ID_RE.test(note.photo.post ?? "") && Number.isSafeInteger(note.photo.index) && note.photo.index >= 1 && note.photo.index <= 20 ? note.photo : null;
  const target = photo ? `${photo.post}/photos/${photo.index}` : item;
  if (note.kind === "comment") {
    const mentioned = (got.record.mentions ?? []).includes(me.person);
    const copy = await env.DB.prepare("SELECT author FROM copies WHERE id = ? AND group_id = ?").bind(photo ? photo.post : item, g).first();
    const own = copy && String(copy.author) === me.person ? 1 : 0;
    const there = !mentioned && !own && (await env.DB.prepare(`SELECT 1 FROM sent WHERE item = ? AND kind = 'comment' AND ${TAKEN_SQL} LIMIT 1`).bind(item).first());
    if (!mentioned && !own && !there) return json({ ok: true }, 202);
    const text = got.content?.text ?? "";
    const kept = await keepNotice(env.DB, { kind: mentioned ? "mention" : "comment", fp: entry.fp, group: g, own, item, target, actor, text, author });
    if (kept && mentioned) {
      await tellMention(env, url.origin, work, { group: g, title: String(group.name), actor, text, comment: true, url: link(target), tag: `mention-g${g}-${target}`, author });
    }
    return json({ ok: true }, 202);
  }
  // An event changed by whoever added it, or called off by an admin: the copy here brought up to date, and the owner
  // told, if it moved or is off and they hadn't said no.
  const copy = await env.DB.prepare("SELECT author, content, tally FROM copies WHERE id = ? AND group_id = ?").bind(item, g).first();
  if (!copy) return json({ ok: true }, 202);
  const was = JSON.parse(String(copy.content));
  if (!was.event) return json({ error: "That isn't a change to an event." }, 400);
  // Called off only by whoever added it, the group's owner, or an admin (as the owner's signed roles say: not the owner's
  // own event). Otherwise it isn't applied here, and the next pull, which checks the whole post, settles it.
  if (note.kind === "calloff") {
    const owner = (await identityState(env, String(group.identity)))?.current.owner ?? null;
    const writer = String(copy.author);
    const may = author === writer || author === owner
      || (owner && writer !== owner && (await checkRoles(env, group, String(owner), note.roles, note.delegations)).has(author));
    if (!may) return json({ ok: true }, 202);
  }
  if (date) return dateCalledOff(env, url, work, { group, me, copy, was, item, date, entry, actor });
  if (note.kind === "change" && author !== String(copy.author)) return json({ error: "That isn't theirs to change." }, 400);
  // A repeating one stays one (step 6d), with its dates called off as they were.
  const event = note.kind === "calloff" ? { ...was.event, cancelled: true } : cleanEvent(got.content?.event, { repeats: Boolean(was.event.rrule) });
  if (!event || Boolean(event.rrule) !== Boolean(was.event.rrule)) return json({ error: "That isn't a change to an event." }, 400);
  const { cancelled_at: _, skipped: __, ...plain } = event;
  void _; void __;
  const cancelled = Boolean(event.cancelled) && !was.event.cancelled;
  const moved = eventChanged(was.event, plain);
  const now_ = { ...was, event: { ...plain, ...(event.cancelled ? { cancelled_at: was.event.cancelled_at ?? entry.taken } : {}),
    ...(plain.rrule && was.event.skipped?.length ? { skipped: was.event.skipped.filter((d) => hasDate(plain, d)) } : {}) },
    ...(note.kind === "change" && typeof got.content.text === "string" ? { text: got.content.text.slice(0, 5000) } : {}) };
  await env.DB.prepare("UPDATE copies SET content = ?, changed_at = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(now_), entry.taken, item, g).run();
  if ((moved || cancelled) && myAnswer(copy, me.person) !== "no") {
    const kind = cancelled ? "cancelled" : "changed";
    const words = eventWords(now_.event);
    if (await keepNotice(env.DB, { kind, fp: entry.fp, group: g, item, target: item, actor, text: words })) {
      notifyLater(env, url.origin, work, { title: String(group.name), text: `${cancelled ? "Called off" : "Changed"}: ${words}`,
        hidden: cancelled ? "Called off an event you're going to" : "Changed an event you're going to", url: link(item), tag: `event-g${g}-${item}` });
    }
  }
  return json({ ok: true }, 202);
}

/**
 * The group's owner closed it (step 6e: groups.js): their `close` on its members list, with the group's receipt for
 * it, checked. The group's marked closed here (it goes 30 days after), and the owner told on Notifications.
 */
async function groupClosed(env, url, group, me, note) {
  const host = String(group.identity);
  const { entry, receipt } = note;
  if (!Number.isSafeInteger(entry?.n) || entry.n < 1 || !Number.isSafeInteger(entry.taken) || !ID_RE.test(entry.fp ?? "") || typeof entry.prev !== "string") {
    return json({ error: "That didn't work." }, 400);
  }
  const state = await identityState(env, host);
  if (!state?.current.owner) return json({ error: "The group's identity couldn't be checked." }, 400);
  const head = await headOf({ host, list: host, prev: entry.prev, n: entry.n, fp: entry.fp, taken: entry.taken });
  const took = await checkHead(receipt, { hostingKey: state.current.hosting, host, list: host });
  if (!took || took.n !== entry.n || took.head !== head) return json({ error: "That receipt doesn't check." }, 400);
  const signed = await learnPeople(env, note.people, note);
  const got = await checkRecord(entry.sent, { ...lookupsWith(env, note.delegations), at: entry.taken });
  // Only the group's owner closes it.
  if (!got || got.fp !== entry.fp || got.record.kind !== "close" || got.record.host !== host || got.record.item !== host
    || got.record.author !== String(state.current.owner)) return json({ error: "That doesn't check." }, 400);
  const g = Number(group.id);
  const marked = await env.DB.prepare("UPDATE groups SET closed_at = ?, closed_by = ? WHERE id = ? AND (closed_by IS NULL OR closed_by != ?)")
    .bind(entry.taken, entry.fp, g, entry.fp).run();
  if (marked.meta.changes && got.record.author !== me.person) {
    const actor = (await namesFor(env.DB, [got.record.author])).get(got.record.author) ?? signed.get(got.record.author) ?? groupSays(note, got.record.author);
    await keepNotice(env.DB, { kind: "closed", fp: entry.fp, group: g, item: host, target: "", actor, text: String(group.name) });
  }
  return json({ ok: true }, 202);
}

/**
 * One date of a repeating event called off (step 6d; the note checked by receiveGroupNote): the copy here marks it
 * off, and the owner is told if they'd said they were going that day, or might.
 */
async function dateCalledOff(env, url, work, { group, me, copy, was, item, date, entry, actor }) {
  const g = Number(group.id);
  if (!was.event.rrule || !hasDate(was.event, date)) return json({ error: "That isn't one of its dates." }, 400);
  const skipped = [...new Set([...(was.event.skipped ?? []), date])].sort();
  const tally = JSON.parse(String(copy.tally ?? "null"));
  const mine = tally?.dates?.[date]?.answers?.[me.person]?.answer ?? null;
  if (tally?.dates?.[date]) tally.dates[date].off = { by: entry.sent && parseRecord(fromB64url(entry.sent.record))?.author, at: entry.taken };
  await env.DB.prepare("UPDATE copies SET content = ?, tally = ?, changed_at = ? WHERE id = ? AND group_id = ?")
    .bind(JSON.stringify({ ...was, event: { ...was.event, skipped } }), tally ? JSON.stringify(tally) : null, entry.taken, item, g).run();
  if (mine === "going" || mine === "maybe") {
    const words = eventWords({ ...onDate(was.event, date), rrule: null });
    if (await keepNotice(env.DB, { kind: "cancelled", fp: entry.fp, group: g, item, target: `${item}?date=${date}`, actor, text: words })) {
      notifyLater(env, url.origin, work, { title: String(group.name), text: `Called off: ${words}`, hidden: "Called off a date you were going to",
        url: `/groups/${g}/posts/${item}?date=${date}`, tag: `event-g${g}-${item}-${date}` });
    }
  }
  return json({ ok: true }, 202);
}

/**
 * One date of a repeating event, read from the group and checked (step 6d): its list (lists.js dateList), under the
 * same rules as the event's (the event's writer and the group's admins may call it off). Returns {answers (as
 * itemkinds.js dateTally counts them, from what's signed), off, seen (where it's up to: null if nobody has answered),
 * mine, problem} or {error}.
 * @returns {Promise<{ error?: string, answers?: Record<string, any>, off?: any, seen?: { n: number, h: string } | null, mine?: string | null, problem?: string | null }>}
 */
export async function groupDate(env, from, group, id, date, admins = new Set()) {
  let data;
  try { data = await ask(env, from, group, `/_p/items/${id}/dates/${date}`); } catch (error) { return { error: busyMessage(group, error) }; }
  const mine = (await env.DB.prepare(`SELECT fp FROM sent WHERE item = ? AND ${TAKEN_SQL} ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(dateList(id, date)).first())?.fp ?? null;
  if (data?.empty === true) return { answers: {}, off: null, seen: null, mine, problem: null };
  await learnPeople(env, data.people, data);
  const state = await identityState(env, String(group.identity));
  if (!state || state.frozen || !state.current.owner) return { error: "The group's identity couldn't be checked." };
  const copy = await env.DB.prepare("SELECT author FROM copies WHERE id = ? AND group_id = ?").bind(id, group.id).first();
  const host = String(group.identity);
  const list = dateList(id, date);
  // An admin who called this date off: the owner's signed `role` the group sends with it.
  const dateAdmins = await checkRoles(env, group, String(state.current.owner), data.roles, data.delegations);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const from0 = data.checkpoint && (await checkHead(data.checkpoint, { hostingKey: state.current.hosting, host, list }));
  const result = await checkList({ host, hostingKey: state.current.hosting, list, owner: copy ? String(copy.author) : "", entries,
    signedHead: data.signedHead, from: from0 ? { n: from0.n, head: from0.head } : null, lookups: lookupsWith(env, data.delegations),
    group: { owner: String(state.current.owner), admin: (p) => admins.has(p) || dateAdmins.has(p) } });
  const day = dateTally(result.entries.map((e) => ({ e, r: e.record ? { record: e.record, content: e.content } : null })));
  const last = entries.find((e) => e.n === result.upTo);
  return { ...day, seen: last ? { n: last.n, h: last.head } : null, mine, problem: result.problem };
}

/** Which post one from afterwrd 1 became, by its old number there (step 10e), for its old link; null if none. */
export async function broughtPost(env, from, group, n) {
  try {
    const data = await ask(env, from, group, `/_p/items?old=${Number(n)}`);
    return ID_RE.test(data?.id ?? "") ? String(data.id) : null;
  } catch { return null; }
}

/** One of a group's posts this site doesn't keep (an older one, opened by a link): asked for, checked, and kept. */
export async function fetchGroupItem(env, from, group, id, people = []) {
  let data;
  try { data = await ask(env, from, group, `/_p/items?id=${id}`); } catch { return null; }
  await learnPeople(env, data.people, data);
  const item = Array.isArray(data.items) ? data.items.find((i) => i?.id === id) : null;
  const kept = item && (await keepCopy(env, { group: Number(group.id), host: String(group.identity), site: String(group.origin), rules: await copyRules(env, group, data) }, item, data.delegations));
  if (kept) await kept.statement.run();
  return kept ? groupCopy(env, group, id, people) : null;
}

/** A signed group's events kept here (copies), as pages show them: for its calendar, and the owner's Events. */
export async function groupEvents(env, group, people = []) {
  const { results } = await env.DB.prepare(`SELECT * FROM copies WHERE group_id = ? AND json_extract(content, '$.type') = 'event'
    ORDER BY created_at DESC LIMIT 500`).bind(group.id).all();
  return groupCopiesShown(env, group, results, people);
}
