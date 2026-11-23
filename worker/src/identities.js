// Other people's identities (afterwrd 2: docs/signed-conversations.md, section 1), and this site's own, as others see it.
//   GET /.well-known/afterwrd   this site's owner's identity: every identity document, and nothing else (keys, the
//                               site's address, a recovery key: no name or picture). Public, so anyone can check
//                               something the owner signed, wherever they met it.
// Friends get the owner's signed profile (their name) with their posts (friendhost.js) and when making friends
// (connect.js), never on its own.
// Learning someone's identity checks every document (identity.js), notes when this site first saw each (the 7 days of
// a slow change run from then), keeps the longest chain that reads cleanly, and freezes an identity seen in two
// different versions: someone holding one of its keys is fighting the owner, so nothing it signs is trusted.
import { forked, moveOf, ownerOf, readIdentity } from "./identity.js";
import { readBytesLimited, siteOrigin } from "./sites.js";
import { b64url, checkAs, decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { checkDelegation } from "./identity.js";
import { json, now } from "./util.js";
import { later } from "./later.js";

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

/**
 * When this site first saw each document of `chain`, as a lookup: now for any it hasn't. Nothing is noted here: only a
 * document that has read cleanly is (noteSeen), or anyone could hand this site a change's bytes, unsigned, days before
 * signing them, and so start its 7 days early.
 */
export async function seenTimes(db, chain) {
  const fps = await Promise.all(chain.map((d) => fingerprintOf("identity", d.bytes)));
  const at = now();
  const { results } = await db.prepare("SELECT fp, first_seen FROM identity_seen WHERE fp IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(fps)).all();
  const seen = new Map(results.map((r) => [String(r.fp), Number(r.first_seen)]));
  return (fp) => seen.get(fp) ?? at;
}

/** Notes now as when this site first saw each document of `chain` (one that has read cleanly), unless it saw it before. */
export async function noteSeen(db, chain) {
  const fps = await Promise.all(chain.map((d) => fingerprintOf("identity", d.bytes)));
  const at = now();
  await db.batch(fps.map((fp) => db.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(fp, at)));
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
  const state = await readChain(db, chain, firstSeen, at);
  if (!state) return null;
  if (!state.problem) return { chain, state };
  // Read once more, up to the document with the problem (readIdentity says how far it got), to see how that reads alone.
  const clean = chain.slice(0, state.clean);
  const again = clean.length ? await readChain(db, clean, firstSeen, at) : null;
  return again && !again.problem ? { chain: clean, state: again } : null;
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
  await noteSeen(db, found.chain);
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

const MAX_NEW = 1100; // identities new to this site one answer can have it learn: a group's or a friend's thousand, and a few

/** Everyone who signed a record anywhere in `value` (an answer or note, as decoded: records are `{record, sig}`). */
export function signersIn(value) {
  const out = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (typeof v.record === "string" && typeof v.sig === "string") {
      try {
        const author = JSON.parse(new TextDecoder().decode(fromB64url(v.record)))?.author;
        if (typeof author === "string") out.add(author);
      } catch {}
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

/**
 * Learns, from `people` as another site passed them on ({person: {chain, profile?}}), only those in `wanted` (who signed
 * something in what it sent: signersIn), and at most MAX_NEW this site didn't know: a host can't fill this site with
 * identities, or use up its writes, by sending ones nobody needs. Returns their signed names, checked (person -> name).
 * @param {Env} env @param {any} people @param {Set<string>} wanted
 */
export async function learnPeopleIn(env, people, wanted) {
  const names = new Map();
  const asked = Object.entries(people && typeof people === "object" ? people : {}).filter(([p]) => wanted.has(p) && /^[A-Za-z0-9_-]{43}$/.test(p));
  if (!asked.length) return names;
  const { results } = await env.DB.prepare("SELECT person FROM identities WHERE person IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(asked.map(([p]) => p))).all();
  const known = new Set(results.map((r) => String(r.person)));
  let fresh = 0;
  for (const [p, info] of asked) {
    if (!known.has(p) && fresh++ >= MAX_NEW) continue;
    const chain = parseChain(info?.chain);
    const state = chain && (await learnIdentity(env, chain));
    if (!state || state.id !== p) continue;
    const profile = info.profile && (await checkProfile(info.profile, state));
    if (profile) {
      names.set(p, profile.name);
      await keepNewerProfile(env.DB, p, info.profile, profile.at);
    }
  }
  return names;
}

/** Fetches the identity a site's address gives, learns it, and checks it names that address; null if not. */
export async function fetchIdentity(env, origin) {
  const site = siteOrigin(origin, env);
  if (!site) return null;
  const response = await fetch(`${site}/.well-known/afterwrd`, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS) }).catch(() => null);
  if (!response?.ok) return null;
  const bytes = await readBytesLimited(response, MAX_REPLY).catch(() => new Uint8Array());
  const data = bytes.length ? decode(bytes) : null;
  const chain = parseChain(data?.chain);
  const owner = parseChain(data?.owner);
  // Learnt only if it's that site's to give: an identity that has been at that address (now, before a move, or moving
  // there). Otherwise any site could hand this one someone else's chain, as if from them.
  if (!chain || !(await givenBy(env.DB, chain, owner, site))) return null;
  const state = await learnIdentity(env, chain, { owner });
  if (!state || state.frozen || state.current.origin !== site) return null;
  await env.DB.prepare("UPDATE identities SET origin_checked_at = ? WHERE person = ?").bind(now(), state.id).run();
  return state;
}

/**
 * Whether `chain` (with a group's `owner` chain beside it) reads as an identity that has been at `site`: the address
 * of a document in effect, or of one waiting. Read here without keeping anything.
 * @param {D1Database} db @param {any[]} chain @param {any[] | null} owner @param {string} site
 */
async function givenBy(db, chain, owner, site) {
  const at = now();
  const ownerId = ownerOf(chain);
  let ownerState = null;
  if (ownerId) {
    ownerState = owner && !ownerOf(owner) ? await readIdentity(owner, await seenTimes(db, owner), at) : null;
    if (ownerState?.id !== ownerId) ownerState = await stateIn(db, ownerId);
    if (!ownerState) return false;
  }
  const state = await readIdentity(chain, await seenTimes(db, chain), at, { owner: ownerState });
  return Boolean(state) && [...state.history.map((h) => h.doc), state.pending].some((d) => d?.origin === site);
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

const REFETCH_SECONDS = 600;

/** The hosting key `person` signs calls from `from` with: from what's known, or by fetching their identity from there. */
export async function hostingKeyFor(env, person, from, { again = false } = {}) {
  const row = await env.DB.prepare("SELECT chain, frozen_at, updated_at FROM identities WHERE person = ?").bind(person).first();
  // Asked again (a signature that didn't check with the key known): fetched afresh, but not more than every 10 minutes
  // for anyone, so bad signatures can't make this site fetch from them over and over.
  if (again) {
    if (!row || row.frozen_at || Number(row.updated_at ?? 0) > now() - REFETCH_SECONDS) return null;
    const refresh = (async () => {
      await env.DB.prepare("UPDATE identities SET updated_at = ? WHERE person = ?").bind(now(), person).run();
      return fetchIdentity(env, from);
    })().catch(() => null);
    // Fetched after the answer has gone, when there's a request to hand it to: how long a refused call takes then says
    // nothing about whether the caller named someone this site knows (a friend, a member). They're let in next time.
    if (later(refresh)) return null;
    const fetched = await refresh;
    return fetched?.id === person ? fetched.current.hosting : null;
  }
  const known = row && !row.frozen_at ? await keyIfKnown(env.DB, row, from) : null;
  if (known) return known;
  const fetched = await fetchIdentity(env, from);
  return fetched?.id === person ? fetched.current.hosting : null;
}

/** The hosting key `person` signs calls from `from` with, from what this site knows alone (it fetches nothing); or null. */
export async function knownHostingKey(env, person, from) {
  const row = await env.DB.prepare("SELECT chain, frozen_at FROM identities WHERE person = ?").bind(person).first();
  return row && !row.frozen_at ? keyIfKnown(env.DB, row, from) : null;
}

async function keyIfKnown(db, row, from) {
  const chain = parseChain(JSON.parse(String(row.chain)));
  const state = chain && (await readChain(db, chain, await seenTimes(db, chain), now()));
  return state && !state.problem && state.current.origin === from ? state.current.hosting : null;
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

/**
 * Keeps `profile` (checked: checkProfile gave `at`) as `person`'s signed name, unless the one kept is as new or newer:
 * anyone passing on an old signed profile can't put back an old name. Whether it was kept.
 */
export async function keepNewerProfile(db, person, profile, at) {
  const row = await db.prepare("SELECT profile FROM identities WHERE person = ?").bind(person).first();
  if (!row) return false;
  let kept = null;
  try { kept = row.profile ? decode(fromB64url(JSON.parse(String(row.profile)).bytes))?.at : null; } catch {}
  if (Number.isSafeInteger(kept) && kept >= at) return false;
  // Only if no one kept another meanwhile.
  const { meta } = await db.prepare("UPDATE identities SET profile = ? WHERE person = ? AND profile IS ?")
    .bind(JSON.stringify(profile), person, row.profile ?? null).run();
  return Number(meta?.changes ?? 0) > 0;
}

/** GET /.well-known/afterwrd; null for anything else. */
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
  return null;
}
