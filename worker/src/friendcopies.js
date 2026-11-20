// Friends' signed posts, as this site sees them (afterwrd 2, step 4b: docs/signed-conversations.md):
// - copies: their posts kept here for Home, asked for with `since` (friendhost.js), each post's first record checked
//   against their identity as it arrives (pullItems);
// - a post opened: its whole list read from their site and checked (checkList), with markers for what was deleted,
//   removed, or left out, and a notice if their site has changed what this site checked before (friendThread);
// - commenting on it: signed in the browser, passed on by this site in a signed call, and kept in `sent` with the host's
//   receipt (relayRecord):
//     POST /_admin/friend/<connection>/items/<id>/records   form: sent (JSON), back
import { callFriend, friendPerson } from "./calls.js";
import { identityState, learnIdentity, parseChain, checkProfile } from "./identities.js";
import { checkRecord } from "./records.js";
import { checkHead, checkList } from "./lists.js";
import { parseRecord } from "../public/static/records.js";
import { fingerprintOf, fromB64url } from "../public/static/signed.js";
import { ownHost } from "./items.js";
import { safeNext } from "./auth.js";
import { messagePage } from "./views/pages.js";
import { html, now } from "./util.js";

export const PULL_SECONDS = 3600; // how often a friend's site is asked (docs/signed-conversations.md decision 12)
const PAGES = 3;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Lookups for checking records from a friend's site: identities as known here; browser keys as `delegations` says. */
const lookupsWith = (env, delegations) => ({
  identityOf: (person) => identityState(env, person),
  delegationOf: async (key) => delegations?.[key] ?? null,
});

/**
 * Asks a friend's site for the posts that changed since this site last asked, and keeps them, each post's first record
 * checked against their identity (it must be theirs, on their site). Returns how many came, or null if their site
 * couldn't be asked (not set up for signed posts yet, or away).
 */
export async function pullItems(env, from, connection) {
  const person = await friendPerson(env, connection);
  if (!person) return null;
  let since = Number(connection.items_since ?? 0);
  let count = 0;
  for (let page = 0; page < PAGES; page++) {
    let data;
    try { data = await callFriend(env, from, String(connection.origin), `/_p/items?since=${since}`); } catch { return count || null; }
    const lookups = lookupsWith(env, data.delegations);
    const statements = [];
    for (const item of Array.isArray(data.items) ? data.items : []) {
      if (!ID_RE.test(item?.id ?? "")) continue;
      const got = await checkRecord(item.sent, { ...lookups, at: Number(item.taken) });
      if (!got || got.fp !== item.id || got.record.kind !== "item" || got.record.author !== person || got.record.host !== person) continue;
      const content = { text: typeof item.content?.text === "string" ? item.content.text.slice(0, 5000) : "",
        photos: (Array.isArray(item.content?.photos) ? item.content.photos : []).slice(0, 20).filter((p) => /^https?:\/\//.test(p?.src ?? "")) };
      statements.push(env.DB.prepare(`INSERT INTO copies (id, connection_id, author, record, content, earlier, edited_at, comments, created_at, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, earlier = excluded.earlier,
        edited_at = excluded.edited_at, comments = excluded.comments, changed_at = excluded.changed_at`)
        .bind(item.id, connection.id, person, JSON.stringify(item.sent), JSON.stringify(content), JSON.stringify(Array.isArray(item.earlier) ? item.earlier.slice(0, 20) : []),
          Number.isSafeInteger(item.edited_at) ? item.edited_at : null, item.comments > 0 ? 1 : 0, Number(item.taken), Number(item.changed_at) || now()));
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
  return count;
}

/** Asks every friend's site not asked in the last hour (in the background, from Home). */
export async function pullFriends(env, from) {
  const { results } = await env.DB.prepare(`SELECT * FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND COALESCE(items_checked_at, 0) < ? ORDER BY COALESCE(items_checked_at, 0) LIMIT 40`).bind(now() - PULL_SECONDS).all();
  await Promise.all(results.map((c) => pullItems(env, from, c).catch(() => null)));
}

/**
 * Asks, while Home waits, the sites of friends whose posts this site has never had (as Home always has with no copy it
 * can show), for at most `ms`: everyone else is asked after the page has gone (pullFriends).
 */
export async function pullNew(env, from, ms = 4000) {
  const { results } = await env.DB.prepare(`SELECT * FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND items_checked_at IS NULL LIMIT 10`).all();
  if (!results.length) return;
  await Promise.race([Promise.all(results.map((c) => pullItems(env, from, c).catch(() => null))), new Promise((r) => setTimeout(r, ms))]);
}

/** Friends' posts kept here, newest first, with who they're from. */
export async function friendItems(db, { limit = 100, connection = null } = {}) {
  const { results } = await db.prepare(`SELECT c.*, k.name, k.origin, k.avatar_url FROM copies c JOIN connections k ON k.id = c.connection_id
    WHERE k.approved_at IS NOT NULL ${connection ? "AND c.connection_id = ?" : ""} ORDER BY c.created_at DESC LIMIT ?`)
    .bind(...(connection ? [connection, limit] : [limit])).all();
  return results.map(copyFromRow);
}

export async function friendItem(db, connection, id) {
  const row = await db.prepare(`SELECT c.*, k.name, k.origin, k.avatar_url FROM copies c JOIN connections k ON k.id = c.connection_id
    WHERE c.id = ? AND c.connection_id = ?`).bind(id, connection).first();
  return row ? copyFromRow(row) : null;
}

function copyFromRow(r) {
  const content = JSON.parse(String(r.content));
  return { id: String(r.id), connection: { id: Number(r.connection_id), name: String(r.name), origin: String(r.origin),
    avatar: r.avatar_url ? { thumbSrc: String(r.avatar_url) } : null },
    author: String(r.author), text: content.text ?? "", photos: content.photos ?? [], earlier: r.earlier ? JSON.parse(String(r.earlier)) : [],
    edited_at: r.edited_at ? Number(r.edited_at) : null, comments: Number(r.comments), created_at: Number(r.created_at),
    checked: r.checked_n ? { n: Number(r.checked_n), head: String(r.checked_head) } : null };
}

/**
 * A friend's post opened: its list read from their site and checked. Returns {entries (as lists.js checkList shows
 * them, with each comment's writer's name), problem, changed, seen, mine}, or {error}.
 */
export async function friendThread(env, from, connection, id) {
  const person = await friendPerson(env, connection);
  if (!person) return { error: "Their site doesn't take signed comments yet." };
  let data;
  try { data = await callFriend(env, from, String(connection.origin), `/_p/items/${id}`); } catch (error) { return { error: error.message }; }
  // Everyone in it: their identities as their site passed them on (each checked as it's learnt), and their names.
  const names = new Map();
  const me = await ownHost(env);
  for (const [p, info] of Object.entries(data.people ?? {})) {
    if (!ID_RE.test(p)) continue;
    const chain = parseChain(info?.chain);
    const state = chain && (await learnIdentity(env, chain));
    if (!state || state.id !== p) continue;
    const profile = info.profile && (await checkProfile(info.profile, state));
    if (profile) names.set(p, profile.name);
  }
  names.set(person, String(connection.name));
  const hostState = await identityState(env, person);
  if (!hostState) return { error: "Their site's identity couldn't be checked." };
  const copy = await env.DB.prepare("SELECT author, checked_n, checked_head FROM copies WHERE id = ?").bind(id).first();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const from0 = data.checkpoint && (await checkHead(data.checkpoint, { hostingKey: hostState.current.hosting, host: person, list: id }));
  const result = await checkList({ host: person, hostingKey: hostState.current.hosting, list: id, owner: copy ? String(copy.author) : String(data.owner ?? person),
    entries, signedHead: data.signedHead, from: from0 ? { n: from0.n, head: from0.head } : null, lookups: lookupsWith(env, data.delegations) });
  // What this site checked before must still be there.
  const before = copy?.checked_n ? entries.find((e) => e.n === Number(copy.checked_n)) : null;
  const changed = Boolean(copy?.checked_n && (!before || before.head !== copy.checked_head));
  const last = entries.at(-1);
  if (!result.problem && !changed && last) {
    await env.DB.prepare("UPDATE copies SET checked_n = ?, checked_head = ? WHERE id = ?").bind(last.n, last.head, id).run();
  }
  const mine = [...result.entries].reverse().find((e) => e.record?.author === me?.person)?.fp ?? null;
  return { entries: result.entries.map((e) => ({ ...e, name: e.by ? names.get(e.by) ?? "Someone" : null })), problem: result.problem, changed,
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
  let answer;
  try {
    answer = await callFriend(env, url.origin, String(connection.origin), "/_p/records",
      { body: { sent, delegation: { bytes: String(delegation.bytes), proof: JSON.parse(String(delegation.proof)) } } });
  } catch (error) { return refused(`Couldn't send it: ${error.message}`); }
  await env.DB.prepare(`INSERT OR REPLACE INTO sent (fp, host, item, kind, record, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await fingerprintOf("record", fromB64url(sent.record)), record.host, id, record.kind,
      JSON.stringify(sent), answer.receipt ? JSON.stringify(answer.receipt) : null, now()).run();
  // Its copy here no longer knows whether it has comments: ask again soon.
  await env.DB.prepare("UPDATE connections SET items_checked_at = 0 WHERE id = ?").bind(connection.id).run();
  back.hash = `fi${connection.id}-${id}`;
  return Response.redirect(back.href, 303);
}

