// Groups from afterwrd 1, carried over in place (afterwrd 2, step 10d: docs/signed-conversations.md, "10d in detail").
// Same address, same name, the same people:
//   - Its owner brings it over with one passkey prompt, as making a group takes: its identity (groupidentity.js, which
//     also moves the members it had to group_members_before: they have no identity, so they aren't members of the
//     signed group until they re-join).
//   - Each member's site, at their next visit, finds it has come over (its identity at its address) and their browser
//     signs a `join`, with no prompt (static/ui/bringover.js). The group takes it from an old member's address for 30
//     days, as it takes one through an invite link (groupmembers.js takeJoin).
//   - Its owner's browser lets them in at its next visit: an `approve` each, through the same calls the owner's own
//     approve button makes (POST /_groups/<id>/point and /records). Old admins come back as members.
// (Its posts and comments from before come over in 10e.)
//
// The group's site:
//   POST /_group/rejoin/point   (signed by an old member's site) -> {person, item, seen, name, about}
//   POST /_group/rejoin         (signed by an old member's site) {sent, delegation, profile}: their `join`
// Members' and owners' sites, through /_admin/before (before.js): `rejoin` and `approve` for the browser.
import { siteCalling, bodyBytes, callFriend } from "./calls.js";
import { fetchIdentity } from "./identities.js";
import { groupSelf, takeJoin } from "./groupmembers.js";
import { theGroup } from "./groups.js";
import { loadMembers } from "./membership.js";
import { relaySent } from "./groupjoin.js";
import { ownerName } from "./sites.js";
import { json, now } from "./util.js";

const ASK_EVERY = 3600; // a member's site asks an old group whether it has come over at most this often
const APPROVE_EVERY = 600; // an owner's site looks for old members waiting at most this often
const MAX_REJOINING = 1000; // waiting at once to re-join (the group's members cap): none turned away for others waiting

/** An old member of this group (by their site's address) who may still re-join; null if not, or too late. */
async function oldMember(env, origin, windowSeconds) {
  return env.DB.prepare("SELECT * FROM group_members_before WHERE origin = ? AND since > ?").bind(origin, now() - windowSeconds).first();
}

const tooLate = () => json({ error: "You weren't in this group before afterwrd 2, or it's too late to come back this way: ask for an invite link." }, 403);

/** POST /_group/rejoin/point: what an old member's `join` says it saw, and the group, for their browser to sign. */
export async function rejoinPoint(request, env, url, windowSeconds) {
  const bytes = await bodyBytes(request);
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller) return json({ error: "Your site's signature didn't check." }, 401);
  if (!(await oldMember(env, caller.from, windowSeconds))) return tooLate();
  const self = await groupSelf(env);
  if (!self) return json({ error: "This group hasn't come over to afterwrd 2 yet." }, 409);
  const head = await env.DB.prepare("SELECT n, head FROM lists WHERE id = ?").bind(self.list).first();
  const group = await theGroup(env.DB);
  return json({ person: self.person, item: self.list, seen: head && Number(head.n) > 0 ? { n: Number(head.n), h: String(head.head) } : null,
    name: group?.name ?? "", about: group?.about ?? null });
}

/** POST /_group/rejoin: an old member's signed `join`, taken as an invite link's is; they wait for the owner's yes. */
export async function rejoin(request, env, url, windowSeconds) {
  const bytes = await bodyBytes(request);
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller) return json({ error: "Your site's signature didn't check." }, 401);
  if (!(await oldMember(env, caller.from, windowSeconds))) return tooLate();
  if (await env.DB.prepare("SELECT 1 FROM group_members WHERE origin = ? AND approved_at IS NOT NULL").bind(caller.from).first()) {
    return json({ error: "You're already in this group." }, 409);
  }
  let body = {};
  try { body = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); } catch {}
  const answer = await takeJoin(env, await theGroup(env.DB), caller, body, { maxWaiting: MAX_REJOINING });
  if (answer.ok) await env.DB.prepare("UPDATE group_members_before SET rejoined_at = ? WHERE origin = ?").bind(now(), caller.from).run();
  return answer;
}

// --- a member's site ---------------------------------------------------------------------------------------------------

/**
 * An old group (one the owner here was in on afterwrd 1) that has come over and is ready for their browser to sign a
 * `join` for: {group (its id here), host, item, seen, prev, name (as the owner here calls themselves)}; or null. A few
 * are asked each visit, each at most hourly.
 */
export async function nextRejoin(env, from) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT * FROM groups WHERE identity IS NULL AND joined_at IS NOT NULL AND origin IS NOT NULL
    AND COALESCE(role, 'member') != 'owner' AND COALESCE(before_asked_at, 0) < ? LIMIT 3`).bind(now() - ASK_EVERY).all();
  for (const group of results) {
    await db.prepare("UPDATE groups SET before_asked_at = ? WHERE id = ?").bind(now(), group.id).run();
    // Its identity, from its own address: only a group that has come over has one.
    const identity = await fetchIdentity(env, String(group.origin)).catch(() => null);
    if (!identity) continue;
    let point;
    try { point = await callFriend(env, from, String(group.origin), "/_group/rejoin/point", { body: {} }); } catch { continue; }
    if (point?.person !== identity.id || point.item !== identity.id) continue;
    return { group: Number(group.id), host: identity.id, item: identity.id, seen: point.seen ?? null, prev: null, name: await ownerName(db) };
  }
  return null;
}

/** POST /_admin/before {rejoin, sent}: the owner's browser signed a `join` for an old group; sent there, and kept. */
export async function sendRejoin(env, from, groupId, sent) {
  const db = env.DB;
  const group = await db.prepare("SELECT * FROM groups WHERE id = ? AND identity IS NULL AND joined_at IS NOT NULL").bind(groupId).first();
  if (!group) return json({ error: "That group has come over already, or isn't here." }, 404);
  const identity = await fetchIdentity(env, String(group.origin)).catch(() => null);
  if (!identity) return json({ error: "That group hasn't come over yet." }, 409);
  let reply;
  try {
    reply = await relaySent(env, sent, ["join"], identity.id, (body) => callFriend(env, from, String(group.origin), "/_group/rejoin", { body, timeout: 25_000 }));
  } catch (error) { return json({ error: error.message }, 409); }
  // A group with an identity now, as joining one makes it: asked for its posts from here on (groupcopies.js).
  await db.prepare("UPDATE groups SET identity = ?, brought_at = ?, items_since = NULL, items_checked_at = NULL WHERE id = ?")
    .bind(identity.id, now(), group.id).run();
  return json({ ok: true, receipt: reply.receipt ?? null });
}

// --- the owner's site --------------------------------------------------------------------------------------------------

/**
 * Old members of a group the owner here brought over, who've re-joined and are waiting: {group, joins: [their join's
 * fingerprint…]} for the owner's browser to approve; or null. Each group looked at no more than every 10 minutes, for its
 * 30 days.
 */
export async function nextApprovals(env, windowSeconds) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT * FROM groups WHERE role = 'owner' AND identity IS NOT NULL AND brought_at > ?
    AND COALESCE(before_asked_at, 0) < ? LIMIT 3`).bind(now() - windowSeconds, now() - APPROVE_EVERY).all();
  for (const group of results) {
    await db.prepare("UPDATE groups SET before_asked_at = ? WHERE id = ?").bind(now(), group.id).run();
    let data;
    try { data = await loadMembers(env, group); } catch { continue; }
    const joins = (data.members ?? []).filter((m) => m.waiting && m.before && m.join).map((m) => String(m.join));
    if (joins.length) return { group: Number(group.id), joins: joins.slice(0, 50) };
  }
  return null;
}

/** How many groups from before have something for this browser now (Home loads the bringing-over script for them). */
export async function groupsToBring(db, windowSeconds) {
  const at = now();
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM groups WHERE identity IS NULL AND joined_at IS NOT NULL AND origin IS NOT NULL
        AND COALESCE(role, 'member') != 'owner' AND COALESCE(before_asked_at, 0) < ?1)
    + (SELECT COUNT(*) FROM groups WHERE role = 'owner' AND identity IS NOT NULL AND brought_at > ?2 AND COALESCE(before_asked_at, 0) < ?3) AS n`)
    .bind(at - ASK_EVERY, at - windowSeconds, at - APPROVE_EVERY).first();
  return Number(row?.n ?? 0);
}

/** The owner's groups from before that are waiting for them to bring them over (one passkey prompt each, on its page). */
export async function groupsToBringOver(db) {
  const { results } = await db.prepare(`SELECT id, name FROM groups WHERE role = 'owner' AND identity IS NULL AND origin IS NOT NULL
    ORDER BY name COLLATE NOCASE LIMIT 5`).all();
  return results.map((r) => ({ id: Number(r.id), name: String(r.name) }));
}
