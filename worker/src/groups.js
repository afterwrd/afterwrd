// A group's own Worker: afterwrd in group mode (the secret GROUP_KEY is set; see index.js). It holds one group: its
// members list and its posts, each signed by whoever wrote it (afterwrd 2: docs/signed-conversations.md, step 6). No one
// signs in here. Everyone, the person who made it included, uses it from their own afterwrd site, in calls signed by
// that site (calls.js); it knows its members by the identity each joined with (groupmembers.js), and holds nothing but
// the group. Its posts are at /_p/… (groupposts.js); this is the rest.
//
// Setting up, once, straight after its owner's site has made this Worker (groupsites.js):
//   GET  /_group/ping             that it's running, its version, and its hosting key
//   POST /_group/claim            (signed) {setup, name, about, owner}: the owner's site, with the GROUP_KEY it made this
//                                 Worker with; its owner's name, as they call themselves. The owner is its first member.
//   POST /_group/identity         (signed, from the site that claimed it) its identity, once (groupidentity.js)
// Joining, with an invite link (made by an admin; it lasts 14 days and anyone it's sent to can use it, but each use is
// only a request, and an admin lets them in, or not):
//   GET  /_join/<token>           the page the link opens: asks where your site is, and sends you there
//   GET  /_join/<token>/info      the group, for the joiner's site to show (and sign their `join` by) before they confirm
//   POST /_join/<token>/accept    (signed) the joiner's own signed `join`
// Members' sites (signed calls; someone not yet let in may only take their request back):
//   GET  /_group/members          who's in it, with the members list as signed
//   GET  /_group/members/list     the members list as signed, alone; ?after=: only what's after that point
//   POST /_group/records          a signed approve, remove, role, leave, or (the owner) close
// Admins (the owner, and members the owner makes admins):
//   GET  /_group/admin/members    everyone, with requests to join
//   POST /_group/admin/link       a new invite link (the old one stops working)
//   POST /_group/admin/about      {name, about}
//   POST /_group/admin/here       {on}: whether any member may use @here (mentions.js), or only the owner and admins
//   GET  /_group/admin/reports    what members have raised with the admins (reports.js)
//   POST /_group/admin/unremove   {person}: someone removed may ask to join again
//   POST /_group/admin/reports/leave   {about, word?}: looked at, and left
// Closing (step 6e): the owner's signed `close` on the members list closes the group. Every member's site is told (a
// signed note; anyone missed sees it at their next pull), and for CLOSE_SECONDS (30 days) it answers read-only: its
// members list, posts and threads, and members deleting what they wrote. Then it empties itself, and its owner's site
// deletes its Worker:
//   POST /_group/admin/end        the owner, once the 30 days are up: empties it, if it hasn't already
// Groups made on afterwrd 1 kept their posts in group_* tables, read-only now, until migration (step 10). Once one has
// come over (10d), for 30 days:
//   POST /_group/rejoin/point, /_group/rejoin   its members from before joining again (beforegroups.js)
//   POST /_group/before                         its posts and comments from before, brought over (beforehistory.js)
import { rejoin, rejoinPoint } from "./beforegroups.js";
import { windowOf } from "./before.js";
import { answerGroupBefore } from "./beforehistory.js";
import { actorId, groupId, iso, tidy, CONTEXT } from "../public/static/activity.js";
import { fromB64url, PROTOCOL } from "../public/static/signed.js";
import { parseRecord } from "../public/static/records.js";
import { delegationsFor, peopleFor } from "./friendhost.js";
import { clearUp, roleProofs } from "./groupposts.js";
import pkg from "../package.json";
import { mediaStore } from "./media.js";
import { groupLinkPage, messagePage } from "./views/pages.js";
import { removeUnusedFiles } from "./posts.js";
import { html, json, now, randomToken, sha256 } from "./util.js";
import { hostingKey } from "./keys.js";
import { setGroupIdentity } from "./groupidentity.js";
import { callMember, groupSelf, signedMember, signedMembers, takeJoin, takeMemberRecord } from "./groupmembers.js";
import { outbox } from "./outbox.js";
import { leaveIt, raised } from "./reports.js";
import { bodyBytes, siteCalling } from "./calls.js";

export const MAX_MEMBERS = 1000; // besides its owner (docs/signed-conversations.md: up to 1,000 members)
/** The member cap: MAX_MEMBERS, or in a scale test (self-hosted, with TEST_SCALE) whatever TEST_MAX_MEMBERS says. */
export const maxMembers = (env) => (env.TEST_SCALE && env.HOSTING === "self" && Number(env.TEST_MAX_MEMBERS)) || MAX_MEMBERS;
const MAX_WAITING = 50;
export const MAX_GROUP_PHOTOS = 8; // each is two files to copy from the member's site: within the free plan's 50 calls
export const MAX_GROUP_TEXT = 5000;
export const MAX_GROUP_NAME = 100;
export const MAX_GROUP_RULES = 2000;
export const MAX_GROUP_ABOUT = 1000;
const LINK_SECONDS = 14 * 86400;
const LINK_REQUESTS = 100; // requests to join one invite link can make
const WAITING_SECONDS = 7 * 86400; // a request to join no one has answered is dropped after this
const COPY_TIMEOUT_MS = 20_000;
// Photos as members' sites make them (2560px JPEGs, upload.js) are well within these.
export const PHOTO_BYTES = 8_000_000;
export const THUMB_BYTES = 1_000_000;
export const GROUP_BYTES = 1_000_000_000; // all the group's photos: free Cloudflare accounts have 5 GB for everything
// From one member's site.
export const POST_RATE = { count: 10, seconds: 600, daily: 50, photos: 40 };
// @here (mentions.js): its owner and admins may use it, or anyone if they've said so (here_anyone); either way only a
// few a day for each member, and for the group (groupposts.js).
export const HERE_LIMITS = { member: 3, group: 10 };

// How long a closed group goes on answering (step 6e). Shorter only on local test sites (app.js, with ALLOW_LOCAL_SITES
// and TEST_CLOSE_SECONDS), so a test can see one end.
export let CLOSE_SECONDS = 30 * 86400;
export function testCloseSeconds(seconds) {
  if (Number.isSafeInteger(seconds) && seconds > 0) CLOSE_SECONDS = seconds;
}

export const cleanText = (text) => (typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "");
export const cleanName = (name, fallback = "Someone") => (typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : fallback);
export const isAdmin = (member) => member.role === "owner" || member.role === "admin";

/** The group this Worker holds, or null before it's claimed. */
/** @type {(db: D1Database) => Promise<Row<"groups"> | null>} */
export const theGroup = (db) => db.prepare("SELECT * FROM groups WHERE origin IS NULL ORDER BY id LIMIT 1").first();
const ownerOf = (db) => db.prepare("SELECT origin, name FROM group_members WHERE role = 'owner' LIMIT 1").first();

/** Whether a group (its row) has closed, and when it goes. */
export const closedGroup = (group) => (group?.closed_at ? { at: Number(group.closed_at), goes: Number(group.closed_at) + CLOSE_SECONDS } : null);

// --- what members' sites read ---------------------------------------------------------------------------------------

/** Names in the order SQLite's COLLATE NOCASE gives: ASCII letters without case, everything else as it is. */
const foldAscii = (name) => String(name).replace(/[A-Z]/g, (c) => c.toLowerCase());
const byName = (a, b) => {
  const [x, y] = [foldAscii(a), foldAscii(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The group's members as groupObject last read them, and where the members list was then (this object's memory). */
let membersKept = null;

/** The group as a Group: its owner, how many members it has, and (for the member asking) their role. */
export async function groupObject(db, site, group, member) {
  // Every member's every pull reads this, so what grows with the group is read only when it's changed: the members
  // are kept in memory until the signed members list moves on (its `lists` row, one row to read), sorted here, not by
  // SQLite; those waiting are counted only for an admin, who's the only one told.
  const point = await db.prepare("SELECT l.n FROM lists l JOIN own_identity o ON l.id = o.person WHERE o.id = 1").first();
  const known = point && membersKept?.n === Number(point.n) ? membersKept.results : null;
  const [owner, members, waiting] = await db.batch([
    db.prepare("SELECT origin, name FROM group_members WHERE role = 'owner' LIMIT 1"),
    known ? db.prepare("SELECT 1 WHERE 0") : db.prepare("SELECT origin, name, identity FROM group_members WHERE approved_at IS NOT NULL"),
    ...(isAdmin(member) ? [db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NULL")] : []),
  ]);
  if (known) members.results = known;
  else {
    members.results.sort((a, b) => byName(a.name, b.name));
    if (point) membersKept = { n: Number(point.n), results: members.results };
  }
  const o = owner.results[0];
  const closed = closedGroup(group);
  return {
    type: "Group", id: groupId(site, group.id), name: group.name, summary: group.about || undefined, published: iso(group.created_at),
    "afterwrd:rules": group.rules || undefined,
    attributedTo: o ? { type: "Person", id: actorId(o.origin), name: o.name } : undefined,
    "afterwrd:members": members.results.length, "afterwrd:role": member.role,
    "afterwrd:waiting": waiting ? waiting.results[0].n : undefined,
    // Mentions (mentions.js): who's in it, with who they are, to mention, and who may use @here.
    "afterwrd:people": members.results.map((m) => ({ type: "Person", id: actorId(m.origin), name: m.name, ...(m.identity && { "afterwrd:person": m.identity }) })),
    "afterwrd:hereAnyone": Boolean(group.here_anyone), "afterwrd:mayHere": isAdmin(member) || Boolean(group.here_anyone),
    // Closed by its owner (step 6e): when, and the `close` on its members list, which members' sites check.
    ...(closed && { "afterwrd:closedAt": iso(closed.at), "afterwrd:goesAt": iso(closed.goes), "afterwrd:close": group.closed_by ?? undefined }),
  };
}

/** Clears up what a removed member wrote (groupposts.js clearUp), a go at a time; marked while there's more to go. */
async function clearing(env, person) {
  await env.DB.prepare("UPDATE group_removed SET clearing = 1 WHERE person = ?").bind(person).run();
  const { more } = await clearUp(env, person);
  if (!more) await env.DB.prepare("UPDATE group_removed SET clearing = 0 WHERE person = ?").bind(person).run();
}

/**
 * Who's in the group. For an admin (`all`), requests to join too. With each member's identity and join; the members
 * list as signed, to check and sign by, is GET /_group/members/list.
 */
async function groupMembers(env, site, group, member, { all = false } = {}) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT m.id, m.origin, m.name, m.role, m.created_at, m.approved_at, m.identity, m.join_fp,
    b.rejoined_at AS rejoined FROM group_members m LEFT JOIN group_members_before b ON b.origin = m.origin
    WHERE m.group_id = ? ${all ? "" : "AND m.approved_at IS NOT NULL"} ORDER BY m.role = 'member', m.name COLLATE NOCASE`).bind(group.id).all();
  return tidy({
    "@context": CONTEXT, type: "Collection", context: await groupObject(db, site, group, member), totalItems: results.length,
    // For admins: who's been removed, and can't ask to join again until an admin lets them.
    ...(all && { "afterwrd:removed": (await db.prepare("SELECT person, name, removed_at FROM group_removed ORDER BY removed_at DESC LIMIT 200").all()).results
      .map((r) => ({ "afterwrd:person": r.person, name: r.name, "afterwrd:removedAt": iso(r.removed_at) })) }),
    items: results.map((m) => ({
      type: "Person", id: actorId(m.origin), name: m.name, "afterwrd:role": m.role,
      "afterwrd:joinedAt": iso(m.approved_at), ...(all && { "afterwrd:member": m.id, "afterwrd:waiting": !m.approved_at }),
      // Waiting, and in the group before afterwrd 2: re-joining (beforegroups.js), for the owner's browser to let in.
      ...(all && !m.approved_at && m.rejoined && { "afterwrd:before": true }),
      ...(m.identity && { "afterwrd:person": m.identity, "afterwrd:join": m.join_fp ?? undefined }),
    })),
  });
}

// --- photos, copied from members' sites ---------------------------------------------------------------------------------

/** A body that stops with an error after `limit` bytes. */
function capped(body, limit) {
  let seen = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) controller.error(new Error("too big"));
      else controller.enqueue(chunk);
    },
  }));
}

/**
 * Copies a member's photos here from their site, one file at a time, each no bigger than it should be; the media
 * store checks each file matches its hash (and keeps one it already has). Two calls out per file: within the free
 * plan's 50 for a post's 8 photos and their thumbnails.
 */
export async function copyPhotos(env, photos) {
  const files = [...new Map(photos.flatMap((p) => [[p.hash, [p.src, PHOTO_BYTES]], [p.thumb_hash, [p.thumbSrc, THUMB_BYTES]]])).entries()];
  for (const [hash, [link, limit]] of files) {
    let response;
    try {
      response = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(COPY_TIMEOUT_MS) });
    } catch {
      throw new Error("Couldn't fetch a photo from your site.");
    }
    if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      throw new Error("Couldn't fetch a photo from your site.");
    }
    const stored = await mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
      method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: capped(response.body, limit),
    })).catch(() => null);
    if (!stored?.ok) throw new Error("A photo arrived damaged, or is too big.");
  }
}

// --- running the group ------------------------------------------------------------------------------------------------

/** Tells a member's site it's no longer in the group, if it can be reached. */
/**
 * Tells a member's site it was removed (or its request turned down), with the signed removal and where the group took
 * it (`proof`: {sent, entry, receipt}), and what shows its writer could: their admin role, and the delegations behind it.
 */
async function tellRemoved(env, member, proof) {
  try {
    const self = await groupSelf(env);
    const owner = self && (await env.DB.prepare("SELECT owner FROM lists WHERE id = ?").bind(self.list).first())?.owner;
    const record = parseRecord(fromB64url(proof.sent.record));
    const roles = self && record && record.author !== owner ? await roleProofs(env, { ...self, owner: String(owner) }, [record.author]) : {};
    const keys = [record?.key, ...Object.values(roles).flatMap((r) => [r.join, r.role].map((x) => parseRecord(fromB64url(x.record))?.key))].filter(Boolean);
    // With who decided (and their role's proof): someone still waiting has never pulled the group, so their site may not
    // know an admin yet.
    const people = await peopleFor(env.DB, [record?.author].filter(Boolean));
    const response = await callMember(env, member, "/_member/removed", { ...proof, roles, delegations: await delegationsFor(env.DB, keys), people });
    await response.body?.cancel();
  } catch {}
}

/**
 * The owner's `close`, just taken onto the members list (`entry`): the group is closed from now. No more invite links;
 * every member's site is told with a signed note (groupposts.js groupNoteFor), and it goes CLOSE_SECONDS from now.
 */
async function closed(env, origin, group, entry) {
  const db = env.DB;
  await db.batch([
    db.prepare("UPDATE groups SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL").bind(entry.taken, entry.fp, group.id),
    db.prepare("DELETE FROM group_links"),
  ]);
  const self = await groupSelf(env);
  await outbox(env).sendNote({ origin, kind: "closed", item: self.list, fp: entry.fp, audience: "members" });
}

/**
 * Empties a closed group, once its 30 days are up: its posts, photos, lists, members and links all go. Only the closed
 * mark stays (so it can't be claimed again), until its owner's site deletes its Worker. Groups from before signing
 * (group_*) are emptied too: nobody can read them here any more.
 */
async function empty(env) {
  const db = env.DB;
  if (await db.prepare("SELECT 1 FROM settings WHERE key = 'group_closed'").first()) return;
  const { results: photos } = await db.prepare("SELECT hash, thumb_hash FROM group_photos UNION ALL SELECT hash, thumb_hash FROM media WHERE item_id IS NOT NULL").all();
  await db.batch([
    ...["group_comments", "group_comment_versions", "group_photos", "group_answers", "group_event_skips", "group_poll_votes", "group_polls",
      "group_events", "group_posts", "group_post_versions", "group_links", "group_members", "groups",
      "items", "item_photos", "lists", "list_pages", "checkpoints", "authored", "here_log",
      // What was raised with its admins (copies of what was said, names, notes), the day's caps, and who was removed:
      // all of it goes with the group (reports.js).
      "reports", "report_caps", "group_removed"].map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare("DELETE FROM media WHERE item_id IS NOT NULL"),
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('group_closed', '1')"),
  ]);
  await removeUnusedFiles(env, photos.flatMap((f) => [f.hash, f.thumb_hash]));
}

/**
 * Whether this group has gone: emptied, or closed more than CLOSE_SECONDS ago (and so emptied now). Every request but a
 * ping and its identity asks first.
 */
export async function groupGone(env) {
  const db = env.DB;
  if (await db.prepare("SELECT 1 FROM settings WHERE key = 'group_closed'").first()) return true;
  const group = await theGroup(db);
  const shut = closedGroup(group);
  if (!shut || shut.goes > now()) return false;
  await empty(env);
  return true;
}

/** The owner's site claims the group, once, in a signed call, with the GROUP_KEY it made this Worker with. */
async function claim(request, env, url) {
  const db = env.DB;
  const bytes = await bodyBytes(request);
  let body = {};
  try { body = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); } catch {}
  if (typeof body.setup !== "string" || (await sha256(body.setup)) !== (await sha256(env.GROUP_KEY))) return json({ error: "Not this group's key." }, 403);
  if (await theGroup(db) || await db.prepare("SELECT 1 FROM settings WHERE key = 'group_closed'").first()) {
    return json({ error: "This group is already set up." }, 409);
  }
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller || caller.from === url.origin) return json({ error: "Your site's signature didn't check. Is it on the same version of afterwrd?" }, 401);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_GROUP_NAME) : "";
  if (!name) return json({ error: "Give the group a name." }, 400);
  const about = cleanText(body.about).slice(0, MAX_GROUP_ABOUT) || null;
  const owner = cleanName(body.owner);
  // Group 1, always: its addresses are <this site>/groups/1/…. Its owner is recognised by their identity once the
  // group has its own (groupidentity.js), and until then, for that alone, by the site that claimed it.
  await db.batch([
    db.prepare("INSERT INTO groups (id, name, about, created_at) VALUES (1, ?, ?, ?)").bind(name, about, now()),
    db.prepare(`INSERT INTO group_members (group_id, origin, name, role, created_at, approved_at)
      VALUES (1, ?, ?, 'owner', ?, ?)`).bind(caller.from, owner, now(), now()),
  ]);
  return json({ id: 1, name, about, owner });
}

// --- the invite link, opened by someone and used by their site ---------------------------------------------------------

async function linkedGroup(db, token) {
  return db.prepare(`SELECT g.*, l.token_hash FROM group_links l JOIN groups g ON g.id = l.group_id AND g.origin IS NULL
    WHERE l.token_hash = ? AND l.expires_at > ? AND l.requests < ? AND g.closed_at IS NULL`).bind(await sha256(token), now(), LINK_REQUESTS).first();
}

export async function handleJoinLink(request, env, url) {
  const match = /^\/_join\/([\w-]{40,100})(\/info|\/accept)?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, token, action] = match;
  const db = env.DB;
  const self = await groupSelf(env);
  const group = self && !(await groupGone(env)) ? await linkedGroup(db, token) : null;
  if (!group) {
    const message = "This invite link has expired. Ask whoever sent it for a new one.";
    return action ? json({ error: message }, 404) : html(messagePage(message, { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
  }
  const owner = await ownerOf(db);
  if (request.method === "GET" && !action) return html(groupLinkPage(group.name, owner?.name ?? "Someone"));
  // Which group it is, and where its members list is up to, for the joiner's browser to sign its `join` (members.js).
  if (request.method === "GET" && action === "/info") {
    const list = await db.prepare("SELECT n, head FROM lists WHERE id = ?").bind(self.list).first();
    return json({ id: group.id, name: group.name, about: group.about, rules: group.rules ?? null, owner: owner?.name, person: self.person,
      members: list && Number(list.n) > 0 ? { n: Number(list.n), h: String(list.head) } : null });
  }
  if (request.method !== "POST" || action !== "/accept") return new Response("Not found", { status: 404 });
  // The joiner's own signed `join`, in a call signed by their site. Each request is counted against the link before
  // this site checks (or fetches) anything, and old unanswered requests go.
  const bytes = await bodyBytes(request);
  let signed = {};
  try { signed = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); } catch {}
  if (!signed?.sent) return json({ error: "This group needs your site to be on the same version of afterwrd. Update it, then try again." }, 400);
  const counted = await db.prepare("UPDATE group_links SET requests = requests + 1 WHERE token_hash = ? AND requests < ?")
    .bind(group.token_hash, LINK_REQUESTS).run();
  if (!counted.meta.changes) return json({ error: "This invite link has been used too many times. Ask for a new one." }, 429);
  await db.prepare("DELETE FROM group_members WHERE approved_at IS NULL AND created_at < ?").bind(now() - WAITING_SECONDS).run();
  const caller = await siteCalling(request, env, url, bytes);
  if (!caller) return json({ error: "Your site's signature didn't check." }, 401);
  if (await db.prepare("SELECT 1 FROM group_members WHERE origin = ? AND approved_at IS NOT NULL").bind(caller.from).first()) {
    return json({ error: "You're already in this group." }, 409);
  }
  return takeJoin(env, group, caller, signed, { maxWaiting: MAX_WAITING });
}

// --- members' sites --------------------------------------------------------------------------------------------------

export async function handleGroupApi(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const db = env.DB;
  // hosting: the key this site signs with as host, for its owner's passkey to name in its identity.
  if (route === "GET /_group/ping") return json({ afterwrd: "group", version: pkg.version, protocol: PROTOCOL, hosting: (await hostingKey(env)).publicKey });
  if (route === "POST /_group/claim") return claim(request, env, url);
  // Its identity, once, from the site that claimed it (its owner's: the only member until it has one).
  if (route === "POST /_group/identity") return setGroupIdentity(request, env, url);
  // A group from afterwrd 1, come over: its members from before re-joining, by their sites' addresses (beforegroups.js).
  if (route === "POST /_group/rejoin/point") return rejoinPoint(request, env, url, windowOf(env));
  if (route === "POST /_group/rejoin") return rejoin(request, env, url, windowOf(env));
  // …and its posts and comments from before, re-signed by whoever wrote them, from their own copies (beforehistory.js).
  if (route === "POST /_group/before") return answerGroupBefore(request, env, url);
  const gone = await groupGone(env);
  const member = await signedMember(request, env, url);
  const group = member && !gone ? await theGroup(db) : null;
  // Once it's gone, its owner's site may still ask it to empty itself (it has), before deleting its Worker.
  if (gone && route === "POST /_group/admin/end") return json({ ok: true });
  if (gone) return json({ error: "This group has closed." }, 410);
  if (!member || !group) return json({ error: "Not a member of this group." }, 401);
  const shut = closedGroup(group);
  const record = (body) => takeMemberRecord(env, group, member, body, { maxMembers: maxMembers(env), closed: Boolean(shut),
    tell: (m, proof) => tellRemoved(env, m, proof), onClose: (entry) => closed(env, url.origin, group, entry),
    // "Remove and clear up" (docs/safety-plan.md 3.4): everything they wrote here goes too, removed by the group itself.
    onRemoved: async (target, body) => { if (body?.clear === true) await clearing(env, String(target.identity)); } });
  // Someone still waiting may take back their request: a signed `leave` (members.js only lets them do that).
  if (!member.approved_at && route === "POST /_group/records") return record(await request.json().catch(() => ({})));
  if (!member.approved_at) return json({ error: `Waiting for ${(await ownerOf(db))?.name ?? "the group"} to let you in.` }, 403);
  const site = url.origin;
  if (route === "GET /_group/members") return json(await groupMembers(env, site, group, member));
  // The members list as signed, alone: from the start, or after the point a member's site checked and kept (?after=).
  if (route === "GET /_group/members/list") {
    return json({ "afterwrd:list": await signedMembers(env, { after: Math.max(0, Math.floor(Number(url.searchParams.get("after") ?? 0)) || 0) }) });
  }
  // A member's signed decision about someone, their leaving, or the owner closing the group (groupmembers.js).
  if (route === "POST /_group/records") return record(await request.json().catch(() => ({})));

  // Running the group.
  if (!url.pathname.startsWith("/_group/admin/")) return json({ error: "Not found." }, 404);
  if (!isAdmin(member)) return json({ error: "Only the group's admins can do that." }, 403);
  if (route === "GET /_group/admin/members") {
    // A clear-up with more to go carries on, a go at a time, whenever an admin looks (groupposts.js clearUp).
    const left = await db.prepare("SELECT person FROM group_removed WHERE clearing = 1 LIMIT 1").first();
    if (left) await clearing(env, String(left.person)).catch((error) => console.error("Clearing up:", error));
    return json(await groupMembers(env, site, group, member, { all: true }));
  }
  if (route === "POST /_group/admin/end") {
    if (member.role !== "owner") return json({ error: "Only the group's owner can do that." }, 403);
    if (!shut || shut.goes > now()) return json({ error: "Close the group first: it goes 30 days after." }, 409);
    await empty(env);
    return json({ ok: true });
  }
  // What members have raised (reports.js): read, and left, by any admin; each named by the group's members list.
  if (route === "GET /_group/admin/reports") {
    const names = async (people) => new Map((await db.prepare(`SELECT identity, name FROM group_members WHERE identity IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(people)).all()).results.map((r) => [String(r.identity), String(r.name)]));
    // Never what's been raised about the asker's own posts and comments.
    return json({ reports: await raised(db, names, { exclude: String(member.identity) }) });
  }
  if (route === "POST /_group/admin/reports/leave") {
    const body = await request.json().catch(() => ({}));
    await leaveIt(db, String(body?.about ?? ""), String(member.identity), body?.word);
    return json({ ok: true });
  }
  if (shut) return json({ error: "This group has closed." }, 409);
  if (route === "POST /_group/admin/link") {
    const token = randomToken();
    await db.batch([
      db.prepare("DELETE FROM group_links"),
      db.prepare("INSERT INTO group_links (token_hash, group_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(token), group.id, now() + LINK_SECONDS, now()),
    ]);
    return json({ link: `${site}/_join/${token}` });
  }
  // Whether any member may use @here (mentions.js), or only the owner and admins.
  if (route === "POST /_group/admin/here") {
    const body = await request.json().catch(() => ({}));
    await db.prepare("UPDATE groups SET here_anyone = ? WHERE id = ?").bind(body?.on === true ? 1 : 0, group.id).run();
    return json({ ok: true });
  }
  if (route === "POST /_group/admin/about") {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_GROUP_NAME) : "";
    if (!name) return json({ error: "Give the group a name." }, 400);
    // Its rules too (docs/safety-plan.md 3.4), when the form sends them.
    await db.prepare(`UPDATE groups SET name = ?, about = ?${body.rules !== undefined ? ", rules = ?" : ""} WHERE id = ?`)
      .bind(name, cleanText(body.about).slice(0, MAX_GROUP_ABOUT) || null, ...(body.rules !== undefined ? [cleanText(body.rules).slice(0, MAX_GROUP_RULES) || null] : []), group.id).run();
    return json({ ok: true });
  }
  // Someone removed may ask to join again (docs/safety-plan.md 3.4).
  if (route === "POST /_group/admin/unremove") {
    const body = await request.json().catch(() => ({}));
    await db.prepare("DELETE FROM group_removed WHERE person = ?").bind(String(body?.person ?? "")).run();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
