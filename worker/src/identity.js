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
//   at once      if it only adds passkeys or replaces the hosting key, signed by a current passkey (or, for a new
//                device, by that device's passkey with an enrolment a current passkey signed: see checkEnrolment)
//   after 7 days anything else (removing a passkey, a new recovery key, a new address, closing) or anything signed with
//                the recovery key. The 7 days run from when the reader FIRST SAW the change, never from a time written
//                in it, so backdating can't skip them. Meanwhile it's "pending", and a cancel (the document before it,
//                again) puts things back. A change made with a passkey can be cancelled by any passkey from before it or
//                the recovery key; one made with the recovery key only by the recovery key. So someone who has stolen a
//                passkey can't stop the owner using their recovery code to remove it.
//
// A passkey signs by signing a WebAuthn challenge made from a list of fingerprints (statementsChallenge in signed.js),
// so one prompt can sign an identity document and a browser key's delegation together. Its proof:
//   {credential, nonce, statements: [fingerprint…], response: {authenticatorData, clientDataJSON, signature, userHandle?}}
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { checkAs, decode, fingerprintOf, fromB64url, sha256, b64url, statementsChallenge, utf8 } from "../public/static/signed.js";

export const SLOW_SECONDS = 7 * 86400;
const FP_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // an Ed25519 public key, 32 bytes
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PASSKEYS = 20;
export const MAX_DOCUMENT = 4096;

/** @typedef {{ id: string, key: string, origin: string }} Passkey */
/** @typedef {{ v: 2, kind: "identity", seq: number, prev: string | null, origin: string, passkeys: Passkey[], recovery: string, hosting: string, closed?: true, cancels?: string }} IdentityDoc */
/** @typedef {{ credential: string, nonce: string, statements: string[], response: { authenticatorData: string, clientDataJSON: string, signature: string, userHandle?: string } }} PasskeyProof */
/** @typedef {{ passkey?: PasskeyProof, recovery?: string, enrolment?: { statement: string, proof: PasskeyProof, token: string } }} Signature */
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
  if (!isOrigin(d.origin) || !KEY_RE.test(d.recovery ?? "") || !KEY_RE.test(d.hosting ?? "")) return null;
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
    const { verified } = await verifyAuthenticationResponse({
      response: { id: passkey.id, rawId: passkey.id, type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature, userHandle: r.userHandle } },
      expectedChallenge: await statementsChallenge(proof.nonce, proof.statements),
      expectedOrigin: passkey.origin,
      expectedRPID: new URL(passkey.origin).hostname,
      requireUserVerification: true,
      credential: { id: passkey.id, publicKey: key, counter: 0 },
    });
    return verified;
  } catch { return false; }
}

/** The passkey in `doc` that signed `statement` with `proof`, or null. */
async function signedByPasskeyOf(doc, proof, statement) {
  const passkey = doc.passkeys.find((p) => p.id === proof?.credential);
  return passkey && (await checkPasskeyProof(proof, passkey, statement)) ? passkey : null;
}

/**
 * A new device's passkey added through a device link: a current passkey signed an enrolment ({kind: "enrol", person,
 * token: SHA-256 of a one-time token}) when the link was made, and the new passkey signs the document adding itself,
 * which carries the token. So nobody can add a passkey without both a current passkey's say-so and the link.
 */
async function checkEnrolment(person, before, after, sig, docFp) {
  const e = sig.enrolment;
  if (!e || typeof e.statement !== "string" || typeof e.token !== "string" || e.token.length > 128) return false;
  const statement = fromB64url(e.statement);
  const enrol = statement && decode(statement);
  if (!enrol || enrol.v !== 2 || enrol.kind !== "enrol" || enrol.person !== person) return false;
  if (enrol.token !== b64url(await sha256(utf8(e.token)))) return false;
  if (!(await signedByPasskeyOf(before, e.proof, await fingerprintOf("enrol", statement)))) return false;
  // Exactly one passkey added, nothing else changed, and the new passkey is what signed the document.
  const added = after.passkeys.filter((p) => !before.passkeys.some((b) => b.id === p.id));
  if (added.length !== 1 || classify(before, after) !== "fast") return false;
  return checkPasskeyProof(sig.passkey, added[0], docFp);
}

const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const content = (d) => ({ origin: d.origin, passkeys: d.passkeys, recovery: d.recovery, hosting: d.hosting, closed: d.closed ?? false });

/** "fast" (only passkeys added and/or a new hosting key) or "slow" (anything else). */
function classify(before, after) {
  const removed = before.passkeys.some((b) => !after.passkeys.some((p) => p.id === b.id && sameKeys(p, b)));
  if (removed || after.recovery !== before.recovery || after.origin !== before.origin || after.closed) return "slow";
  return "fast";
}

/**
 * Reads a person's chain of identity documents, as one reader sees it. `firstSeen(fingerprint)` is when this reader
 * first saw a document (seconds); `at` is now. Returns their id, the document in effect, any change still waiting and
 * when it takes effect, and `problem` if the chain stops being believable (everything up to there still counts).
 * @param {SignedDoc[]} chain @param {(fp: string) => number} firstSeen @param {number} at
 */
export async function readIdentity(chain, firstSeen, at) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const genesis = parseIdentity(chain[0]?.bytes);
  const genesisFp = genesis && (await fingerprintOf("identity", chain[0].bytes));
  // The first document is signed by one of its own passkeys.
  if (!genesis || genesis.seq !== 0 || genesis.cancels || genesis.closed || !(await signedByPasskeyOf(genesis, chain[0].sig?.passkey, genesisFp))) return null;
  const state = { id: genesisFp, current: genesis, currentFp: genesisFp, pending: null, pendingFp: null, pendingByRecovery: false, effectiveAt: null, problem: null };
  // A change that has waited its 7 days takes effect: judged at `when`, which for the next document in the chain is
  // when this reader first saw that one (a cancel seen in time still cancels, however late the chain is read).
  const settle = (when) => {
    if (!state.pending || when < state.effectiveAt) return;
    state.current = state.pending; state.currentFp = state.pendingFp;
    state.pending = state.pendingFp = state.effectiveAt = null; state.pendingByRecovery = false;
  };
  let prevFp = genesisFp;
  for (let i = 1; i < chain.length; i++) {
    const { bytes, sig } = chain[i] ?? {};
    const doc = parseIdentity(bytes);
    const fp = doc && (await fingerprintOf("identity", bytes));
    if (!doc || doc.seq !== i || doc.prev !== prevFp) { state.problem = "broken"; break; }
    settle(Math.min(at, firstSeen(fp)));
    if (state.current.closed) { state.problem = "closed"; break; }
    const before = state.current;
    const byRecovery = typeof sig?.recovery === "string" && (await checkAs("identity", before.recovery, bytes, sig.recovery));
    const byPasskey = !byRecovery && sig?.passkey && !sig.enrolment && (await signedByPasskeyOf(before, sig.passkey, fp));
    if (state.pending) {
      // While a change waits, the only thing that counts is cancelling it: the document before it, again.
      const allowed = state.pendingByRecovery ? byRecovery : byRecovery || byPasskey;
      if (doc.cancels !== state.pendingFp || !sameKeys(content(doc), content(before)) || !allowed) { state.problem = "unexpected"; break; }
      state.pending = state.pendingFp = state.effectiveAt = null; state.pendingByRecovery = false;
      state.current = doc; state.currentFp = fp; prevFp = fp;
      continue;
    }
    if (doc.cancels) { state.problem = "unexpected"; break; }
    const kind = classify(before, doc);
    const enrolled = !byRecovery && !byPasskey && sig?.enrolment && (await checkEnrolment(state.id, before, doc, sig, fp));
    if (!(byRecovery || byPasskey || enrolled)) { state.problem = "unsigned"; break; }
    if (kind === "fast" && !byRecovery) { state.current = doc; state.currentFp = fp; }
    else { state.pending = doc; state.pendingFp = fp; state.pendingByRecovery = byRecovery; state.effectiveAt = firstSeen(fp) + SLOW_SECONDS; }
    prevFp = fp;
  }
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
  return (await signedByPasskeyOf(state.current, proof, await fingerprintOf("delegation", bytes))) ? d.key : null;
}
