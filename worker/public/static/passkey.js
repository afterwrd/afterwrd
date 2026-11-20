// Passkey signatures on the owner's own pages (afterwrd 2: src/keys.js), such as changing their identity from Your
// devices. One prompt signs a list of fingerprints at once (signed.js statementsChallenge), with one of the passkeys in
// `allow`. The sign-in pages have their own copy of credentialJSON (views/pages.js), as they run before signing in.
import { b64url, fromB64url, statementsChallenge } from "./signed.js";

/** What navigator.credentials gives, as base64url JSON (the shape @simplewebauthn/server and keys.js expect). */
export function credentialJSON(c) {
  const r = c.response;
  const response = { clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature) };
  if (r.userHandle) response.userHandle = b64url(r.userHandle);
  return { id: c.id, rawId: b64url(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults() };
}

/**
 * Asks for a face, fingerprint or PIN, and returns the passkey's signature of `statements` under the server's `nonce`.
 * @param {string} nonce @param {string[]} statements @param {string[]} allow credential ids
 */
export async function passkeySigns(nonce, statements, allow) {
  const challenge = await statementsChallenge(nonce, statements);
  const credential = /** @type {PublicKeyCredential} */ (await navigator.credentials.get({ publicKey: {
    challenge: fromB64url(challenge), userVerification: "required",
    allowCredentials: allow.map((id) => ({ type: "public-key", id: fromB64url(id) })),
  } }));
  return credentialJSON(credential);
}
