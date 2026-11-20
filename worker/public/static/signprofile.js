// The owner's profile (their name), signed by this browser's key in the background (afterwrd 2: src/keys.js), so
// friends' sites can show it knowing it's theirs. No prompt: the browser key already signs for the owner. A browser
// without one (not signed in since signing was set up, or it can't make keys) leaves it for another that has.
import { signAs, fromB64url } from "./signed.js";
import { savedKey } from "./browserkey.js";

/** Signs `bytes` (base64url, the profile the site made) and hands it back to the site. */
export async function signProfile(bytes) {
  const key = await savedKey();
  if (!key?.person || key.expires < Date.now() / 1000) return;
  const signature = await signAs("profile", key.privateKey, fromB64url(bytes));
  await fetch("/_admin/keys/profile", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytes, key: key.publicKey, signature }) });
}
