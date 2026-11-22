// Groups, from a person's site. Each group is its own Worker (groups.js); this site reads it from there in calls signed
// by this site (calls.js), keeps copies of its newest posts (groupcopies.js), and passes on what the owner here signs
// there: their posts and comments, and, if they run the group, their decisions (groupjoin.js). Everything a group sends
// is checked here and turned into plain shapes for the pages, as with friends' sites.
//
// Joining: the owner opens an invite link (/_join/<token> on the group's site), which brings them to
// /groups/join?link=… here to confirm; their browser signs a `join`, and this site sends it to the group's
// /_join/<token>/accept (groupjoin.js). Starting a group (groupsites.js) ends with /_group/claim instead, then the
// owner's passkey signs the group's identity (groupidentity.js).
//
// What a group's site may ask of this one (signed by the group: groupjoin.js signedGroup):
//   POST /_member/removed     the group removed this site, or turned down its request
//   POST /_p/notes            a note about its posts, or its closing (groupcopies.js receiveGroupNote, via notes.js)
// The owner's own actions, from their pages (views/groups.js):
//   POST /_groups/join(/point)            {link, sent}: asking to join (groupjoin.js)
//   POST /_groups/create/…                starting a group (groupsites.js)
//   POST /_groups/<id>/items              a new post or event (groupcopies.js)
//   POST /_groups/<id>/items/<item>/records   a record on one (groupcopies.js)
//   POST /_groups/<id>/point, …/records   the members list: approving, removing, roles, leaving and (its owner)
//                                         closing it (groupjoin.js)
//   Running a group (its admins): POST /_groups/<id>/link (JSON), /_groups/<id>/about (name, about), /_groups/<id>/here;
//   its owner: /_groups/<id>/delete once it's closed and gone (groupsites.js), and /_groups/<id>/identity/(start|finish)
//   POST /_groups/<id>/forget             a group from before signing, or one that's closed and gone: off the list here
// Groups made on afterwrd 1 (no identity) are no longer asked anything: the owner here sees their own posts and comments
// there (group_mine), read-only, until migration (docs/signed-conversations.md, step 10).
import { groupId } from "../public/static/activity.js";
import { safeNext } from "./auth.js";
import { cleanName, closedGroup, MAX_GROUP_ABOUT, MAX_GROUP_NAME } from "./groups.js";
import { handleGroupSites } from "./groupsites.js";
import { handleGroupIdentity } from "./groupidentity.js";
import { callFriend } from "./calls.js";
import { joinPoint, joinSigned, membersPoint, relayGroupRecord, signedGroup, waitingPoint } from "./groupjoin.js";
import { postSigned, relayToGroup } from "./groupcopies.js";
import { ownOrigin } from "./keys.js";
import { messagePage } from "./views/pages.js";
import { callSite, ownerName, siteOrigin } from "./sites.js";
import { html, json, now, Refusal } from "./util.js";

// People kept from a group's list of them (its members, or those to mention): what it sends is only trusted so far.
// Well above any group's cap (groups.js maxMembers): cut short, admins couldn't see or let in anyone past the end.
const MAX_LISTED = 5000;
const LINK_RE = /^\/_join\/([\w-]{40,100})$/;
const ROLES = ["owner", "admin", "member"];
const unexpected = () => new Error("Their site sent something unexpected.");
export const isAdmin = (group) => group.role === "owner" || group.role === "admin";

// --- reading what a group's site sends -----------------------------------------------------------------------------------

const text = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);
const seconds = (iso) => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

/** Someone, as a group names them: a name, and the site they're from (if it's a proper site address). */
function person(p, env) {
  const name = text(p?.name, 100)?.trim() || null;
  const from = typeof p?.id === "string" ? siteOrigin(p.id.replace(/\/$/, ""), env) : null;
  return { name, from };
}

/** The group itself, from the context of what its site sends; it must be the group asked for. */
export function parseGroup(g, site, n, env) {
  if (g?.type !== "Group" || g.id !== groupId(site, n)) throw unexpected();
  const waiting = g["afterwrd:waiting"];
  const owner = person(g.attributedTo, env);
  return {
    name: text(g.name, 300)?.trim() || "A group", about: text(g.about ?? g.summary, 2000),
    owner: owner.name, ownerFrom: owner.from, members: count(g["afterwrd:members"]) ?? 1,
    role: ROLES.includes(g["afterwrd:role"]) ? g["afterwrd:role"] : "member",
    waiting: Number.isSafeInteger(waiting) && waiting >= 0 ? waiting : 0,
    // Mentions (mentions.js): its members, to pick from, and whether the owner here may use @here, and anyone may.
    people: (Array.isArray(g["afterwrd:people"]) ? g["afterwrd:people"].slice(0, MAX_LISTED) : [])
      .map((p) => ({ ...person(p, env), person: /^[A-Za-z0-9_-]{43}$/.test(p?.["afterwrd:person"] ?? "") ? p["afterwrd:person"] : null }))
      .filter((p) => p.name && p.from).map((p) => ({ name: p.name, origin: p.from, ...(p.person && { person: p.person }) })),
    mayHere: g["afterwrd:mayHere"] === true,
    hereAnyone: g["afterwrd:hereAnyone"] === true,
    // Closed by its owner (step 6e): when. The group's word, until its signed `close` arrives (groupcopies.js).
    closedAt: seconds(g["afterwrd:closedAt"]),
    closedBy: /^[A-Za-z0-9_-]{43}$/.test(g["afterwrd:close"] ?? "") ? g["afterwrd:close"] : null,
  };
}

/** Who's in a group; for an admin, with requests to join and the numbers to act on everyone by. */
export function parseGroupMembers(data, site, n, env) {
  const items = Array.isArray(data?.items) ? data.items.slice(0, MAX_LISTED) : [];
  return {
    group: parseGroup(data?.context, site, n, env),
    members: items.map((m) => ({
      ...person(m, env), role: ROLES.includes(m?.["afterwrd:role"]) ? m["afterwrd:role"] : "member",
      id: Number.isSafeInteger(m?.["afterwrd:member"]) ? m["afterwrd:member"] : null, waiting: m?.["afterwrd:waiting"] === true,
      // Who they are, and their join: what a signed decision about them names.
      person: /^[A-Za-z0-9_-]{43}$/.test(m?.["afterwrd:person"] ?? "") ? m["afterwrd:person"] : null,
      join: /^[A-Za-z0-9_-]{43}$/.test(m?.["afterwrd:join"] ?? "") ? m["afterwrd:join"] : null,
      // Waiting, and in the group before afterwrd 2 (step 10d: beforegroups.js): the owner's browser lets them in.
      before: m?.["afterwrd:before"] === true,
    })).filter((m) => m.name),
  };
}

// --- loading a group for its pages -----------------------------------------------------------------------------------------

/** A call to a group's site, signed by this site (calls.js). Only groups with an identity are called. */
// A group's whole members list (groupmembers.js signedMembers): every join and approval, with each member's identity
// and delegation, about 4.6 MB at 1,000 members (the scale run found 509 members past the usual 2 MB). Fetched
// whole the first time a member's site checks it; after that, only what's new (groupjoin.js checkedMembers).
const MEMBERS_REPLY = 8_000_000;
const call = async (env, group, path, body) => {
  if (!group.identity) throw new Refusal("This group is from before signing: it can't be asked anything now.");
  return callFriend(env, await ownOrigin(env.DB), String(group.origin), path, { ...(body !== undefined && { body }), timeout: 25_000,
    ...(/^\/_group\/(admin\/)?members(\/list)?(\?|$)/.test(path) && { maxReply: MEMBERS_REPLY }) });
};

/** Keeps a group's name, owner, our role and whether it's closed up to date, from what it just said. */
export async function refresh(db, group, info) {
  const closedAt = group.closed_at ?? info.closedAt ?? null;
  if (info.name === group.name && info.about === group.about && info.role === group.role && (info.owner ?? group.host_name) === group.host_name
    && closedAt === (group.closed_at ?? null)) return;
  Object.assign(group, { name: info.name, about: info.about, role: info.role, host_name: info.owner ?? group.host_name, closed_at: closedAt });
  await db.prepare("UPDATE groups SET name = ?, about = ?, role = ?, host_name = ?, closed_at = ? WHERE id = ?")
    .bind(group.name, group.about, group.role, group.host_name, closedAt, group.id).run();
}

/** Who's in a group, as it says; for an admin, everyone, with requests to join. */
export async function loadMembers(env, group) {
  const data = parseGroupMembers(await call(env, group, isAdmin(group) ? "/_group/admin/members" : "/_group/members"),
    group.origin, group.remote_id, env);
  await refresh(env.DB, group, data.group);
  return data;
}

/**
 * A group from before signing (no identity): what the owner here posted and said there, as they sent it (group_mine),
 * newest first, each comment under the post it was on. Read-only, and theirs alone, until migration.
 */
export async function oldGroupWords(db, group) {
  const { results } = await db.prepare(`SELECT id, kind, post_id, remote_id, text, photos, event, poll, created_at FROM group_mine
    WHERE site = ? AND remote_group = ? ORDER BY created_at DESC LIMIT 500`).bind(group.origin, group.remote_id).all();
  const json_ = (v) => { try { return JSON.parse(String(v ?? "null")); } catch { return null; } };
  return results.map((r) => ({ id: Number(r.id), kind: String(r.kind), on: r.post_id === null ? null : Number(r.post_id), text: r.text ? String(r.text) : "",
    photos: (json_(r.photos) ?? []).length, event: json_(r.event), poll: json_(r.poll), created_at: Number(r.created_at) }));
}

// --- joining ---------------------------------------------------------------------------------------------------------

function parseLink(link, url, env) {
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    throw new Error("That isn't a group invite link. It should look like https://…/_join/…");
  }
  const origin = siteOrigin(parsed.origin, env);
  const match = LINK_RE.exec(parsed.pathname);
  if (!origin || !match) throw new Error("That isn't a group invite link. It should look like https://…/_join/…");
  if (origin === url.origin) throw new Error("That link is to this site, not a group.");
  return { origin, token: match[1] };
}

/** What the group an invite link is for says about itself, to show before joining, and to sign a join by. */
export async function linkInfo(env, url, link) {
  const target = parseLink(link, url, env);
  const info = await callSite(target.origin, `/_join/${target.token}/info`);
  const id = Number(info.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw unexpected();
  const joined = await env.DB.prepare("SELECT id FROM groups WHERE origin = ? AND remote_id = ? AND joined_at IS NOT NULL")
    .bind(target.origin, id).first();
  const person = typeof info.person === "string" && /^[A-Za-z0-9_-]{43}$/.test(info.person) ? info.person : null;
  if (!person) throw new Refusal("That group's site needs updating before anyone can join it. Its owner can update it from their Update page.");
  const members = info.members && Number.isSafeInteger(info.members.n) && /^[A-Za-z0-9_-]{43}$/.test(info.members.h ?? "")
    ? { n: info.members.n, h: info.members.h } : null;
  return { ...target, id, name: cleanName(info.name, "A group"), about: text(info.about, 2000), owner: cleanName(info.owner), joined: joined?.id ?? null,
    person, members };
}

/**
 * Claims a group whose Worker this site has just made (groupsites.js): its row here holds the setup code the Worker
 * was made with, sent in a call signed by this site. Returns the group's id here.
 */
export async function claimGroup(env, url, id) {
  const db = env.DB;
  const group = await db.prepare("SELECT * FROM groups WHERE id = ? AND joined_at IS NULL AND origin IS NOT NULL AND setup IS NOT NULL")
    .bind(Number(id)).first();
  if (!group) throw new Error("That group isn't waiting to be set up.");
  const reply = await callFriend(env, url.origin, String(group.origin), "/_group/claim", {
    body: { setup: group.setup, name: group.name, about: group.about, owner: await ownerName(db) }, timeout: 25_000,
  });
  if (Number(reply.id) !== Number(group.remote_id)) throw unexpected();
  const row = await db.prepare(`UPDATE groups SET name = ?, about = ?, host_name = ?, setup = NULL, role = 'owner', joined_at = ?
    WHERE id = ? AND joined_at IS NULL RETURNING id`)
    .bind(cleanName(reply.name, "A group"), text(reply.about, 2000), cleanName(reply.owner), now(), group.id).first();
  if (!row) throw unexpected();
  return Number(row.id);
}

// --- the owner's part in a group (actions: see util.js Refusal) -----------------------------------------------------------

/**
 * One of the owner's groups by its id here (or, `unfinished`, one whose Worker this site made but didn't set up).
 * @returns {Promise<Row<"groups"> | null>}
 */
export async function findGroup(db, id, { unfinished = false } = {}) {
  const also = unfinished ? "OR (joined_at IS NULL AND script != '')" : "";
  return db.prepare(`SELECT * FROM groups WHERE id = ? AND (joined_at IS NOT NULL ${also})`).bind(Number(id)).first();
}

/** Whether a group's closed and its 30 days are up: it's gone (its site empties itself: groups.js). */
export const groupGoneHere = (group) => { const shut = closedGroup(group); return Boolean(shut && shut.goes <= now()); };

/** Forgets a group here (its signed posts kept here, and notices). The owner's own copies of what they said stay. */
export const forgetGroup = (db, group) => db.batch([
  db.prepare("DELETE FROM copies WHERE group_id = ?").bind(group.id),
  db.prepare("DELETE FROM notices WHERE group_id = ?").bind(group.id),
  db.prepare("DELETE FROM groups WHERE id = ?").bind(group.id),
]);

/** An admin's request to the group (its invite link, its name and about, @here); returns its answer. */
export async function admin(env, group, path, body = {}) {
  let reply;
  try {
    reply = await call(env, group, `/_group/admin/${path}`, body);
  } catch (error) {
    throw new Refusal(error.message);
  }
  // A group saying no in its answer, rather than with its status, is a no too.
  if (reply?.error) throw new Refusal(reply.error);
  return reply;
}

export async function handleGroupActions(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const db = env.DB;
  const site = url.origin;
  const path = url.pathname.slice("/_groups".length);
  if (path.startsWith("/create/")) return handleGroupSites(request, env, url);
  if (path === "/join" || path === "/join/point") {
    const body = await request.json().catch(() => ({}));
    try {
      const info = await linkInfo(env, url, String(body.link ?? ""));
      // The owner's browser signs their `join` (ui/groupsign.js).
      if (path === "/join/point") return json(await joinPoint(env, info));
      if (info.joined) return json({ id: info.joined });
      if (!body.sent) return json({ error: "Joining this group needs your browser to sign: reload the page, and try again." }, 400);
      return json({ id: await joinSigned(env, info, body.sent) });
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }

  const match = /^\/(\d{1,15})(\/.*)$/.exec(path);
  // A group whose Worker this site made but couldn't finish setting up can still be deleted.
  const group = match && await findGroup(db, match[1], { unfinished: match[2] === "/delete" });
  if (!group) return problem("That group isn't here any more.", new URL("/groups", site), 404);
  const action = match[2];
  if (action === "/delete") return handleGroupSites(request, env, url, group);
  if (action === "/identity/start" || action === "/identity/finish") return handleGroupIdentity(request, env, url, group, action);
  // A group from before signing, or one closed and gone (its owner deletes theirs instead): off the list here.
  if (action === "/forget") {
    if (group.identity && !groupGoneHere(group)) return problem("Leave the group instead.", new URL(`/groups/${group.id}/members`, site));
    if (group.role === "owner" && group.script) return problem("Delete the group's site instead, from Members & settings.", new URL(`/groups/${group.id}/members`, site));
    await forgetGroup(db, group);
    return Response.redirect(`${site}/groups`, 303);
  }
  if (!group.identity) return problem("This group is from before signing: it can't be changed now.", new URL(`/groups/${group.id}`, site));
  // The group's signed members list (groupjoin.js): decisions, leaving, and its owner closing it.
  if (action === "/point" || action === "/records") {
    try {
      if (action === "/point") {
        try {
          return json(await membersPoint(env, group, (path) => call(env, group, path)));
        } catch (error) {
          // Still waiting to be let in: from their own request's receipt.
          if (/** @type {any} */ (error).status === 403) return json(await waitingPoint(env, group));
          throw error;
        }
      }
      const body = await request.json().catch(() => ({}));
      const { record, fp } = await relayGroupRecord(env, group, body.sent, (p, b) => call(env, group, p, b));
      if (record.kind === "leave") {
        await forgetGroup(db, group);
        return json({ ok: true, go: "/groups" });
      }
      if (record.kind === "close") {
        await db.prepare("UPDATE groups SET closed_at = COALESCE(closed_at, ?), closed_by = COALESCE(closed_by, ?) WHERE id = ?").bind(now(), fp, group.id).run();
        return json({ ok: true, go: `/groups/${group.id}/members` });
      }
      return json({ ok: true });
    } catch (error) {
      return json({ error: error.message }, error instanceof Refusal ? error.status ?? 400 : 400);
    }
  }
  // A signed group's posts (groupcopies.js): a new post or event, and records on its posts, signed here.
  if (action === "/items") {
    try {
      const made = await postSigned(env, url, group, await request.json().catch(() => ({})));
      return json({ ok: true, id: made.id, go: `/groups/${group.id}/posts/${made.id}` });
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status ?? 400);
      throw error;
    }
  }
  const onItem = /^\/items\/([A-Za-z0-9_-]{43})\/records$/.exec(action);
  if (onItem) return relayToGroup(request, env, url, group, onItem[1]);
  try {
    if (action === "/link") return json({ link: (await admin(env, group, "link")).link });
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.message }, error.status);
    throw error;
  }

  // Everything else is a form, landing back on Members & settings.
  const form = await request.formData().catch(() => new FormData());
  const back = new URL(safeNext(String(form.get("back") ?? `/groups/${group.id}/members`), url), site);
  try {
    if (action === "/here") {
      // Whether anyone in it may use @here, or only its owner and admins (mentions.js).
      await admin(env, group, "here", { on: form.get("anyone") === "1" });
    } else if (action === "/about") {
      await admin(env, group, "about", {
        name: String(form.get("name") ?? "").slice(0, MAX_GROUP_NAME), about: String(form.get("about") ?? "").slice(0, MAX_GROUP_ABOUT),
      });
    } else {
      return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    if (error instanceof Refusal) return problem(error.message, back, error.status);
    throw error;
  }
  return Response.redirect(back.href, 303);
}

const problem = (message, back, status = 400) =>
  html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), status);

// --- calls from groups' sites ------------------------------------------------------------------------------------------

export async function handleMember(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const group = await signedGroup(request, env, url);
  if (!group?.joined_at) return json({ error: "Not a member." }, 401);
  if (route === "POST /_member/removed") {
    // A group this site made is only forgotten when its owner deletes it here, so its Worker is never lost track of.
    if (!group.script) await forgetGroup(env.DB, group);
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
