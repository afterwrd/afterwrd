// Signed calls between sites (afterwrd 2: docs/signed-conversations.md). Every call one site makes to another about its
// owner (making friends, posts, checks, the shared Facebook archive) is signed with the calling site's hosting key
// (signedcalls.js), and the receiver works out who's calling from the caller's identity, fetched from the caller's own
// address (/.well-known/afterwrd): no passwords are handed over or kept. Each friend is tied to their identity when the
// friendship is made (connect.js), or the first time it's needed (friendPerson).
import { checkCall, signCall } from "./signedcalls.js";
import { fetchIdentity, hostingKeyFor } from "./identities.js";
import { ownHost } from "./items.js";
import { host, ownerName, readLimited } from "./sites.js";

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
 * @param {{ body?: object | null, timeout?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function callFriend(env, from, origin, path, { body = null, timeout = TIMEOUT_MS } = {}) {
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
  try { data = JSON.parse(await readLimited(response, MAX_REPLY)); } catch {}
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `${host(origin)} answered ${response.status}.`), { status: response.status });
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
  const from = request.headers.get("Afterwrd-From") ?? "";
  const connection = from && (await env.DB.prepare("SELECT * FROM connections WHERE origin = ? AND connected_at IS NOT NULL")
    .bind(from).first());
  if (!connection) return notConnected();
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site) => (connection.identity && connection.identity !== person ? null : hostingKeyFor(env, person, site)) });
  if (!caller) return notConnected();
  if (!connection.identity) {
    await env.DB.prepare("UPDATE connections SET identity = ? WHERE id = ? AND identity IS NULL").bind(caller.person, connection.id).run();
    connection.identity = caller.person;
  }
  if (!connection.approved_at && !waiting) {
    return Response.json({ error: `Waiting for ${await ownerName(env.DB)} to approve the connection.` }, { status: 403 });
  }
  return { connection: /** @type {Row<"connections">} */ (/** @type {unknown} */ (connection)), person: caller.person };
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
export function siteCalling(request, env, url, body) {
  return checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site) => hostingKeyFor(env, person, site) });
}

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
