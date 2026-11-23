// A group's signed members list (afterwrd 2, step 6b: members.js), from a member's own site. What the owner here does
// about it is signed in their browser (ui/groupsign.js) and passed on in a signed call, as their comments on a friend's
// post are; this site keeps its own copy (`sent`) with the group's receipt.
//   POST /_groups/join/point     {link} -> {host, item, seen, prev}: what a `join` through that link says
//   POST /_groups/join           {link, sent}: asking to join, with it (membership.js)
//   POST /_groups/<id>/point     -> {host, item, seen, prev, role_at}: what a record about the group's members says it
//                                saw, from the list as this site has checked it
//   POST /_groups/<id>/records   {sent}: an approve, remove, role, leave or (its owner) close, passed on
// And a group calls this site's /_member/… with signed calls (signedGroup).
import { callFriend } from "./calls.js";
import { checkCall } from "./signedcalls.js";
import { fetchIdentity, hostingKeyFor, identityState, learnPeopleIn, signersIn } from "./identities.js";
import { checkList } from "./lists.js";
import { fitToKeep, keepThread, keptList } from "./threads.js";
import { MemberRules } from "./members.js";
import { ID_RE, ownHost } from "./items.js";
import { ownOrigin } from "./keys.js";
import { parseRecord } from "../public/static/records.js";
import { decode, fromB64url } from "../public/static/signed.js";
import { now, Refusal } from "./util.js";
import { keepSent as keepSentAs, TAKEN_SQL, willRetry } from "./sentchecks.js";
import { ownerName } from "./sites.js";
import { admit } from "./allowances.js";

/** The owner's newest record on a group's members list that this site sent (what their next one follows). */
const lastSent = async (db, list) => (await db.prepare(`SELECT fp FROM sent WHERE item = ? AND ${TAKEN_SQL} ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(list).first())?.fp ?? null;

/** What a `join` through an invite link says: the group (from what the link's group says), and where its list is up to. */
export async function joinPoint(env, info) {
  if (!ID_RE.test(info.person ?? "")) throw new Refusal("That group needs updating before you can join it.");
  // name: as the owner here calls themselves, signed into their join, so the group and its members can name them.
  return { host: info.person, item: info.person, seen: info.members ?? null, prev: await lastSent(env.DB, info.person), name: await ownerName(env.DB) };
}

/** The owner's signed record, with the delegation behind it, ready to pass on; throws a Refusal if it can't be. */
async function ready(env, sent, kinds, list) {
  const me = await ownHost(env);
  const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
  if (!me || !record || record.author !== me.person || !kinds.includes(record.kind) || record.item !== list || record.host !== list) {
    throw new Refusal("That didn't work. Try again.");
  }
  const delegation = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(record.key, now()).first();
  if (!delegation) throw new Refusal("This browser can't sign for you any more. Sign out and sign in again.");
  const own = await env.DB.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
  return { record, body: { sent, delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) },
    ...(own?.profile && { profile: JSON.parse(String(own.profile)) }) } };
}

/** Keeps the owner's own copy of what they sent a group, with its receipt; returns its fingerprint. */
const keepSent = (env, record, sent, receipt, error = null) => keepSentAs(env, { record, sent, list: record.item, receipt, error });

/**
 * The owner's signed record about a group's members (`list`, of the kinds given), passed on by `send(body)` and kept
 * with the group's receipt; returns what the group answered. Throws a Refusal if it can't be sent, or isn't taken.
 */
export async function relaySent(env, sent, kinds, list, send) {
  const { record, body } = await ready(env, sent, kinds, list);
  let reply;
  try { reply = await send(body); } catch (error) { throw new Refusal(error.message); }
  await keepSent(env, record, sent, reply.receipt ?? null);
  return reply;
}

/** Asks to join a group with an identity (`info`: linkInfo's answer), with the owner's signed `join`. Returns its id here. */
export async function joinSigned(env, info, sent) {
  const { record, body } = await ready(env, sent, ["join"], String(info.person));
  // The group's identity, from its own address, must be the one the link's group says.
  const group = await fetchIdentity(env, info.origin);
  if (!group || group.id !== info.person) throw new Refusal("That group's identity doesn't check.");
  let reply;
  try {
    reply = await callFriend(env, await ownOrigin(env.DB), info.origin, `/_join/${info.token}/accept`, { body, timeout: 25_000 });
  } catch (error) { throw new Refusal(error.message); }
  await keepSent(env, record, sent, reply.receipt ?? null);
  const db = env.DB;
  await db.prepare("DELETE FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NULL").bind(info.origin, info.id).run();
  const row = await db.prepare(`INSERT INTO groups (name, about, created_at, origin, remote_id, host_name, role, identity, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?) RETURNING id`).bind(info.name, info.about, now(), info.origin, info.id, info.owner, info.person, now()).first();
  return Number(row.id);
}

/**
 * A group's members list as this site has checked it (`data`: what GET /_group/members gave as `afterwrd:list`): its
 * rules as they stand, and where it's up to. Throws a Refusal if it doesn't check.
 */
export async function checkMembers(env, group, data, { rules = null } = {}) {
  const person = String(group.identity);
  if (!data || data.group !== person) throw new Refusal("The group didn't send its members list.");
  let state = await identityState(env, person);
  if (!state) state = await fetchIdentity(env, String(group.origin));
  if (!state || state.id !== person || state.frozen) throw new Refusal("The group's identity doesn't check.");
  // Only those who signed something on the list (identities.js learnPeopleIn).
  await learnPeopleIn(env, data.people, signersIn(data.entries));
  // A group with nobody in it yet but its owner has nothing on its list, and nothing for the group to sign.
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length && !rules) {
    if (data.owner !== state.current.owner) throw new Refusal("The group's members list doesn't check.");
    return { entries: [], upTo: 0, head: "", problem: null, rules: new MemberRules({ host: person, list: person, owner: String(data.owner) }) };
  }
  const checked = await checkList({ host: person, hostingKey: state.current.hosting, list: person, owner: String(data.owner ?? ""), Kind: MemberRules,
    entries, signedHead: data.signedHead, rules,
    lookups: { identityOf: (p) => identityState(env, p), delegationOf: async (key) => data.delegations?.[key] ?? null } });
  if (checked.problem || data.owner !== state.current.owner) throw new Refusal("The group's members list doesn't check.");
  return checked;
}

/**
 * The group's members list as this site has checked it, through `fetch` (a path on the group's site: its answer).
 * Kept as checked (threads.js), so after the first time only what's after the point it got to is asked for and checked,
 * carrying on from who's in as it stood (step 9, option 4A: fetching and checking it whole for every decision made
 * letting 1,000 people in quadratic, and the list 4.6 MB). If what's new doesn't follow on, it's read whole, as before.
 */
export async function checkedMembers(env, group, fetch) {
  const db = env.DB;
  const person = String(group.identity);
  const kept = await keptList(db, person);
  const state = kept && (await identityState(env, person));
  if (kept && state?.current.owner) {
    try {
      const data = (await fetch(`/_group/members/list?after=${kept.at(-1).n}`))?.["afterwrd:list"];
      const rules = await new MemberRules({ host: person, list: person, owner: String(state.current.owner) }).carryOn(kept);
      const checked = await checkMembers(env, group, data, { rules });
      const heads = new Map((Array.isArray(data.entries) ? data.entries : []).map((e) => [e.n, e.head]));
      const fresh = checked.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null }));
      if (fresh.length && fitToKeep(fresh)) await keepThread(db, person, [...kept, ...fresh], fresh[0].n);
      return checked;
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // Doesn't follow on from what's kept: read whole, below.
    }
  }
  const data = (await fetch("/_group/members/list"))?.["afterwrd:list"];
  const checked = await checkMembers(env, group, data);
  const heads = new Map((Array.isArray(data?.entries) ? data.entries : []).map((e) => [e.n, e.head]));
  const all = checked.entries.map((e) => ({ ...e, head: heads.get(e.n) ?? null }));
  if (all.length && all[0].n === 1 && fitToKeep(all)) await keepThread(db, person, all);
  else await db.prepare("DELETE FROM thread_cache WHERE list = ?").bind(person).run();
  return checked;
}

/** POST /_groups/<id>/point: what a record about `group`'s members says it saw (`fetch`: as checkedMembers takes). */
export async function membersPoint(env, group, fetch) {
  const checked = await checkedMembers(env, group, fetch);
  const me = await ownHost(env);
  const at = checked.upTo ? { n: checked.upTo, h: checked.head } : null;
  return { host: group.identity, item: group.identity, seen: at, prev: checked.rules.lastOf.get(me.person) ?? null, role_at: at };
}

/**
 * What a record says it saw for someone still waiting to be let in, who can't read the list: the point their own newest
 * record there was taken at, as the group's receipt says.
 */
export async function waitingPoint(env, group) {
  const row = await env.DB.prepare(`SELECT fp, receipt FROM sent WHERE item = ? AND ${TAKEN_SQL} ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(group.identity).first();
  const head = row?.receipt ? decode(fromB64url(JSON.parse(String(row.receipt)).bytes)) : null;
  if (!head || !Number.isSafeInteger(head.n) || !ID_RE.test(head.head ?? "")) throw new Refusal("Your request to join can't be found. Remove the group, and ask again.");
  return { host: group.identity, item: group.identity, seen: { n: head.n, h: head.head }, prev: String(row.fp), role_at: null };
}

/** POST /_groups/<id>/records: the owner's signed record about the group's members, passed on. Returns {record, fp}. */
export async function relayGroupRecord(env, group, sent, send) {
  const { record, body } = await ready(env, sent, ["approve", "remove", "role", "leave", "close"], String(group.identity));
  let reply;
  try { reply = await send("/_group/records", body); } catch (error) {
    // A leave is kept to send again (sentchecks.js).
    await keepSent(env, record, sent, null, error);
    if (!(error.status === 409 && error.message === "duplicate")) throw new Refusal(`${error.message}.${willRetry(record)}`);
    reply = {};
  }
  return { record, fp: await keepSent(env, record, sent, reply.receipt ?? null) };
}

/**
 * The group a signed call to /_member/… is from (its row here), or null: only a group with an identity, at the address
 * it joined from, signing as itself.
 */
export async function signedGroup(request, env, url) {
  const from = request.headers.get("Afterwrd-From") ?? "";
  const group = from && (await env.DB.prepare("SELECT * FROM groups WHERE origin = ? AND identity IS NOT NULL AND joined_at IS NOT NULL").bind(from).first());
  if (!group) return null;
  const body = request.method === "POST" ? new Uint8Array(await request.clone().arrayBuffer()) : null;
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site, options) => (person === group.identity && site === group.origin ? hostingKeyFor(env, person, site, options) : null) });
  if (!caller) return null;
  await admit(env, String(group.identity)); // within its allowance here today, or refused (allowances.js)
  return group;
}
