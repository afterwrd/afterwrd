// A stand-in for another afterwrd site's identity (docs/signed-conversations.md, section 1), for tests where the other
// site is a small server in the test rather than a real site: a software passkey signs the first identity document, as
// a phone would, so a real site checks it exactly as it checks anyone's. The stand-in serves it at
// /.well-known/afterwrd (wellKnown) and signs its calls with its hosting key (signedHeaders), as src/calls.js does.
import { b64url, concat, encode, fingerprintOf, fromB64url, newKeyPair, publicKeyText, recoveryKey, newRecoveryCode, sha256,
  statementsChallenge, utf8 } from "../../public/static/signed.js";
import { signCall } from "../../src/signedcalls.js";

const bytes = (a) => new Uint8Array(a);

/** DER for an ECDSA signature WebCrypto gives as r‖s. */
function der(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(bytes([0]), b) : b; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  const body = concat(bytes([0x02, r.length]), r, bytes([0x02, s.length]), s);
  return concat(bytes([0x30, body.length]), body);
}

/** A software passkey made at `origin`: {passkey (as an identity document lists it), sign(statements)}. */
async function softPasskey(origin) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = concat(bytes([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x), bytes([0x22, 0x58, 0x20]), fromB64url(jwk.y));
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    passkey: { id, key: b64url(cose), origin },
    async sign(statements) {
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
      const challenge = await statementsChallenge(nonce, statements);
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(new URL(origin).hostname)), bytes([0x05]), bytes([0, 0, 0, 0]));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, concat(authData, await sha256(clientData))));
      return { credential: id, nonce, statements, response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(der(raw)) } };
    },
  };
}

/**
 * A new identity for a site at `origin`: {person, wellKnown (what /.well-known/afterwrd answers), signedHeaders(method,
 * url, body?)}.
 */
export async function standInIdentity(origin) {
  const phone = await softPasskey(origin);
  const hosting = await newKeyPair(true);
  const recovery = await recoveryKey(newRecoveryCode());
  const doc = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin, passkeys: [phone.passkey], recovery: recovery.publicKey,
    hosting: await publicKeyText(hosting.publicKey) });
  const person = await fingerprintOf("identity", doc);
  const chain = [{ bytes: b64url(doc), sig: { passkey: await phone.sign([person]) } }];
  return {
    person,
    wellKnown: JSON.stringify({ v: 2, chain }),
    signedHeaders: (method, url, body = null) => signCall({ method, url, body, person, from: origin, privateKey: hosting.privateKey }),
  };
}
