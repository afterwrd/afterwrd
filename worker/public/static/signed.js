// Signing for afterwrd 2 (docs/signed-conversations.md), shared by the browser and the Worker. The browser signs the
// owner's records with its browser key (made at sign-in, never leaving the browser); the Worker checks everything that
// arrives, and signs as host with the site's hosting key. Nothing here touches the network or storage.
//
// Rules every caller relies on:
// - What's signed is exact bytes (UTF-8 JSON made once by the signer), stored and passed on as received, never rebuilt.
// - Every signature covers "afterwrd <kind> 2\n" followed by those bytes, so a signature for one kind of thing can never
//   be passed off as another (a record as a head, a head as a delegation…).
// - A fingerprint is SHA-256, written in base64url (43 characters).
// - Checks never throw: anything malformed is simply "doesn't check".

export const PROTOCOL = 2;
export const KINDS = /** @type {const} */ (["record", "head", "delegation", "identity", "profile", "statements", "recovery", "enrol", "request", "audience", "move"]);
const ED25519 = { name: "Ed25519" };
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// --- bytes -------------------------------------------------------------------------------------------------------

/** @param {Uint8Array | ArrayBuffer} bytes */
export function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text @returns {Uint8Array<ArrayBuffer> | null} null if it isn't base64url */
export function fromB64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** @param {string} text */
export const utf8 = (text) => enc.encode(text);

/** @param {...Uint8Array} parts */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The exact bytes to sign for a JSON value: made once, by the signer. @param {unknown} value */
export const encode = (value) => utf8(JSON.stringify(value));

/** Signed bytes back to a value; null if they aren't UTF-8 JSON. @param {Uint8Array} bytes */
export function decode(bytes) {
  try { return JSON.parse(dec.decode(bytes)); } catch { return null; }
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {Uint8Array<ArrayBuffer>} */ (bytes)));
}

/** @param {Uint8Array} bytes */
export const fingerprint = async (bytes) => b64url(await sha256(bytes));

/** "afterwrd <kind> 2\n" + bytes: what a signature of that kind covers. @param {typeof KINDS[number]} kind @param {Uint8Array} bytes */
export function tagged(kind, bytes) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown kind of signed thing: ${kind}`);
  return concat(utf8(`afterwrd ${kind} ${PROTOCOL}\n`), bytes);
}

/** The fingerprint of something signed of `kind`: of its tagged bytes, so the same bytes as two kinds differ. */
export const fingerprintOf = async (/** @type {typeof KINDS[number]} */ kind, /** @type {Uint8Array} */ bytes) => fingerprint(tagged(kind, bytes));

// --- Ed25519: browser keys, hosting keys, the recovery key ---------------------------------------------------------

/** A new Ed25519 key pair. Browser keys are made with `extractable` false, so even the page can't copy them out. */
export async function newKeyPair(extractable = false) {
  return /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ED25519, extractable, ["sign", "verify"]));
}

/** A public key as text: its 32 raw bytes in base64url. @param {CryptoKey} publicKey */
export async function publicKeyText(publicKey) {
  return b64url(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", publicKey)));
}

/** @param {string} text @returns {Promise<CryptoKey | null>} */
export async function importPublicKey(text) {
  const raw = fromB64url(text);
  if (!raw || raw.length !== 32) return null;
  try { return await crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"]); } catch { return null; }
}

/** Signs `bytes` as `kind`; the signature in base64url. @param {typeof KINDS[number]} kind @param {CryptoKey} privateKey @param {Uint8Array} bytes */
export async function signAs(kind, privateKey, bytes) {
  return b64url(await crypto.subtle.sign(ED25519, privateKey, tagged(kind, bytes)));
}

/**
 * Whether `signature` is `key`'s signature of `bytes` as `kind`. Never throws.
 * @param {typeof KINDS[number]} kind @param {CryptoKey | string} key @param {Uint8Array} bytes @param {string} signature
 */
export async function checkAs(kind, key, bytes, signature) {
  try {
    const k = typeof key === "string" ? await importPublicKey(key) : key;
    const sig = fromB64url(signature);
    if (!k || !sig || sig.length !== 64 || !(bytes instanceof Uint8Array)) return false;
    return await crypto.subtle.verify(ED25519, k, sig, tagged(kind, bytes));
  } catch { return false; }
}

// --- statements: several things signed by one passkey prompt --------------------------------------------------------

/**
 * The WebAuthn challenge that signs `statements` (each the fingerprint of something signed, from fingerprintOf) in one
 * passkey prompt: SHA-256 of "afterwrd statements 2\n", the server's single-use `nonce`, then each fingerprint on its
 * own line. A passkey signs the challenge, so it signs every statement; anyone given the nonce and the list can check
 * one of them without the others' contents.
 * @param {string} nonce @param {string[]} statements
 */
export async function statementsChallenge(nonce, statements) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !statements.length || statements.some((s) => !/^[A-Za-z0-9_-]{43}$/.test(s))) {
    throw new Error("A nonce and at least one fingerprint are needed.");
  }
  return fingerprint(tagged("statements", utf8([nonce, ...statements].join("\n"))));
}

// --- the recovery code ----------------------------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's base32: no I, L, O or U
const CODE_CHARS = 25; // 125 bits
// An Ed25519 private key in PKCS #8 is these 16 bytes, then the 32-byte seed.
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** A new recovery code, shown once at setup: five groups of five, like "7K3QF-…". */
export function newRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join("");
  return chars.match(/.{5}/g).join("-");
}

/** A typed recovery code tidied (case, spaces, dashes, O for 0, I and L for 1); null if it can't be one. @param {string} text */
export function tidyRecoveryCode(text) {
  const s = String(text ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_CHARS || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return s.match(/.{5}/g).join("-");
}

/**
 * The recovery key a code stands for. It's worked out wherever the code is typed (the browser), and only its public key
 * is ever stored: in the identity document. 125 random bits need no slow hashing.
 * @param {string} code @returns {Promise<{ privateKey: CryptoKey, publicKey: string } | null>}
 */
export async function recoveryKey(code) {
  const tidy = tidyRecoveryCode(code);
  if (!tidy) return null;
  const seed = await sha256(tagged("recovery", utf8(tidy)));
  const extractable = await crypto.subtle.importKey("pkcs8", concat(PKCS8_PREFIX, seed), ED25519, true, ["sign"]);
  const { x } = /** @type {JsonWebKey} */ (await crypto.subtle.exportKey("jwk", extractable));
  const privateKey = await crypto.subtle.importKey("pkcs8", concat(PKCS8_PREFIX, seed), ED25519, false, ["sign"]);
  return { privateKey, publicKey: x };
}
