// Other people's identities (afterwrd 2: docs/signed-conversations.md, section 1), and this site's own, as others see it.
//   GET /.well-known/afterwrd   this site's owner's identity: every identity document, and nothing else (keys, the
//                               site's address, a recovery key: no name or picture). Public, so anyone can check
//                               something the owner signed, wherever they met it.
//   GET /_p/profile             the owner's signed profile (their name), only to a signed call (signedcalls.js) from a
//                               friend's site: until protocol 2's ties replace them, a friend is a site the owner
//                               approved (connections), whose identity names that address.
// Learning someone's identity checks every document (identity.js), notes when this site first saw each (the 7 days of
// a slow change run from then), keeps the longest chain that reads cleanly, and freezes an identity seen in two
// different versions: someone holding one of its keys is fighting the owner, so nothing it signs is trusted.
import { forked, moveOf, ownerOf, readIdentity } from "./identity.js";
import { checkCall } from "./signedcalls.js";
import { siteOrigin } from "./sites.js";
import { b64url, checkAs, decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { checkDelegation } from "./identity.js";
import { json, now } from "./util.js";

const MAX_CHAIN = 200;
const MAX_REPLY = 512 * 1024;
const FETCH_MS = 8000;

/** A chain as sent or stored ([{bytes: base64url, sig}]) decoded; null if it isn't one. */
export function parseChain(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHAIN) return null;
  const chain = [];
  for (const d of value) {
    const bytes = typeof d?.bytes === "string" ? fromB64url(d.bytes) : null;
    if (!bytes || !d.sig || typeof d.sig !== "object") return null;
    chain.push({ bytes, sig: d.sig });
  }
  return chain;
}

const storedChain = (chain) => JSON.stringify(chain.map(({ bytes, sig }) => ({ bytes: b64url(bytes), sig })));

/** When this site first saw each document of `chain` (noting now for any it hasn't), as a lookup. */
async function seenTimes(db, chain) {
  const fps = await Promise.all(chain.map((d) => fingerprintOf("identity", d.bytes)));
  const at = now();
  await db.batch(fps.map((fp) => db.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(fp, at)));
  const { results } = await db.prepare("SELECT fp, first_seen FROM identity_seen WHERE fp IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(fps)).all();
  const seen = new Map(results.map((r) => [String(r.fp), Number(r.first_seen)]));
  return (fp) => seen.get(fp) ?? at;
}

/**
 * How `chain` reads here now: a group's (step 6) with its owner's identity beside it, as this site knows them.
 * @param {D1Database} db
 */
export async function readChain(db, chain, firstSeen, at = now()) {
  const ownerId = ownerOf(chain);
  const owner = ownerId ? await stateIn(db, ownerId) : null;
  if (ownerId && !owner) return null;
  return readIdentity(chain, firstSeen, at, { owner });
}

/** The longest start of `chain` that reads without a problem, and how it reads; null if not even the first does. */
async function cleanest(db, chain, firstSeen, at) {
  for (let n = chain.length; n > 0; n--) {
    const state = await readChain(db, chain.slice(0, n), firstSeen, at);
    if (!state) return null;
    if (!state.problem) return { chain: chain.slice(0, n), state };
  }
  return null;
}

/**
 * Learns an identity from `chain` (decoded). Returns how it reads now, with `frozen` if this site has seen two versions
 * of it; null if it isn't an identity at all. A group's comes with its owner's (`owner`, decoded), learnt first.
 * @param {Env} env @param {any[]} chain @param {{ owner?: any[] | null }} [options]
 */
export async function learnIdentity(env, chain, { owner = null } = {}) {
  const db = env.DB;
  if (ownerOf(chain) && owner && !ownerOf(owner)) await learnIdentity(env, owner);
  const firstSeen = await seenTimes(db, chain);
  const at = now();
  const found = await cleanest(db, chain, firstSeen, at);
  if (!found) return null;
  const { state } = found;
  const row = await db.prepare("SELECT chain, frozen_at FROM identities WHERE person = ?").bind(state.id).first();
  const known = row && parseChain(JSON.parse(String(row.chain)));
  if (known && (await forked(known, found.chain))) {
    await db.prepare("UPDATE identities SET frozen_at = COALESCE(frozen_at, ?) WHERE person = ?").bind(at, state.id).run();
    return { ...state, frozen: true };
  }
  if (known && known.length >= found.chain.length) {
    const kept = await cleanest(db, known, firstSeen, at);
    return kept && { ...kept.state, frozen: Boolean(row.frozen_at) };
  }
  // A change of address (waiting or done) is kept beside it: friends' sites switch to the new address when it's in
  // effect here (calls.js), and Home says they're moving meanwhile.
  const move = moveOf(state);
  await db.prepare(`INSERT INTO identities (person, origin, chain, updated_at, moving_to, moving_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(person) DO UPDATE SET origin = excluded.origin, chain = excluded.chain, updated_at = excluded.updated_at,
      moving_to = excluded.moving_to, moving_at = excluded.moving_at`)
    .bind(state.id, state.current.origin, storedChain(found.chain), at, move?.to ?? null, move?.at ?? null).run();
  return { ...state, frozen: Boolean(row?.frozen_at) };
}

/** Fetches the identity a site's address gives, learns it, and checks it names that address; null if not. */
export async function fetchIdentity(env, origin) {
  const site = siteOrigin(origin, env);
  if (!site) return null;
  const response = await fetch(`${site}/.well-known/afterwrd`, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS) }).catch(() => null);
  if (!response?.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const data = bytes.length && bytes.length <= MAX_REPLY ? decode(bytes) : null;
  const chain = parseChain(data?.chain);
  const state = chain && (await learnIdentity(env, chain, { owner: parseChain(data?.owner) }));
  if (!state || state.frozen || state.current.origin !== site) return null;
  await env.DB.prepare("UPDATE identities SET origin_checked_at = ? WHERE person = ?").bind(now(), state.id).run();
  return state;
}

/**
 * Whether the site at `origin` answers as an afterwrd site does (its public /_version, which every release since
 * 0.17 has: {id}), for a site with no identity at /.well-known/afterwrd: one still on afterwrd 1, or updated and not
 * set up since (step 10a). A site that's gone answers nothing, or something else (Cloudflare's own 404 page).
 * @param {Env} env @param {string} origin
 */
export async function answersAsAfterwrd(env, origin) {
  const site = siteOrigin(origin, env);
  if (!site) return false;
  const response = await fetch(`${site}/_version`, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS) }).catch(() => null);
  if (!response?.ok) return false;
  const text = await response.text().catch(() => "");
  if (text.length > 1000) return false;
  try {
    const data = JSON.parse(text);
    return Boolean(data) && typeof data === "object" && !Array.isArray(data) && "id" in data;
  } catch {
    return false;
  }
}

/** How `person`'s identity reads now, from what this site knows (null if it knows nothing of them), with `frozen`. */
export async function identityState(env, person) {
  return stateIn(env.DB, person);
}

/** identityState, from the database alone. @param {D1Database} db @param {string} person */
async function stateIn(db, person) {
  const row = await db.prepare("SELECT chain, frozen_at FROM identities WHERE person = ?").bind(person).first();
  const chain = row && parseChain(JSON.parse(String(row.chain)));
  if (!chain) return null;
  const state = await readChain(db, chain, await seenTimes(db, chain), now());
  return state && { ...state, frozen: Boolean(row.frozen_at) };
}

/** The hosting key `person` signs calls from `from` with: from what's known, or by fetching their identity from there. */
export async function hostingKeyFor(env, person, from) {
  const row = await env.DB.prepare("SELECT chain, frozen_at FROM identities WHERE person = ?").bind(person).first();
  if (row && !row.frozen_at) {
    const chain = parseChain(JSON.parse(String(row.chain)));
    const state = chain && (await readChain(env.DB, chain, await seenTimes(env.DB, chain), now()));
    if (state && !state.problem && state.current.origin === from) return state.current.hosting;
  }
  const fetched = await fetchIdentity(env, from);
  return fetched?.id === person ? fetched.current.hosting : null;
}

/**
 * Whether a signed profile ({bytes, key, signature, delegation: {bytes, proof}}) is `state`'s person's, as signed by one
 * of their browser keys while it was allowed to. Returns the profile ({name, at}) or null.
 */
export async function checkProfile(envelope, state) {
  const bytes = typeof envelope?.bytes === "string" ? fromB64url(envelope.bytes) : null;
  const profile = bytes && decode(bytes);
  if (!profile || profile.v !== 2 || profile.kind !== "profile" || profile.person !== state.id || typeof profile.name !== "string"
    || !Number.isSafeInteger(profile.at)) return null;
  const delegation = typeof envelope.delegation?.bytes === "string" ? fromB64url(envelope.delegation.bytes) : null;
  const key = delegation && (await checkDelegation(delegation, envelope.delegation.proof, state, profile.at));
  if (!key || key !== envelope.key || !(await checkAs("profile", key, bytes, envelope.signature))) return null;
  return { name: profile.name.slice(0, 100), at: profile.at };
}

/** GET /.well-known/afterwrd and GET /_p/profile; null for anything else. */
export async function handleIdentity(request, env, url) {
  if (request.method !== "GET") return null;
  if (url.pathname === "/.well-known/afterwrd") {
    const row = await env.DB.prepare("SELECT chain FROM own_identity WHERE id = 1").first();
    if (!row) return json({ error: "Not found." }, 404);
    // A group's site (step 6) gives its owner's identity too, which a reader needs to check the group's.
    const chain = JSON.parse(String(row.chain));
    const ownerId = ownerOf(parseChain(chain));
    const owner = ownerId && (await env.DB.prepare("SELECT chain FROM identities WHERE person = ?").bind(ownerId).first());
    const response = json({ v: 2, chain, ...(owner && { owner: JSON.parse(String(owner.chain)) }) });
    response.headers.set("Cache-Control", "public, max-age=60");
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  }
  if (url.pathname === "/_p/profile") {
    // Only friends' sites, so a stranger can't even make this site fetch anything: their address is checked first.
    const from = request.headers.get("Afterwrd-From") ?? "";
    const friend = from && (await env.DB.prepare("SELECT 1 FROM connections WHERE origin = ? AND approved_at IS NOT NULL").bind(from).first());
    if (!friend) return json({ error: "Not allowed." }, 403);
    const caller = await checkCall({ method: request.method, url: request.url, headers: request.headers },
      { ownOrigin: url.origin, hostingKeyOf: (person, site) => hostingKeyFor(env, person, site) });
    if (!caller) return json({ error: "Not signed." }, 401);
    const row = await env.DB.prepare("SELECT profile FROM own_identity WHERE id = 1").first();
    return row?.profile ? json({ v: 2, profile: JSON.parse(String(row.profile)) }) : json({ error: "Not found." }, 404);
  }
  return null;
}
