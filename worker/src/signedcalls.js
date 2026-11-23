// Signed calls between sites (afterwrd 2: docs/signed-conversations.md, section 1). Every call one site makes to another
// is signed with the caller's hosting key, so the receiver knows which identity is calling without either keeping a
// password for the other. The format is RFC 9421 (HTTP Message Signatures) with Ed25519, covering:
//   "@method"        GET, POST…
//   "@target-uri"    the full address called, checked against the receiver's OWN address (never a Host header), so a
//                    call signed for one site can't be replayed to another, even behind a proxy
//   "afterwrd-from"  the caller's site address: where the receiver can fetch the caller's identity if it doesn't know it
//   "content-digest" SHA-256 of the body (RFC 9530), for calls with one
// with parameters created (the caller's clock: the receiver allows 5 minutes either way), keyid (the caller's person
// id) and tag "afterwrd". Pure: no storage, no fetching (the receiver passes in how to find a caller's hosting key), so
// it can be checked anywhere.
import { fromB64url, sha256, utf8 } from "../public/static/signed.js";

export const CLOCK_SECONDS = 300;
const PERSON_RE = /^[A-Za-z0-9_-]{43}$/;
const ED25519 = { name: "Ed25519" };
const std64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromStd64 = (text) => {
  try { return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)); } catch { return null; }
};

/** The address a site is called at, as its signature covers it: origin, path and query, nothing else. */
const targetOf = (url) => { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; };

/** The signature base RFC 9421 section 2.5 defines, for the components this protocol covers. */
function base({ method, target, from, digest, params }) {
  const lines = [`"@method": ${method}`, `"@target-uri": ${target}`, `"afterwrd-from": ${from}`];
  if (digest) lines.push(`"content-digest": ${digest}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

const paramsOf = ({ digest, created, keyid }) =>
  `("@method" "@target-uri" "afterwrd-from"${digest ? ' "content-digest"' : ""});created=${created};keyid="${keyid}";alg="ed25519";tag="afterwrd"`;

/**
 * The headers that sign a call: `method` to `url`, with `body` (a string or bytes, or nothing), as `person` from site
 * `from`, with their hosting key `privateKey`. `at` is now (seconds).
 * @returns {Promise<Record<string, string>>}
 */
export async function signCall({ method, url, body = null, person, from, privateKey, at = Math.floor(Date.now() / 1000) }) {
  const bytes = body == null ? null : typeof body === "string" ? utf8(body) : body;
  const digest = bytes ? `sha-256=:${std64(await sha256(bytes))}:` : null;
  const params = paramsOf({ digest, created: at, keyid: person });
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, privateKey,
    utf8(base({ method: method.toUpperCase(), target: targetOf(url), from, digest, params }))));
  return {
    "Afterwrd-From": from,
    ...(digest ? { "Content-Digest": digest } : {}),
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${std64(signature)}:`,
  };
}

/**
 * Who signed a call, or null if it isn't properly signed. `ownOrigin` is the receiver's own address: the call must be to
 * it. `hostingKeyOf(person, from)` gives that person's current hosting key (base64url) if the receiver knows, or can
 * learn from `from`, who they are; null if not. `body` is the call's body as received (bytes), if any. Never throws.
 * @param {{ method: string, url: string, headers: Headers, body?: Uint8Array | null }} call
 * @param {{ ownOrigin: string, hostingKeyOf: (person: string, from: string, options?: { again?: boolean }) => Promise<string | null>, at?: number }} options
 * @returns {Promise<{ person: string, from: string } | null>}
 */
export async function checkCall({ method, url, headers, body = null }, { ownOrigin, hostingKeyOf, at = Math.floor(Date.now() / 1000) }) {
  try {
    const target = targetOf(url);
    if (new URL(target).origin !== ownOrigin) return null;
    const input = /^sig1=(\("@method" "@target-uri" "afterwrd-from"( "content-digest")?\);created=(\d{1,12});keyid="([A-Za-z0-9_-]{43})";alg="ed25519";tag="afterwrd")$/
      .exec(headers.get("Signature-Input") ?? "");
    const sig = /^sig1=:([A-Za-z0-9+/]{86}==):$/.exec(headers.get("Signature") ?? "");
    const from = headers.get("Afterwrd-From") ?? "";
    if (!input || !sig || !from || from.length > 200) return null;
    const [, params, coversDigest, createdText, person] = input;
    if (!PERSON_RE.test(person) || Math.abs(at - Number(createdText)) > CLOCK_SECONDS) return null;
    let fromOrigin;
    try { fromOrigin = new URL(from).origin; } catch { return null; }
    if (fromOrigin !== from) return null;
    // A body must be covered, and match; no body, no digest.
    const hasBody = body && body.length > 0;
    if (Boolean(coversDigest) !== Boolean(hasBody)) return null;
    let digest = null;
    if (hasBody) {
      digest = headers.get("Content-Digest") ?? "";
      if (digest !== `sha-256=:${std64(await sha256(body))}:`) return null;
    }
    const signedBase = utf8(base({ method: method.toUpperCase(), target, from, digest, params }));
    const verifies = async (key) => {
      const raw = key && fromB64url(key);
      if (!raw || raw.length !== 32) return false;
      const publicKey = await crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"]);
      return crypto.subtle.verify(ED25519, publicKey, fromStd64(sig[1]), signedBase);
    };
    const key = await hostingKeyOf(person, from);
    if (await verifies(key)) return { person, from };
    // Their hosting key may have changed since the receiver learnt it: asked again (the receiver limits how often),
    // and checked once more if it's another.
    const again = key && (await hostingKeyOf(person, from, { again: true }));
    return again && again !== key && (await verifies(again)) ? { person, from } : null;
  } catch { return null; }
}

