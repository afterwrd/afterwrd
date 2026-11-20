// The owner's keys (afterwrd 2: docs/signed-conversations.md, section 1). Three kinds live with this site:
// - the hosting key, the site's own (settings 'hosting_key', made on first use): it signs what the site does as host,
//   and its calls to other sites, never anything as the owner;
// - the owner's identity (own_identity): a chain of identity documents signed with their passkeys (src/identity.js);
// - delegations: the browser keys allowed to sign for the owner, each for 30 days from signing in on that browser.
// The private halves of the passkeys and browser keys never come here; the recovery code never comes here at all.
//
// Setting up signing (once; for a new site straight after its first passkey, for an older one at its next sign-in):
//   GET  /_admin/keys?next=…   the recovery code, made and shown by the page, then one passkey prompt
//   POST /_admin/keys/start    {recovery, browserKey} -> {nonce, identity, delegation, allow}: the first identity
//                              document (every passkey the owner has now) and this browser's delegation, made here
//                              and signed together by one passkey in the browser
//   POST /_admin/keys/finish   {identity, delegation, response} -> {person, expires}
// Signing in afterwards makes each browser's delegation in the sign-in prompt itself (auth.js loginOptions).
import { checkDelegation, parseIdentity, readIdentity } from "./identity.js";
import { readChallenge, safeNext, spendChallenge, withChallenge } from "./auth.js";
import { b64url, decode, encode, fingerprintOf, fromB64url, newKeyPair } from "../public/static/signed.js";
import { html, json, now, randomToken } from "./util.js";
import { keysPage } from "./views/pages.js";

export const DELEGATION_SECONDS = 30 * 86400; // as long as a session
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCS8_PREFIX = "MC4CAQAwBQYDK2VwBCIEI"; // base64url of an Ed25519 PKCS #8 key's fixed first bytes, for a sanity check

let hosting = null;

/** The site's hosting key: {privateKey, publicKey (base64url)}, made on first use and kept in settings. */
export async function hostingKey(env) {
  if (hosting) return hosting;
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'hosting_key'").first();
  if (!row) {
    const pair = await newKeyPair(true);
    const pkcs8 = b64url(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hosting_key', ?)").bind(pkcs8).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'hosting_key'").first(); // whichever won a race
  }
  if (!String(row.value).startsWith(PKCS8_PREFIX)) throw new Error("The hosting key isn't readable.");
  const pkcs8 = fromB64url(row.value);
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const { x } = /** @type {JsonWebKey} */ (await crypto.subtle.exportKey("jwk", extractable));
  hosting = { privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]), publicKey: x };
  return hosting;
}

/**
 * The owner's identity as this site reads it now: {person, chain, state}, or null before they've set up signing.
 * @param {D1Database} db
 */
export async function ownIdentity(db) {
  const row = await db.prepare("SELECT person, chain FROM own_identity WHERE id = 1").first();
  if (!row) return null;
  const chain = JSON.parse(String(row.chain)).map(({ bytes, sig }) => ({ bytes: fromB64url(bytes), sig }));
  const { results } = await db.prepare("SELECT fp, first_seen FROM identity_seen").all();
  const seen = new Map(results.map((r) => [String(r.fp), Number(r.first_seen)]));
  const state = await readIdentity(chain, (fp) => seen.get(fp) ?? now(), now());
  return state ? { person: String(row.person), chain, state } : null;
}

/** A delegation for `browserKey` to sign for the owner from now for 30 days; null without an identity or a proper key. */
export async function loginDelegation(env, url, browserKey) {
  if (typeof browserKey !== "string" || !KEY_RE.test(browserKey)) return null;
  const row = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  if (!row) return null;
  return encode({ v: 2, kind: "delegation", person: row.person, key: browserKey, origin: url.origin, expires: now() + DELEGATION_SECONDS });
}

/**
 * A delegation a browser sent back (base64url): the bytes if it's one this site would have made (its owner, its
 * address, no longer than 30 days from now), null if not. The passkey's signature is checked by the caller.
 */
export async function sentDelegation(env, url, text) {
  const bytes = typeof text === "string" && text.length < 2048 ? fromB64url(text) : null;
  const d = bytes && decode(bytes);
  if (!d || d.v !== 2 || d.kind !== "delegation" || d.origin !== url.origin || !KEY_RE.test(d.key ?? "")) return null;
  if (!Number.isSafeInteger(d.expires) || d.expires > now() + DELEGATION_SECONDS + 600 || d.expires < now()) return null;
  const row = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  return row && d.person === row.person ? bytes : null;
}

/**
 * Keeps a delegation once its passkey's proof checks against the owner's identity as it is now (so a passkey that
 * isn't the identity's, or has been removed from it, can sign in but not sign). Returns {person, expires} or null.
 */
export async function keepDelegation(env, { bytes, proof, credentialId, sessionHash }) {
  const own = await ownIdentity(env.DB);
  if (!own) return null;
  const key = await checkDelegation(bytes, proof, own.state, now());
  if (!key) return null;
  const { expires } = decode(bytes);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM delegations WHERE expires_at < ?").bind(now()),
    env.DB.prepare(`INSERT OR REPLACE INTO delegations (key, bytes, proof, credential_id, session_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(key, b64url(bytes), JSON.stringify(proof), credentialId, sessionHash, expires, now()),
  ]);
  return { person: own.person, expires };
}

/** /_admin/keys…: setting up signing. Signed in (app.js); POSTs come from this site's own pages (app.js checks). */
export async function handleKeys(request, env, url, owner) {
  const route = `${request.method} ${url.pathname}`;
  const next = safeNext(url.searchParams.get("next"), url);
  if (route === "GET /_admin/keys") {
    if (await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1").first()) return Response.redirect(`${url.origin}${next}`, 303);
    return html(keysPage(next));
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (route === "POST /_admin/keys/start") return await start(env, url, owner, body);
    if (route === "POST /_admin/keys/finish") return await finish(request, env, url, owner, body);
  } catch (error) {
    console.error(`${route}: ${error.message}`);
    return json({ error: "That didn't work. Try again." }, 400);
  }
  return new Response("Not found", { status: 404 });
}

/** The owner's passkeys as an identity document lists them. */
async function passkeysOf(env, url, owner) {
  const { results } = await env.DB.prepare("SELECT id, public_key FROM credentials WHERE user_id = ? ORDER BY created_at").bind(owner.id).all();
  return results.map((c) => ({ id: String(c.id), key: String(c.public_key), origin: url.origin }));
}

async function start(env, url, owner, { recovery, browserKey }) {
  if (!KEY_RE.test(recovery ?? "") || !KEY_RE.test(browserKey ?? "")) return json({ error: "That didn't work. Try again." }, 400);
  if (await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1").first()) return json({ error: "Signing is already set up." }, 409);
  const passkeys = await passkeysOf(env, url, owner);
  if (!passkeys.length) return json({ error: "Add a passkey first." }, 400);
  const identity = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin: url.origin, passkeys, recovery,
    hosting: (await hostingKey(env)).publicKey });
  const person = await fingerprintOf("identity", identity);
  const delegation = encode({ v: 2, kind: "delegation", person, key: browserKey, origin: url.origin, expires: now() + DELEGATION_SECONDS });
  const nonce = randomToken();
  return withChallenge(env, "keys", nonce, json({ nonce, identity: b64url(identity), delegation: b64url(delegation),
    allow: passkeys.map((p) => p.id) }));
}

async function finish(request, env, url, owner, { identity: identityText, delegation: delegationText, response }) {
  const nonce = await readChallenge(request, env, "keys");
  if (!nonce) return json({ error: "That took too long. Try again." }, 400);
  const identity = typeof identityText === "string" ? fromB64url(identityText) : null;
  const delegation = typeof delegationText === "string" ? fromB64url(delegationText) : null;
  const doc = identity && parseIdentity(identity);
  // Only what start made: this site's address and hosting key, the owner's own passkeys.
  const mine = await passkeysOf(env, url, owner);
  if (!doc || doc.seq !== 0 || doc.origin !== url.origin || doc.hosting !== (await hostingKey(env)).publicKey
    || doc.passkeys.some((p) => !mine.some((m) => m.id === p.id && m.key === p.key)) || !delegation) {
    return json({ error: "That didn't work. Try again." }, 400);
  }
  const statements = [await fingerprintOf("identity", identity), await fingerprintOf("delegation", delegation)];
  const r = response?.response ?? {};
  const proof = { credential: String(response?.id ?? ""), nonce, statements,
    response: { authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature, ...(r.userHandle ? { userHandle: r.userHandle } : {}) } };
  const state = await readIdentity([{ bytes: identity, sig: { passkey: proof } }], () => now(), now());
  const key = state && (await checkDelegation(delegation, proof, state, now()));
  if (!state || !key) return json({ error: "Your passkey's signature didn't check. Try again." }, 400);
  if (!(await spendChallenge(env, nonce))) return json({ error: "That didn't work. Try again." }, 400);
  const { expires } = decode(delegation);
  const [made] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO own_identity (id, person, chain, created_at) SELECT 1, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM own_identity)`).bind(state.id, JSON.stringify([{ bytes: b64url(identity), sig: { passkey: proof } }]), now()),
    env.DB.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(state.id, now()),
  ]);
  if (!made.meta.changes) return json({ error: "Signing is already set up." }, 409);
  await env.DB.prepare(`INSERT OR REPLACE INTO delegations (key, bytes, proof, credential_id, session_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(key, b64url(delegation), JSON.stringify(proof), proof.credential, owner.session_hash ?? null, expires, now()).run();
  return json({ person: state.id, expires });
}

/** Whether the owner has set up signing yet. */
export async function hasIdentity(db) {
  return Boolean(await db.prepare("SELECT 1 FROM own_identity WHERE id = 1").first());
}
