// Identities for afterwrd 2 (docs/signed-conversations.md, section 1): checking who signed something, without trusting
// whoever passed it along. Pure checks: callers fetch, store and remember when they first saw each document.
//
// A person is a chain of identity documents. The first one's fingerprint is their id, for good. Each document lists:
//   passkeys   [{id, key, origin}]  the owner's passkeys: credential id, COSE public key (base64url) and the site
//                                   address it was made at (passkeys only work at the address they were made at)
//   recovery   an Ed25519 public key, worked out from the recovery code the owner keeps off the site
//   hosting    the site's own Ed25519 key: signs list heads, receipts and calls, never anything as the owner
//   origin     the site's address now
// and `seq` (0, 1, 2…) and `prev` (the fingerprint of the one before; null for the first).
//
// A change takes effect:
//   at once      if it only adds passkeys or replaces the hosting key, signed by a current passkey (a new device's
//                passkey starts signing when a device that already signs lets it)
//   after 7 days anything else (removing a passkey, a new recovery key, a new address, closing) or anything signed with
//                the recovery key. The 7 days run from when the reader FIRST SAW the change, never from a time written
//                in it, so backdating can't skip them. Meanwhile it's "pending", and a cancel (the document before it,
//                again) puts things back. A change made with a passkey can be cancelled by any passkey from before it or
//                the recovery key; one made with the recovery key only by the recovery key. So someone who has stolen a
//                passkey can't stop the owner using their recovery code to remove it.
//
// A group (afterwrd 2, step 6) has no devices of its own: its identity documents list no passkeys and no recovery key,
// but name its `owner` (the person who made it), whose passkeys (as their identity has them) or recovery key sign it and
// every change to it, under the same rules. The owner never changes. A reader checks a group's chain with its owner's
// identity beside it (readIdentity's `owner`).
//
// A passkey signs by signing a WebAuthn challenge made from a list of fingerprints (statementsChallenge in signed.js),
// so one prompt can sign an identity document and a browser key's delegation together. Its proof:
//   {credential, nonce, statements: [fingerprint…], response: {authenticatorData, clientDataJSON, signature, userHandle?}}
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { checkAs, decode, fingerprintOf, fromB64url, statementsChallenge } from "../public/static/signed.js";

export let SLOW_SECONDS = 7 * 86400;
/** Local test sites only (app.js, with ALLOW_LOCAL_SITES and TEST_SLOW_SECONDS): a shorter wait, so a test can see one end. */
export function testSlowSeconds(seconds) {
  if (Number.isSafeInteger(seconds) && seconds > 0) SLOW_SECONDS = seconds;
}
const FP_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // an Ed25519 public key, 32 bytes
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PASSKEYS = 20;
export const MAX_DOCUMENT = 4096;

/** @typedef {{ id: string, key: string, origin: string }} Passkey */
/** @typedef {{ v: 2, kind: "identity", seq: number, prev: string | null, origin: string, passkeys: Passkey[], recovery?: string, hosting: string, owner?: string, closed?: true, cancels?: string }} IdentityDoc */
/** @typedef {{ credential: string, nonce: string, statements: string[], response: { authenticatorData: string, clientDataJSON: string, signature: string, userHandle?: string } }} PasskeyProof */
/** @typedef {{ passkey?: PasskeyProof, recovery?: string }} Signature */
/** @typedef {{ bytes: Uint8Array, sig: Signature }} SignedDoc */

const isOrigin = (o) => {
  try { const u = new URL(o); return u.origin === o && (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1"); }
  catch { return false; }
};

/** The document in `bytes` if it's a well-formed identity document; null if not. @returns {IdentityDoc | null} */
export function parseIdentity(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_DOCUMENT) return null;
  const d = decode(bytes);
  if (!d || d.v !== 2 || d.kind !== "identity" || !Number.isSafeInteger(d.seq) || d.seq < 0) return null;
  if (d.seq === 0 ? d.prev !== null : !FP_RE.test(d.prev ?? "")) return null;
  if (!isOrigin(d.origin) || !KEY_RE.test(d.hosting ?? "")) return null;
  if (d.owner !== undefined) {
    // A group's: its owner signs for it, so it has no passkeys or recovery key of its own.
    if (!FP_RE.test(d.owner) || !Array.isArray(d.passkeys) || d.passkeys.length || d.recovery !== undefined) return null;
    return d.closed !== undefined && d.closed !== true ? null : d.cancels !== undefined && !FP_RE.test(d.cancels) ? null : d;
  }
  if (!KEY_RE.test(d.recovery ?? "")) return null;
  if (!Array.isArray(d.passkeys) || !d.passkeys.length || d.passkeys.length > MAX_PASSKEYS) return null;
  const ids = new Set();
  for (const p of d.passkeys) {
    if (!p || !B64URL_RE.test(p.id ?? "") || p.id.length > 512 || ids.has(p.id) || !B64URL_RE.test(p.key ?? "") || p.key.length > 1024 || !isOrigin(p.origin)) return null;
    ids.add(p.id);
  }
  if (d.closed !== undefined && d.closed !== true) return null;
  if (d.cancels !== undefined && !FP_RE.test(d.cancels)) return null;
  return d;
}

/**
 * Whether `proof` is the passkey `passkey`'s signature of the statement with fingerprint `statement`. Never throws.
 * @param {PasskeyProof} proof @param {Passkey} passkey @param {string} statement
 */
export async function checkPasskeyProof(proof, passkey, statement) {
  try {
    if (!proof || proof.credential !== passkey.id || !Array.isArray(proof.statements) || !proof.statements.includes(statement)) return false;
    const r = /** @type {Partial<PasskeyProof["response"]>} */ (proof.response ?? {});
    if (![r.authenticatorData, r.clientDataJSON, r.signature].every((x) => typeof x === "string" && B64URL_RE.test(x))) return false;
    const key = fromB64url(passkey.key);
    if (!key) return false;
    // Only from a page of the passkey's own site, never one framed inside another site's (the WebAuthn library checks
    // this only when it's told the outer page).
    const client = decode(fromB64url(r.clientDataJSON));
    if (!client || client.crossOrigin === true || client.topOrigin !== undefined) return false;
    // The same proof of the same passkey always checks the same way, so each is checked once (a thread page by five
    // people carries five delegations fifty times: step 9c measured the WebAuthn check as most of its CPU).
    const memo = [passkey.id, passkey.key, passkey.origin, proof.nonce, proof.statements.join(","), r.authenticatorData, r.clientDataJSON, r.signature].join("\n");
    const known = proven.get(memo);
    if (known !== undefined) return known;
    const { verified } = await verifyAuthenticationResponse({
      response: { id: passkey.id, rawId: passkey.id, type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature, userHandle: r.userHandle } },
      expectedChallenge: await statementsChallenge(proof.nonce, proof.statements),
      expectedOrigin: passkey.origin,
      expectedRPID: new URL(passkey.origin).hostname,
      requireUserVerification: true,
      credential: { id: passkey.id, publicKey: key, counter: 0 },
    });
    if (proven.size >= PROVEN_MAX) proven.delete(proven.keys().next().value);
    proven.set(memo, verified);
    return verified;
  } catch { return false; }
}
// Passkey proofs already checked in this isolate, and their answers (oldest forgotten first).
const proven = new Map();
const PROVEN_MAX = 5000;

/** The passkey in `doc` that signed `statement` with `proof`, or null. */
async function signedByPasskeyOf(doc, proof, statement) {
  const passkey = doc.passkeys.find((p) => p.id === proof?.credential);
  return passkey && (await checkPasskeyProof(proof, passkey, statement)) ? passkey : null;
}

const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const content = (d) => ({ origin: d.origin, passkeys: d.passkeys, recovery: d.recovery ?? null, hosting: d.hosting, owner: d.owner ?? null, closed: d.closed ?? false });

/** "fast" (only passkeys added and/or a new hosting key) or "slow" (anything else). */
function classify(before, after) {
  const removed = before.passkeys.some((b) => !after.passkeys.some((p) => p.id === b.id && sameKeys(p, b)));
  if (removed || after.recovery !== before.recovery || after.origin !== before.origin || after.closed) return "slow";
  return "fast";
}

/** The person who owns the group whose chain this is (its first document's `owner`), or null for a person's own chain. */
export function ownerOf(chain) {
  const first = Array.isArray(chain) && chain[0]?.bytes instanceof Uint8Array ? parseIdentity(chain[0].bytes) : null;
  return first?.owner ?? null;
}

/**
 * Reads a person's chain of identity documents, as one reader sees it. `firstSeen(fingerprint)` is when this reader
 * first saw a document (seconds); `at` is now. Returns their id, the document in effect, any change still waiting and
 * when it takes effect, and `problem` if the chain stops being believable (everything up to there still counts).
 * A group's chain needs its `owner`'s identity, as this reader reads it (readIdentity's own answer for them).
 * @param {SignedDoc[]} chain @param {(fp: string) => number} firstSeen @param {number} at
 * @param {{ owner?: any }} [options]
 */
export async function readIdentity(chain, firstSeen, at, { owner = null } = {}) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const genesis = parseIdentity(chain[0]?.bytes);
  const genesisFp = genesis && (await fingerprintOf("identity", chain[0].bytes));
  const group = Boolean(genesis?.owner);
  // A group's owner is a person (not another group) whose identity this reader can read.
  if (group && (!owner || owner.id !== genesis.owner || owner.problem === "closed" || owner.frozen || owner.current.owner)) return null;
  // A group's documents are signed by a passkey of its owner's (as their identity had it when this reader first saw the
  // document, or has it now), or with their recovery key.
  const byOwnerPasskey = async (proof, fp) => {
    const then = documentAt(owner, firstSeen(fp));
    return Boolean((await signedByPasskeyOf(then, proof, fp)) || (then !== owner.current && (await signedByPasskeyOf(owner.current, proof, fp))));
  };
  // The first document is signed by one of its own passkeys (a group's: by its owner).
  if (!genesis || genesis.seq !== 0 || genesis.cancels || genesis.closed) return null;
  if (!(group ? await byOwnerPasskey(chain[0].sig?.passkey, genesisFp) : await signedByPasskeyOf(genesis, chain[0].sig?.passkey, genesisFp))) return null;
  // history: each document that came into effect, and from when (by this reader's clock), so something signed in the
  // past is checked against the identity as it was then (documentAt), not as it is now.
  const state = { id: genesisFp, current: genesis, currentFp: genesisFp, pending: null, pendingFp: null, pendingByRecovery: false, effectiveAt: null, problem: null,
    history: [{ doc: genesis, from: 0 }] };
  // A change that has waited its 7 days takes effect: judged at `when`, which for the next document in the chain is
  // when this reader first saw that one (a cancel seen in time still cancels, however late the chain is read).
  const settle = (when) => {
    if (!state.pending || when < state.effectiveAt) return;
    state.history.push({ doc: state.pending, from: state.effectiveAt });
    state.current = state.pending; state.currentFp = state.pendingFp;
    state.pending = state.pendingFp = state.effectiveAt = null; state.pendingByRecovery = false;
  };
  let prevFp = genesisFp;
  // How many documents read cleanly: the whole chain, or those before the one with the problem.
  state.clean = chain.length;
  for (let i = 1; i < chain.length; i++) {
    state.clean = i;
    const { bytes, sig } = chain[i] ?? {};
    const doc = parseIdentity(bytes);
    const fp = doc && (await fingerprintOf("identity", bytes));
    if (!doc || doc.seq !== i || doc.prev !== prevFp || (doc.owner ?? null) !== (genesis.owner ?? null)) { state.problem = "broken"; break; }
    settle(Math.min(at, firstSeen(fp)));
    if (state.current.closed) { state.problem = "closed"; break; }
    const before = state.current;
    const recoveryKey = group ? owner.current.recovery : before.recovery;
    const byRecovery = typeof sig?.recovery === "string" && (await checkAs("identity", recoveryKey, bytes, sig.recovery));
    const byPasskey = !byRecovery && sig?.passkey
      && (group ? await byOwnerPasskey(sig.passkey, fp) : await signedByPasskeyOf(before, sig.passkey, fp));
    if (state.pending) {
      // While a change waits, the only thing that counts is cancelling it: the document before it, again.
      const allowed = state.pendingByRecovery ? byRecovery : byRecovery || byPasskey;
      if (doc.cancels !== state.pendingFp || !sameKeys(content(doc), content(before)) || !allowed) { state.problem = "unexpected"; break; }
      state.pending = state.pendingFp = state.effectiveAt = null; state.pendingByRecovery = false;
      state.current = doc; state.currentFp = fp; prevFp = fp;
      state.history.push({ doc, from: firstSeen(fp) });
      continue;
    }
    if (doc.cancels) { state.problem = "unexpected"; break; }
    const kind = classify(before, doc);
    if (!(byRecovery || byPasskey)) { state.problem = "unsigned"; break; }
    // Adding passkeys (or a new hosting key) counts from when the document before it did: what those keys signed is the
    // owner's whenever a reader first meets it. Otherwise a reader who learnt the identity today (a new friend, a site
    // taking a move) would refuse yesterday's comment from the owner's second phone. Honest hosts' "taken at" times
    // are never before the key existed, so this lets nothing in that a reader who'd watched all along would refuse.
    if (kind === "fast" && !byRecovery) { state.current = doc; state.currentFp = fp; state.history.push({ doc, from: state.history.at(-1).from }); }
    else { state.pending = doc; state.pendingFp = fp; state.pendingByRecovery = byRecovery; state.effectiveAt = firstSeen(fp) + SLOW_SECONDS; }
    prevFp = fp;
  }
  if (!state.problem) state.clean = chain.length;
  settle(at);
  return state;
}

/**
 * Whether two chains for the same person disagree: different documents at the same place. Then the identity is frozen
 * (someone holding one of its keys is fighting the owner) and friends are told; nothing signed with it is trusted until
 * the owner sorts it out.
 * @param {SignedDoc[]} a @param {SignedDoc[]} b
 */
export async function forked(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if ((await fingerprintOf("identity", a[i].bytes)) !== (await fingerprintOf("identity", b[i].bytes))) return true;
  }
  return false;
}

/** The identity document that was in effect at `at` (seconds), by this reader's clock. */
export function documentAt(state, at) {
  let doc = state.history[0].doc;
  for (const h of state.history) if (h.from <= at) doc = h.doc;
  return doc;
}

/**
 * A browser key's delegation: {v: 2, kind: "delegation", person, key, origin, expires}, signed by one of the person's
 * current passkeys at sign-in. Returns the browser key (base64url) if it may sign for `state`'s person at time `at`;
 * null if not.
 * @param {Uint8Array} bytes @param {PasskeyProof} proof @param {Awaited<ReturnType<typeof readIdentity>>} state @param {number} at
 */
export async function checkDelegation(bytes, proof, state, at) {
  if (!state || !(bytes instanceof Uint8Array) || bytes.length > 1024) return null;
  const d = decode(bytes);
  if (!d || d.v !== 2 || d.kind !== "delegation" || d.person !== state.id || !KEY_RE.test(d.key ?? "") || !isOrigin(d.origin)
    || !Number.isSafeInteger(d.expires)) return null;
  if (at > d.expires) return null;
  // Checked against the identity as it was at `at`: a passkey removed since still vouches for what it allowed before
  // (a comment from an old laptop stays Bob's), and one removed already vouches for nothing after. A passkey that
  // signs for them now vouches too: after a move, the new site's passkey signs from when that site took over, which
  // a reader that heard of the move later than others would otherwise date a little after.
  const statement = await fingerprintOf("delegation", bytes);
  const then = documentAt(state, at);
  const signed = (await signedByPasskeyOf(then, proof, statement)) || (then !== state.current && (await signedByPasskeyOf(state.current, proof, statement)));
  return signed ? d.key : null;
}

/**
 * Where `state`'s person is moving, or has moved: {to, at} for the newest change of address, waiting (at: when it takes
 * effect, by this reader's clock) or done (at: when it did); null if their address has never changed.
 */
export function moveOf(state) {
  if (!state) return null;
  if (state.pending && state.pending.origin !== state.current.origin) return { to: state.pending.origin, at: state.effectiveAt, waiting: true };
  for (let i = state.history.length - 1; i > 0; i--) {
    if (state.history[i].doc.origin !== state.history[i - 1].doc.origin) return { to: state.history[i].doc.origin, at: state.history[i].from, waiting: false };
  }
  return null;
}
