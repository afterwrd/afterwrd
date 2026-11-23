// Signed calls between sites (afterwrd 2: docs/signed-conversations.md). Every call one site makes to another about its
// owner (making friends, posts, checks, the shared Facebook archive) is signed with the calling site's hosting key
// (signedcalls.js), and the receiver works out who's calling from the caller's identity, fetched from the caller's own
// address (/.well-known/afterwrd): no passwords are handed over or kept. Each friend is tied to their identity when the
// friendship is made (connect.js), or the first time it's needed (friendPerson).
import { checkCall, signCall } from "./signedcalls.js";
import { fetchIdentity, hostingKeyFor, identityState } from "./identities.js";
import { ownMove } from "./keys.js";
import { ownHost } from "./items.js";
import { host, ownerName, readLimited } from "./sites.js";
import { admit } from "./allowances.js";

const TIMEOUT_MS = 8000;
const MAX_REPLY = 2_000_000;

/**
 * The identity a friend's site signs for, tied to them here the first time it's needed: their site's own
 * /.well-known/afterwrd, checked to name their address. null if it can't be had (their site is older, or away).
 */
export async function friendPerson(env, connection) {
  if (connection.identity) return String(connection.identity);
  const identity = await fetchIdentity(env, String(connection.origin)).catch(() => null);
  if (!identity) return null;
  await env.DB.prepare("UPDATE connections SET identity = ? WHERE id = ? AND identity IS NULL").bind(identity.id, connection.id).run();
  return identity.id;
}

/**
 * Calls another site, signed by this one (`from`: this site's address). Returns what it answered (JSON), or throws
 * an Error fit to show the owner, with `status`: what their site answered (0: couldn't reach it).
 * @param {Env} env
 * @param {string} from
 * @param {string} origin
 * @param {string} path
 * @param {{ body?: object | null, timeout?: number, maxReply?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function callFriend(env, from, origin, path, { body = null, timeout = TIMEOUT_MS, maxReply = MAX_REPLY } = {}) {
  const me = await ownHost(env);
  if (!me) throw Object.assign(new Error("Set up signing first, in Your devices."), { status: 0 });
  const text = body === null ? null : JSON.stringify(body);
  const method = body === null ? "GET" : "POST";
  const headers = await signCall({ method, url: origin + path, body: text, person: me.person, from, privateKey: me.privateKey });
  let response;
  try {
    response = await fetch(origin + path, { method, redirect: "manual", signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(text !== null && { "Content-Type": "application/json" }) }, body: text });
  } catch {
    throw Object.assign(new Error(`Couldn't reach ${host(origin)}.`), { status: 0 });
  }
  let data = {};
  try { data = JSON.parse(await readLimited(response, maxReply)); } catch (error) {
    // More than a site ever sends isn't an answer: as if it hadn't answered at all.
    if (/** @type {any} */ (error)?.tooBig) throw Object.assign(new Error(`${host(origin)} sent too much.`), { status: 0 });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  if (!response.ok) {
    // retry: a site saying this one has had its allowance there today, and when to try again (allowances.js).
    throw Object.assign(new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `${host(origin)} answered ${response.status}.`),
      { status: response.status, ...(response.status === 429 && Number.isSafeInteger(data.retry) && { retry: data.retry }) });
  }
  return data;
}

/**
 * Who's calling, if it's a friend's site making a signed call: {connection, person}; otherwise a Response refusing.
 * The calling site's address is checked to be a friend's first, so a stranger can't make this site fetch anything,
 * and a stranger, an unsigned call and a call signed by anyone but that friend all get the same answer (401), so
 * nobody can find out from here who the owner is friends with or has been asked by. A friend the owner hasn't
 * approved yet gets 403, unless `waiting` (they may still withdraw). `body` is the call's body as received (bytes).
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Uint8Array | null} [body]
 * @param {{ waiting?: boolean }} [options]
 * @returns {Promise<{ connection: Row<"connections">, person: string } | Response>}
 */
export async function friendCalling(request, env, url, body = null, { waiting = false } = {}) {
  const notConnected = () => Response.json({ error: "Not connected." }, { status: 401 });
  // The owner has moved: this site only says where (410), and friends' sites switch to there (switchConnection).
  const gone = await ownMove(env.DB, url.origin);
  if (gone?.done) return Response.json({ error: "Moved.", moved: gone.to }, { status: 410 });
  const from = request.headers.get("Afterwrd-From") ?? "";
  let connection = from && (await env.DB.prepare("SELECT * FROM connections WHERE origin = ? AND connected_at IS NOT NULL")
    .bind(from).first());
  // A friend calling from the address their identity says they're moving to (identities.js keeps it): once that's in
  // effect here (7 days after this site heard), they're called there, and this call counts; before, "not yet" (409),
  // which their site takes as "ask again later", not as having been removed.
  if (!connection && from) {
    const moving = await env.DB.prepare(`SELECT c.* FROM connections c JOIN identities i ON i.person = c.identity
      WHERE i.moving_to = ? AND c.connected_at IS NOT NULL`).bind(from).first();
    if (moving) {
      const state = await identityState(env, String(moving.identity));
      if (!state || state.frozen || state.problem || state.current.origin !== from) {
        return Response.json({ error: "Not moved here yet.", moving: true }, { status: 409 });
      }
      connection = moving;
    }
  }
  // A site someone is moving to, before their posts and friends have come (movein.js): not yet, rather than "no".
  if (!connection && (await env.DB.prepare("SELECT 1 FROM move_in WHERE id = 1").first())) {
    return Response.json({ error: "Not moved here yet.", moving: true }, { status: 409 });
  }
  if (!connection) return notConnected();
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site, options) => (connection.identity && connection.identity !== person ? null : hostingKeyFor(env, person, site, options)) });
  if (!caller) return notConnected();
  if (connection.origin !== from) await switchConnection(env, /** @type {Row<"connections">} */ (/** @type {unknown} */ (connection)), from);
  if (!connection.identity) {
    await env.DB.prepare("UPDATE connections SET identity = ? WHERE id = ? AND identity IS NULL").bind(caller.person, connection.id).run();
    connection.identity = caller.person;
  }
  if (!connection.approved_at && !waiting) {
    return Response.json({ error: `Waiting for ${await ownerName(env.DB)} to approve the connection.` }, { status: 403 });
  }
  await admit(env, caller.person); // within their allowance here today, or refused (allowances.js)
  return { connection: /** @type {Row<"connections">} */ (/** @type {unknown} */ (connection)), person: caller.person };
}

/**
 * A friend whose identity has moved to `to` (in effect here: the caller checks), called there from now on. What this
 * site kept from their old site (copies of their posts, with links to its files) goes, and is asked for again at the
 * new address. Not if another friend is already at that address (their new site asked to be friends separately): then
 * both stay, for the owner to sort out. Returns whether it switched.
 * @param {Env} env @param {Row<"connections">} connection @param {string} to
 */
export async function switchConnection(env, connection, to) {
  const taken = await env.DB.prepare("SELECT 1 FROM connections WHERE origin = ? AND id != ?").bind(to, connection.id).first();
  if (taken) return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE connections SET origin = ?, items_since = NULL, items_checked_at = NULL, avatar_url = NULL, avatar_exp = NULL,
      missing_since = NULL, said_no = 0 WHERE id = ?`).bind(to, connection.id),
    env.DB.prepare("DELETE FROM copies WHERE connection_id = ?").bind(connection.id),
    env.DB.prepare("UPDATE identities SET origin = ? WHERE person = ?").bind(to, connection.identity),
  ]);
  Object.assign(connection, { origin: to, items_since: null, items_checked_at: null, avatar_url: null, avatar_exp: null, missing_since: null, said_no: 0 });
  return true;
}

/**
 * Who's calling, from a site that isn't a friend yet (asking to be friends: connect.js): {person, from}, the identity
 * whose hosting key signed the call, and whose identity names the calling address; null if it isn't signed so. This
 * fetches the caller's identity from their address, so call it only once the call has earned that (a friend link
 * that works, or a reason to ask).
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Uint8Array | null} body
 */
export async function siteCalling(request, env, url, body) {
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site, options) => hostingKeyFor(env, person, site, options) });
  if (caller) await admit(env, caller.person); // within their allowance here today, or refused (allowances.js)
  return caller;
}

/** When a site that refused a call (callFriend's error) says to try again, if it said this site had had its allowance. */
export const busyUntil = (error) => (error?.status === 429 && Number.isSafeInteger(error.retry) ? error.retry : null);

/** A call's body as bytes, read once; null if it's bigger than `limit`. */
export async function bodyBytes(request, limit = 64 * 1024) {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  return bytes.length > limit ? null : bytes;
}

/** JSON from a call's body (bytes); {} if it isn't an object. */
export function bodyJson(bytes) {
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
