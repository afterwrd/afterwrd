// A group's signed members list, on the group's own site (afterwrd 2, step 6b; the rules are members.js). Members' sites
// call it with signed calls (calls.js), recognised by the identity each joined with; it calls them back the same way.
// group_members is worked out from the list as each record is taken, so the rest of the group (its posts, notes and
// limits) reads it.
//   POST /_join/<token>/accept   (signed) {sent, delegation, profile}: the joiner's own `join`, through an invite link
//   POST /_group/records         (signed, a member) {sent, delegation}: an approve, remove, role, leave, or (the
//                                owner) close (step 6e: groups.js)
//   GET  /_group/members         …with `list`: the members list as signed, for members' sites to check
import { checkCall, signCall } from "./signedcalls.js";
import { hostingKeyFor, identityState, checkProfile } from "./identities.js";
import { lookupsFor, ownHost } from "./items.js";
import { listEntries, readList, takeRecord } from "./hosted.js";
import { MemberRules } from "./members.js";
import { checkDelegation } from "./identity.js";
import { delegationsFor, peopleFor } from "./friendhost.js";
import { contentOf, parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { ownOrigin } from "./keys.js";
import { json, now } from "./util.js";

const TIMEOUT_MS = 8000;

/** The group's own identity, and its members list's id (the same): null before it has one. */
export async function groupSelf(env) {
  const host = await ownHost(env);
  return host ? { ...host, list: host.person } : null;
}

/**
 * The member a signed call is from (their row in group_members), or null. Only addresses of members who joined with
 * an identity are looked at, so a stranger can't make this site fetch anything.
 * @param {Request} request @param {Env} env @param {URL} url @returns {Promise<Row<"group_members"> | null>}
 */
export async function signedMember(request, env, url) {
  const from = request.headers.get("Afterwrd-From") ?? "";
  const member = from && (await env.DB.prepare("SELECT * FROM group_members WHERE origin = ? AND identity IS NOT NULL").bind(from).first());
  if (!member) return null;
  const body = request.method === "POST" ? new Uint8Array(await request.clone().arrayBuffer()) : null;
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site) => (person === member.identity && site === member.origin ? hostingKeyFor(env, person, site) : null) });
  return caller ? /** @type {Row<"group_members">} */ (/** @type {unknown} */ (member)) : null;
}

/** A call from the group to a member's site, signed by the group (for one that joined with an identity). */
export async function callMember(env, member, path, body) {
  const self = await ownHost(env);
  const from = await ownOrigin(env.DB);
  const text = JSON.stringify(body ?? {});
  const headers = await signCall({ method: "POST", url: member.origin + path, body: text, person: self.person, from, privateKey: self.privateKey });
  return fetch(member.origin + path, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...headers, "Content-Type": "application/json" }, body: text });
}

/** A member's signed record and the delegation behind it, checked as theirs; the record, or a reason it isn't. */
export async function theirs(env, person, { sent, delegation }) {
  const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
  if (!record || record.author !== person) return { error: "That isn't yours to send." };
  const state = await identityState(env, person);
  const dBytes = typeof delegation?.bytes === "string" ? fromB64url(delegation.bytes) : null;
  if (!state || !dBytes || (await checkDelegation(dBytes, delegation.proof, state, now())) !== record.key) return { error: "That isn't signed by you." };
  const { expires } = JSON.parse(new TextDecoder().decode(dBytes));
  await env.DB.prepare("INSERT OR REPLACE INTO known_delegations (key, person, bytes, proof, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(record.key, person, delegation.bytes, JSON.stringify(delegation.proof), expires).run();
  return { record, state };
}

/**
 * Someone asking to join, through an invite link already counted (groups.js): `caller` is who signed the call
 * ({person, from}). Takes their `join`, and they wait, as group_members has it. Returns a Response.
 */
export async function takeJoin(env, group, caller, body, { maxWaiting }) {
  const self = await groupSelf(env);
  if (!self) return json({ error: "This group isn't ready yet." }, 409);
  const got = await theirs(env, caller.person, body);
  if (got.error) return json({ error: got.error }, 400);
  if (got.record.kind !== "join" || got.record.item !== self.list) return json({ error: "That isn't a request to join this group." }, 400);
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NULL").first();
  if (Number(waiting?.n ?? 0) >= maxWaiting) return json({ error: "Too many people are waiting to join this group. Try again later." }, 429);
  const answer = await takeRecord(env.DB, { sent: body.sent, host: self, lookups: lookupsFor(env) });
  if (answer.refused) return json({ error: answer.refused }, 409);
  // Their name, as they signed it into their join (and their signed profile, kept to pass on, if they sent it).
  const said = await contentOf(got.record, body.sent.content, body.sent.salt);
  const named = { name: typeof said?.name === "string" && said.name.trim() ? said.name.trim().slice(0, 100) : null };
  const profile = body.profile && (await checkProfile(body.profile, got.state));
  if (profile) await env.DB.prepare("UPDATE identities SET profile = ? WHERE person = ?").bind(JSON.stringify(body.profile), caller.person).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM group_members WHERE origin = ? AND approved_at IS NULL").bind(caller.from),
    env.DB.prepare(`INSERT INTO group_members (group_id, origin, name, identity, join_fp, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(group.id, caller.from, (named?.name ?? "Someone").slice(0, 100), caller.person, answer.entry.fp, now()),
  ]);
  return json({ ok: true, id: group.id, name: group.name, about: group.about, receipt: answer.receipt, person: self.person });
}

/**
 * A member's decision, their leaving, or the owner closing the group: `member` (their row) sent `body` ({sent,
 * delegation}). Taken onto the members list if its rules allow, then group_members brought into line. `tell(member)`: a
 * removed member's site, told. Once the group's `closed`, nothing more is taken (members.js); `onClose(entry)`: the
 * owner's close, just taken.
 */
export async function takeMemberRecord(env, group, member, body, { maxMembers, tell, closed = false, onClose }) {
  const self = await groupSelf(env);
  if (!self) return json({ error: "This group isn't ready yet." }, 409);
  const got = await theirs(env, String(member.identity), body);
  if (got.error) return json({ error: got.error }, 400);
  const { record } = got;
  if (!["approve", "remove", "role", "leave", "close"].includes(record.kind) || record.item !== self.list) return json({ error: "That isn't about this group's members." }, 400);
  if (closed) return json({ error: "This group has closed." }, 409);
  if (record.kind === "close" && member.role !== "owner") return json({ error: "Only the group's owner can close it." }, 403);
  const target = record.kind === "leave" || record.kind === "close" ? member
    : await env.DB.prepare("SELECT * FROM group_members WHERE join_fp = ?").bind(record.about).first();
  if (!target) return json({ error: "They aren't in this group, or asking." }, 404);
  if (record.kind === "approve") {
    const inGroup = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NOT NULL").first();
    if (Number(inGroup?.n ?? 0) >= maxMembers + 1) return json({ error: `The group is full: it can have up to ${maxMembers} members besides its owner.` }, 409);
  }
  const answer = await takeRecord(env.DB, { sent: body.sent, host: self, lookups: lookupsFor(env) });
  if (answer.refused) return json({ error: answer.refused }, 409);
  const db = env.DB;
  if (record.kind === "approve") await db.prepare("UPDATE group_members SET approved_at = ? WHERE id = ?").bind(now(), target.id).run();
  if (record.kind === "role") {
    const role = (await contentOf(record, body.sent.content, body.sent.salt))?.role;
    if (role === "admin" || role === "member") await db.prepare("UPDATE group_members SET role = ? WHERE id = ?").bind(role, target.id).run();
  }
  if (record.kind === "remove" || record.kind === "leave") {
    if (record.kind === "remove") await tell(target);
    await db.prepare("DELETE FROM group_members WHERE id = ?").bind(target.id).run();
  }
  if (record.kind === "close") await onClose(answer.entry);
  return json({ ok: true, receipt: answer.receipt, n: answer.entry?.n ?? null });
}

/** The members list's rules as they stand (who's in, waiting, and admin). */
export async function membersNow(env, self) {
  const row = await env.DB.prepare("SELECT owner FROM lists WHERE id = ?").bind(self.list).first();
  const rules = new MemberRules({ host: self.person, list: self.list, owner: row ? String(row.owner) : null });
  for (const e of await listEntries(env.DB, self.list)) {
    const record = e.sent ? parseRecord(fromB64url(e.sent.record)) : null;
    const content = record && e.sent.content ? await contentOf(record, e.sent.content, e.sent.salt) : undefined;
    await rules.add({ fp: e.fp, taken: e.taken, record, head: e.head, content });
  }
  return rules;
}

/** The members list as signed, for members' sites to check: its entries, the group's signature on its end, and who's in it. */
export async function signedMembers(env) {
  const self = await groupSelf(env);
  if (!self) return null;
  const list = await readList(env.DB, self.list, { host: self });
  if (!list) return null;
  const records = list.entries.filter((e) => e.sent).map((e) => parseRecord(fromB64url(e.sent.record))).filter(Boolean);
  const people = [...new Set([list.owner, ...records.map((r) => r.author)])];
  return { group: self.person, owner: list.owner, entries: list.entries, signedHead: list.signedHead, checkpoint: list.checkpoint ?? null,
    delegations: await delegationsFor(env.DB, records.map((r) => r.key)), people: await peopleFor(env.DB, people) };
}
