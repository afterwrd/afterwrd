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
//
// Changing the identity (from Your devices; each a new identity document: src/identity.js says when each counts):
//   POST /_admin/keys/change/start   {change: "allow" | "remove" | "recovery" | "cancel", credential?, recovery?}
//                                    -> {nonce, doc, allow}: the next document, for one of the identity's passkeys to sign
//   POST /_admin/keys/change/finish  {doc, response}
//     allow     every passkey the owner has here signs for them (at once)
//     remove    one stops (after 7 days); Your devices also removes it from signing in, at once
//     recovery  a new recovery code (after 7 days)
//     cancel    a change that's waiting doesn't happen
//     move      a new address: a new site's hosting key and passkey, from the move request that site's passkey signed
//               (after 7 days; move.js has the new site's side, and docs/signed-conversations.md "4f in detail" the whole)
//   GET  /_admin/keys/move#<request> agreeing to move, on the old site: the page a new site sends the owner to
//   POST /_admin/keys/move/check     {request, proof} -> {to}: whether that's a move this site would sign
//   POST /_admin/keys/recover/start  {change: "devices" | "cancel"} -> {doc}: signed in the browser with the recovery
//   POST /_admin/keys/recover/finish {doc, signature}                    code's key, never a passkey
//     devices   the passkeys this site has now are the ones that sign (after 7 days): back in after losing every device
// A browser here that can't sign yet (it signed in before this site had the owner's identity: a move, movein.js):
//   POST /_admin/keys/browser/start  {browserKey} -> {nonce, delegation, allow}: one prompt, as at sign-in
//   POST /_admin/keys/browser/finish {delegation, response} -> {person, expires}
// Adding a device that signs straight away (device links made on a device that signs):
//   POST /_admin/keys/enrol/start    {link} -> {nonce, statement, allow}: this device's passkey allows that link's token
//   POST /_admin/keys/enrol/finish   {statement, response}
//   GET  /_admin/keys/join           on the new device, after its passkey: one more prompt adds it, and this browser
//   POST /_admin/keys/join/start     {browserKey} -> {nonce, doc, delegation, allow}
//   POST /_admin/keys/join/finish    {doc, delegation, token, response}
import { checkDelegation, checkPasskeyProof, moveOf, parseIdentity, readIdentity } from "./identity.js";
import { siteOrigin } from "./sites.js";
import { readChallenge, safeNext, spendChallenge, withChallenge } from "./auth.js";
import { b64url, checkAs, decode, encode, fingerprintOf, fromB64url, newKeyPair, sha256, utf8 } from "../public/static/signed.js";
import { html, json, now, randomToken } from "./util.js";
import { joinPage, keysPage, moveOutPage } from "./views/pages.js";
import { sha256 as sha256Hex } from "./util.js";

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
    rememberOwn(env, own.person, key, b64url(bytes), proof, expires),
  ]);
  return { person: own.person, expires };
}

/** /_admin/keys…: setting up signing. Signed in (app.js); POSTs come from this site's own pages (app.js checks). */
export async function handleKeys(request, env, url, owner) {
  const route = `${request.method} ${url.pathname}`;
  const next = safeNext(url.searchParams.get("next"), url);
  if (route === "GET /_admin/keys") {
    if (await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1").first()) return Response.redirect(`${url.origin}${next}`, 303);
    if (await env.DB.prepare("SELECT 1 FROM move_in WHERE id = 1").first()) return Response.redirect(`${url.origin}/_admin/import/move`, 303);
    return html(keysPage(next));
  }
  if (route === "GET /_admin/keys/join") return html(joinPage());
  if (route === "GET /_admin/keys/move") return html(moveOutPage());
  // Moved away: the identity is the new site's now, and changes to it are made there (its passkeys sign it).
  const gone = request.method === "POST" ? await ownMove(env.DB, url.origin) : null;
  if (gone?.done) return json({ error: `You've moved to ${new URL(gone.to).host}. Change your identity there.` }, 410);
  if (route === "POST /_admin/keys/profile") return await keepProfile(env, owner, await request.json().catch(() => ({})));
  const body = await request.json().catch(() => ({}));
  try {
    if (route === "POST /_admin/keys/start") return await start(env, url, owner, body);
    if (route === "POST /_admin/keys/finish") return await finish(request, env, url, owner, body);
    if (route === "POST /_admin/keys/move/check") return await moveCheck(env, url, body);
    if (route === "POST /_admin/keys/change/start") return await changeStart(env, url, owner, body);
    if (route === "POST /_admin/keys/change/finish") return await changeFinish(request, env, body);
    if (route === "POST /_admin/keys/recover/start") return await recoverStart(env, url, owner, body);
    if (route === "POST /_admin/keys/recover/finish") return await recoverFinish(env, body);
    if (route === "POST /_admin/keys/browser/start") return await browserStart(env, url, body);
    if (route === "POST /_admin/keys/browser/finish") return await browserFinish(request, env, url, owner, body);
    if (route === "POST /_admin/keys/enrol/start") return await enrolStart(env, url, body);
    if (route === "POST /_admin/keys/enrol/finish") return await enrolFinish(request, env, body);
    if (route === "POST /_admin/keys/join/start") return await joinStart(env, url, owner, body);
    if (route === "POST /_admin/keys/join/finish") return await joinFinish(request, env, url, owner, body);
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
  if (await env.DB.prepare("SELECT 1 FROM move_in WHERE id = 1").first()) return json({ error: "You're bringing your identity here from another site. Finish that, or stop it, in Import." }, 409);
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
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO delegations (key, bytes, proof, credential_id, session_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(key, b64url(delegation), JSON.stringify(proof), proof.credential, owner.session_hash ?? null, expires, now()),
    rememberOwn(env, state.id, key, b64url(delegation), proof, expires),
  ]);
  return json({ person: state.id, expires });
}

/**
 * A copy of a delegation of the owner's, kept for good in known_delegations: once the browser key stops signing (signed
 * out, removed, or its 30 days over) its row in `delegations` goes, but readers still need it to check what it signed
 * before, and so does a site the owner moves to. It never lets the key sign here again (items.js lookupsFor).
 */
function rememberOwn(env, person, key, bytes, proof, expires) {
  return env.DB.prepare("INSERT OR REPLACE INTO known_delegations (key, person, bytes, proof, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(key, person, bytes, JSON.stringify(proof), expires);
}

/** Whether the owner has set up signing yet, or is bringing their identity here from another site (move.js). */
export async function hasIdentity(db) {
  return Boolean(await db.prepare("SELECT 1 FROM own_identity WHERE id = 1 UNION ALL SELECT 1 FROM move_in WHERE id = 1 LIMIT 1").first());
}

// --- changing the identity ------------------------------------------------------------------------------------------

/** A passkey's proof from what the browser sent back (auth's credentialJSON) for `statements` under `nonce`. */
export function proofFrom(response, nonce, statements) {
  const r = response?.response ?? {};
  return { credential: String(response?.id ?? ""), nonce, statements,
    response: { authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature, ...(r.userHandle ? { userHandle: r.userHandle } : {}) } };
}

/** The next identity document after `own`'s last: `fields` over what's in effect now. */
async function nextDocument(own, fields) {
  const { current } = own.state;
  return encode({ v: 2, kind: "identity", seq: own.chain.length, prev: await fingerprintOf("identity", own.chain.at(-1).bytes),
    origin: current.origin, passkeys: current.passkeys, recovery: current.recovery, hosting: current.hosting, ...fields });
}

/**
 * Adds `entry` ({bytes, sig}) to the owner's identity if the chain still reads cleanly with it, and only if no one else
 * added one meanwhile. Returns the identity as it reads now, or null.
 */
async function appendDocument(env, own, entry) {
  const fp = await fingerprintOf("identity", entry.bytes);
  const chain = [...own.chain, entry];
  const { results } = await env.DB.prepare("SELECT fp, first_seen FROM identity_seen").all();
  const seen = new Map(results.map((r) => [String(r.fp), Number(r.first_seen)]));
  const at = now();
  const state = await readIdentity(chain, (f) => seen.get(f) ?? at, at);
  if (!state || state.problem) return null;
  const stored = JSON.stringify(chain.map(({ bytes, sig }) => ({ bytes: b64url(bytes), sig })));
  const move = moveOf(state);
  const [updated] = await env.DB.batch([
    env.DB.prepare("UPDATE own_identity SET chain = ? WHERE id = 1 AND json_array_length(chain) = ?").bind(stored, own.chain.length),
    env.DB.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(fp, at),
    // Where the owner is moving (or has moved), kept beside it so friends' calls can be told cheaply (calls.js).
    env.DB.prepare("UPDATE own_identity SET moving_to = ?, moving_at = ? WHERE id = 1 AND json_array_length(chain) = ?")
      .bind(move?.to ?? null, move?.at ?? null, chain.length),
  ]);
  return updated.meta.changes ? state : null;
}

/** The owner's passkeys on this site, as an identity document lists them. */
async function sitePasskeys(env, url, owner) {
  return passkeysOf(env, url, owner);
}

const waiting = (own) => own.state.pending
  ? json({ error: `Your identity is already changing, until ${new Date(own.state.effectiveAt * 1000).toUTCString().slice(0, 16)}. Cancel that first, or wait.` }, 409)
  : null;

async function changeStart(env, url, owner, { change, credential, recovery, request, proof }) {
  const own = await ownIdentity(env.DB);
  if (!own) return json({ error: "Set up signing first." }, 409);
  const { current } = own.state;
  let doc;
  if (change === "cancel") {
    if (!own.state.pending) return json({ error: "Nothing is waiting to change." }, 409);
    if (own.state.pendingByRecovery) return json({ error: "That change was made with your recovery code, so only your recovery code can cancel it." }, 403);
    doc = await nextDocument(own, { cancels: own.state.pendingFp });
  } else {
    const busy = waiting(own);
    if (busy) return busy;
    if (change === "allow") {
      const mine = await sitePasskeys(env, url, owner);
      const added = mine.filter((p) => !current.passkeys.some((c) => c.id === p.id));
      if (!added.length) return json({ error: "Every passkey here already signs for you." }, 409);
      doc = await nextDocument(own, { passkeys: [...current.passkeys, ...added] });
    } else if (change === "remove") {
      const left = current.passkeys.filter((p) => p.id !== credential);
      if (left.length === current.passkeys.length) return json({ error: "That passkey doesn't sign for you." }, 404);
      if (!left.length) return json({ error: "That's the only passkey that signs for you." }, 409);
      doc = await nextDocument(own, { passkeys: left });
    } else if (change === "move") {
      const asked = await moveRequest(env, url, own, request, proof);
      if (typeof asked === "string") return json({ error: asked }, 400);
      // The new site's passkey only: the passkeys here work only at this address, which is being left. Until the move
      // takes effect, any of them can still cancel it (identity.js), as can the recovery code, which moves unchanged.
      doc = await nextDocument(own, { origin: asked.to, hosting: asked.hosting, passkeys: [asked.passkey] });
    } else if (change === "recovery") {
      if (!KEY_RE.test(recovery ?? "") || recovery === current.recovery) return json({ error: "That didn't work. Try again." }, 400);
      doc = await nextDocument(own, { recovery });
    } else {
      return json({ error: "That didn't work. Try again." }, 400);
    }
  }
  const nonce = randomToken();
  return withChallenge(env, "change", nonce, json({ nonce, doc: b64url(doc), allow: current.passkeys.map((p) => p.id) }));
}

async function changeFinish(request, env, { doc: docText, response }) {
  const nonce = await readChallenge(request, env, "change");
  if (!nonce) return json({ error: "That took too long. Try again." }, 400);
  const own = await ownIdentity(env.DB);
  const bytes = typeof docText === "string" ? fromB64url(docText) : null;
  if (!own || !bytes || !parseIdentity(bytes)) return json({ error: "That didn't work. Try again." }, 400);
  const proof = proofFrom(response, nonce, [await fingerprintOf("identity", bytes)]);
  if (!(await spendChallenge(env, nonce))) return json({ error: "That didn't work. Try again." }, 400);
  const state = await appendDocument(env, own, { bytes, sig: { passkey: proof } });
  if (!state) return json({ error: "Your passkey's signature didn't check, or something changed meanwhile. Try again." }, 400);
  return json({ ok: true, effectiveAt: state.effectiveAt });
}

async function recoverStart(env, url, owner, { change }) {
  const own = await ownIdentity(env.DB);
  if (!own) return json({ error: "Set up signing first." }, 409);
  let doc;
  if (change === "cancel") {
    if (!own.state.pending) return json({ error: "Nothing is waiting to change." }, 409);
    doc = await nextDocument(own, { cancels: own.state.pendingFp });
  } else if (change === "devices") {
    const busy = waiting(own);
    if (busy) return busy;
    const mine = await sitePasskeys(env, url, owner);
    const same = mine.length === own.state.current.passkeys.length && mine.every((p) => own.state.current.passkeys.some((c) => c.id === p.id));
    if (!mine.length || same) return json({ error: "The passkeys here already sign for you." }, 409);
    doc = await nextDocument(own, { passkeys: mine });
  } else {
    return json({ error: "That didn't work. Try again." }, 400);
  }
  return json({ doc: b64url(doc) });
}

async function recoverFinish(env, { doc: docText, signature }) {
  const own = await ownIdentity(env.DB);
  const bytes = typeof docText === "string" ? fromB64url(docText) : null;
  if (!own || !bytes || !parseIdentity(bytes) || typeof signature !== "string") return json({ error: "That didn't work. Try again." }, 400);
  const state = await appendDocument(env, own, { bytes, sig: { recovery: signature } });
  if (!state) return json({ error: "That isn't your recovery code, or something changed meanwhile." }, 400);
  return json({ ok: true, effectiveAt: state.effectiveAt });
}

// --- a browser here that can't sign yet --------------------------------------------------------------------------------

async function browserStart(env, url, { browserKey }) {
  const own = await ownIdentity(env.DB);
  const delegation = own && (await loginDelegation(env, url, browserKey));
  // Only passkeys that work here (they're tied to an address) and sign for the owner now.
  const allow = own ? own.state.current.passkeys.filter((p) => p.origin === url.origin).map((p) => p.id) : [];
  if (!delegation || !allow.length) return json({ error: "No passkey here signs for you yet. Let one from Your devices." }, 409);
  const nonce = randomToken();
  return withChallenge(env, "browser", nonce, json({ nonce, delegation: b64url(delegation), allow }));
}

async function browserFinish(request, env, url, owner, { delegation: text, response }) {
  const nonce = await readChallenge(request, env, "browser");
  const bytes = await sentDelegation(env, url, text);
  if (!nonce || !bytes) return json({ error: "That didn't work. Try again." }, 400);
  const proof = proofFrom(response, nonce, [await fingerprintOf("delegation", bytes)]);
  if (!(await spendChallenge(env, nonce))) return json({ error: "That didn't work. Try again." }, 400);
  const kept = await keepDelegation(env, { bytes, proof, credentialId: proof.credential, sessionHash: owner.session_hash ?? null });
  return kept ? json(kept) : json({ error: "Your passkey's signature didn't check. Try again." }, 400);
}

// --- moving to a new address ---------------------------------------------------------------------------------------

const MOVE_REQUEST_SECONDS = 86400;
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * A move request a new site's page sent the owner here with (move.js makes it): {v: 2, kind: "move", from, to, hosting,
 * passkey: {id, key, origin}, at}, signed by that passkey. Returns {to, hosting, passkey} if it's a move from here this
 * site would sign; otherwise what's wrong, to show. The new site's own passkey must have signed it, so a new host can't
 * slip in a key of its own for the owner to agree to without noticing.
 */
async function moveRequest(env, url, own, text, proof) {
  const bytes = typeof text === "string" && text.length < 4096 ? fromB64url(text) : null;
  const r = bytes && decode(bytes);
  if (!r || r.v !== 2 || r.kind !== "move" || r.from !== url.origin) return "That isn't a request to move this site.";
  const to = siteOrigin(r.to, env);
  if (!to || to !== r.to || to === url.origin) return "That request doesn't say where to move to.";
  const p = r.passkey;
  if (!KEY_RE.test(r.hosting ?? "") || r.hosting === own.state.current.hosting || !p || !CREDENTIAL_RE.test(p.id ?? "")
    || typeof p.key !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(p.key) || p.origin !== to) return "That request isn't one afterwrd makes.";
  if (!Number.isSafeInteger(r.at) || Math.abs(now() - r.at) > MOVE_REQUEST_SECONDS) return "That request is too old. Ask again from your new site.";
  const passkey = { id: p.id, key: p.key, origin: to };
  if (!(await checkPasskeyProof(proof, passkey, await fingerprintOf("move", bytes)))) return "Your new site's passkey didn't sign that request.";
  return { to, hosting: r.hosting, passkey };
}

/** POST /_admin/keys/move/check {request, proof}: whether the page may offer to sign this move. */
async function moveCheck(env, url, { request, proof }) {
  const own = await ownIdentity(env.DB);
  if (!own) return json({ error: "Your identity isn't set up on this site, so there's nothing to move. Bring everything over with Download everything instead." }, 409);
  const busy = waiting(own);
  if (busy) return busy;
  const asked = await moveRequest(env, url, own, request, proof);
  return typeof asked === "string" ? json({ error: asked }, 400) : json({ to: asked.to });
}

/**
 * Where the owner is moving, or has moved, as this site keeps it: {to, at, done} (done: it's in effect, so this site
 * only says where they've gone); null if they aren't. Cheap: one row.
 * @param {D1Database} db @param {string} origin this site's address
 */
export async function ownMove(db, origin) {
  const row = await db.prepare("SELECT moving_to, moving_at FROM own_identity WHERE id = 1").first();
  if (!row?.moving_to || row.moving_to === origin) return null;
  return { to: String(row.moving_to), at: Number(row.moving_at), done: Number(row.moving_at) <= now() };
}

// --- a new device that signs straight away --------------------------------------------------------------------------

const TOKEN_RE = /\/_auth\/device\/([\w-]{20,100})$/;

async function enrolStart(env, url, { link }) {
  const own = await ownIdentity(env.DB);
  const token = TOKEN_RE.exec(typeof link === "string" ? link : "")?.[1];
  if (!own || !token) return json({ error: "That didn't work. Try again." }, 400);
  const busy = waiting(own);
  if (busy) return busy;
  const found = await env.DB.prepare("SELECT 1 FROM device_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), now()).first();
  if (!found) return json({ error: "That link has expired or been used." }, 404);
  const statement = encode({ v: 2, kind: "enrol", person: own.person, token: b64url(await sha256(utf8(token))) });
  const nonce = randomToken();
  return withChallenge(env, "enrol", nonce, json({ nonce, statement: b64url(statement), allow: own.state.current.passkeys.map((p) => p.id) }));
}

async function enrolFinish(request, env, { statement: text, response }) {
  const nonce = await readChallenge(request, env, "enrol");
  const own = await ownIdentity(env.DB);
  const statement = typeof text === "string" ? fromB64url(text) : null;
  const enrol = statement && decode(statement);
  if (!nonce || !own || !enrol || enrol.kind !== "enrol" || enrol.person !== own.person || typeof enrol.token !== "string") {
    return json({ error: "That didn't work. Try again." }, 400);
  }
  const proof = proofFrom(response, nonce, [await fingerprintOf("enrol", statement)]);
  const passkey = own.state.current.passkeys.find((p) => p.id === proof.credential);
  if (!passkey || !(await checkPasskeyProof(proof, passkey, proof.statements[0])) || !(await spendChallenge(env, nonce))) {
    return json({ error: "Your passkey's signature didn't check. Try again." }, 400);
  }
  // The statement names the token by its SHA-256 in base64url; the link is kept by the same hash in hex.
  const hex = [...(fromB64url(enrol.token) ?? [])].map((b) => b.toString(16).padStart(2, "0")).join("");
  const done = await env.DB.prepare("UPDATE device_links SET enrolment = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(JSON.stringify({ statement: text, proof }), hex).run();
  return done.meta.changes ? json({ ok: true }) : json({ error: "That link has expired or been used." }, 404);
}

/** The enrolment the passkey this device signed in with came with, if it hasn't joined yet. */
async function enrolmentOf(env, owner) {
  if (!owner.session_credential) return null;
  const row = await env.DB.prepare("SELECT id, public_key, enrolment FROM credentials WHERE id = ? AND user_id = ? AND enrolment IS NOT NULL")
    .bind(owner.session_credential, owner.id).first();
  try { return row ? { id: String(row.id), key: String(row.public_key), enrolment: JSON.parse(String(row.enrolment)) } : null; } catch { return null; }
}

async function joinStart(env, url, owner, { browserKey }) {
  const own = await ownIdentity(env.DB);
  const mine = await enrolmentOf(env, owner);
  if (!own || !mine || !KEY_RE.test(browserKey ?? "")) return json({ error: "This device can't be added that way. Let it sign from a device that already does." }, 409);
  const busy = waiting(own);
  if (busy) return busy;
  if (own.state.current.passkeys.some((p) => p.id === mine.id)) return json({ error: "This device already signs for you." }, 409);
  const doc = await nextDocument(own, { passkeys: [...own.state.current.passkeys, { id: mine.id, key: mine.key, origin: url.origin }] });
  const delegation = encode({ v: 2, kind: "delegation", person: own.person, key: browserKey, origin: url.origin, expires: now() + DELEGATION_SECONDS });
  const nonce = randomToken();
  return withChallenge(env, "join", nonce, json({ nonce, doc: b64url(doc), delegation: b64url(delegation), allow: [mine.id] }));
}

async function joinFinish(request, env, url, owner, { doc: docText, delegation: delegationText, token, response }) {
  const nonce = await readChallenge(request, env, "join");
  const own = await ownIdentity(env.DB);
  const mine = await enrolmentOf(env, owner);
  const bytes = typeof docText === "string" ? fromB64url(docText) : null;
  const delegation = typeof delegationText === "string" ? fromB64url(delegationText) : null;
  if (!nonce || !own || !mine || !bytes || !delegation || typeof token !== "string") return json({ error: "That didn't work. Try again." }, 400);
  const statements = [await fingerprintOf("identity", bytes), await fingerprintOf("delegation", delegation)];
  const proof = proofFrom(response, nonce, statements);
  if (proof.credential !== mine.id || !(await spendChallenge(env, nonce))) return json({ error: "That didn't work. Try again." }, 400);
  const state = await appendDocument(env, own, { bytes, sig: { enrolment: { ...mine.enrolment, token }, passkey: proof } });
  const key = state && (await checkDelegation(delegation, proof, state, now()));
  if (!state || !key) return json({ error: "That didn't check. Let this device sign from one that already does." }, 400);
  const { expires } = decode(delegation);
  await env.DB.batch([
    env.DB.prepare("UPDATE credentials SET enrolment = NULL WHERE id = ?").bind(mine.id),
    env.DB.prepare(`INSERT OR REPLACE INTO delegations (key, bytes, proof, credential_id, session_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(key, b64url(delegation), JSON.stringify(proof), mine.id, owner.session_hash ?? null, expires, now()),
    rememberOwn(env, own.person, key, b64url(delegation), proof, expires),
  ]);
  return json({ person: own.person, expires });
}

// --- for pages ------------------------------------------------------------------------------------------------------

/**
 * The owner's identity for Your devices and Home: which passkeys sign for them, and any change waiting (what it does,
 * when it takes effect, and whether only the recovery code can cancel it). null before signing is set up.
 */
export async function identitySummary(db) {
  const own = await ownIdentity(db);
  if (!own) return null;
  const { current, pending, effectiveAt, pendingByRecovery } = own.state;
  const ids = (d) => d.passkeys.map((p) => p.id);
  return {
    signing: ids(current),
    pending: pending && {
      added: ids(pending).filter((id) => !ids(current).includes(id)),
      removed: ids(current).filter((id) => !ids(pending).includes(id)),
      recovery: pending.recovery !== current.recovery,
      moving: pending.origin !== current.origin ? pending.origin : null,
      byRecovery: pendingByRecovery,
      at: effectiveAt,
    },
  };
}

// --- the owner's profile --------------------------------------------------------------------------------------------

const PROFILE_SECONDS = 600;

/** POST /_admin/keys/profile {bytes, key, signature}: a browser signed the owner's profile with its key. */
async function keepProfile(env, owner, { bytes: text, key, signature }) {
  const own = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  const bytes = typeof text === "string" ? fromB64url(text) : null;
  const profile = bytes && decode(bytes);
  if (!own || !profile || profile.v !== 2 || profile.kind !== "profile" || profile.person !== own.person || profile.name !== owner.name
    || !Number.isSafeInteger(profile.at) || Math.abs(profile.at - now()) > PROFILE_SECONDS || !KEY_RE.test(key ?? "")) {
    return json({ error: "That didn't work." }, 400);
  }
  // Only a browser key that signs for the owner here now, and its own signature.
  const allowed = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ? AND expires_at > ?").bind(key, now()).first();
  if (!allowed || !(await checkAs("profile", key, bytes, String(signature ?? "")))) return json({ error: "That didn't work." }, 400);
  await env.DB.prepare("UPDATE own_identity SET profile = ? WHERE id = 1").bind(JSON.stringify({ bytes: text, key, signature,
    delegation: { bytes: String(allowed.bytes), proof: JSON.parse(String(allowed.proof)) } })).run();
  return json({ ok: true });
}
