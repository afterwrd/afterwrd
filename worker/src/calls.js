// Signed calls between friends' sites (afterwrd 2, step 4b: docs/signed-conversations.md). Making friends works as it
// always has (connect.js); each friend is tied to their identity the first time it's needed (friendPerson), and every
// call about posts is signed with the calling site's hosting key (signedcalls.js): no per-friend passwords. (Those, and
// the old /_peer routes, go in step 4e.)
import { checkCall, signCall } from "./signedcalls.js";
import { fetchIdentity, hostingKeyFor } from "./identities.js";
import { ownHost } from "./items.js";
import { host, readLimited } from "./peers.js";

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
 * Calls a friend's site, signed by this one (`from`: this site's address). Returns what it answered (JSON), or throws
 * an Error with `status` (0: couldn't reach it), as peers.js callSite does.
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
 * The calling site's address is checked to be a friend's first, so a stranger can't make this site fetch anything.
 * `body` is the call's body as received (bytes), if any.
 */
export async function friendCalling(request, env, url, body = null) {
  const from = request.headers.get("Afterwrd-From") ?? "";
  const connection = from && (await env.DB.prepare("SELECT * FROM connections WHERE origin = ? AND approved_at IS NOT NULL AND connected_at IS NOT NULL")
    .bind(from).first());
  if (!connection) return Response.json({ error: "Not allowed." }, { status: 403 });
  const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers, body },
    { ownOrigin: url.origin, hostingKeyOf: (person, site) => (connection.identity && connection.identity !== person ? null : hostingKeyFor(env, person, site)) });
  if (!caller) return Response.json({ error: "Not signed." }, { status: 401 });
  if (!connection.identity) await env.DB.prepare("UPDATE connections SET identity = ? WHERE id = ? AND identity IS NULL").bind(caller.person, connection.id).run();
  return { connection, person: caller.person };
}
