// Helpers for talking to other sites: their addresses, and unsigned calls (for what isn't about anyone: a friend link's
// name, groups until step 6). Calls between friends' sites are signed (calls.js).
const TIMEOUT_MS = 8000;
const MAX_REPLY = 2_000_000;
// The keys groups and their members' sites call each other with (groups.js, membership.js), until groups are signed
// too (docs/signed-conversations.md, step 6).
export const KEY_RE = /^[\w-]{40,100}$/;
// The version of the protocol between sites (PROTOCOL.md), sent in the hello and ping answers. Adding things doesn't
// change it; anything an older site would misread does.
export const PROTOCOL = 1;

/** An https site address as an origin, or null. http on this computer only when testing (ALLOW_LOCAL_SITES). */
export function siteOrigin(text, env) {
  try {
    const url = new URL(String(text));
    const local = env?.ALLOW_LOCAL_SITES === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    // No trailing dot: "https://you.example." is the same site as "https://you.example", but wouldn't compare equal.
    if ((url.protocol === "https:" || local) && !url.username && !url.password && !url.hostname.endsWith(".")) return url.origin;
  } catch {}
  return null;
}

export const host = (origin) => new URL(origin).host;

export async function ownerName(db) {
  const owner = await db.prepare("SELECT name FROM users LIMIT 1").first();
  return owner?.name ?? "Someone";
}

/**
 * Calls another site, JSON both ways; throws with a message fit to show the owner, and `status`: what their site
 * answered (0: no answer).
 * @param {string} origin
 * @param {string} path
 * @param {{ key?: string, body?: object, timeout?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function callSite(origin, path, { key, body, timeout = TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error(`Couldn't reach ${host(origin)}.`), { status: 0 }); // status: what their site answered
  }
  let data = {};
  try {
    data = JSON.parse(await readLimited(response, MAX_REPLY));
  } catch {}
  // Whatever else a site answers (null, a list, a number) counts as saying nothing.
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `${host(origin)} answered ${response.status}.`),
      { status: response.status });
  }
  return data;
}

export async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Reply too big.");
    }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}
