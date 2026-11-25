// A browser here that can't sign for the owner: it signed in before afterwrd 2 (so it never made a key), or its key's
// 30 days ran out while it stayed signed in. One passkey prompt lets it, as at sign-in (src/keys.js browser/start and
// browser/finish), without signing out.
// A page with a [data-browser-sign] box (Home, Your devices) shows it only while this browser can't sign; its button
// does the asking.
import { passkeySigns } from "../passkey.js";
import { fingerprintOf, fromB64url, signAs } from "../signed.js";
import { keyAllowed, newBrowserKey, savedKey } from "../browserkey.js";

/** @param {string} path @param {any} body */
async function keysApi(path, body) {
  const response = await fetch(`/_admin/keys${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "That didn't work. Try again.");
  return data;
}

/** Whether this browser has a key that signs for the owner now. */
export async function canSign() {
  const key = await savedKey();
  return Boolean(key?.person && key.expires > Date.now() / 1000);
}

/** Makes this browser a key and has one of the owner's passkeys let it sign for them (one prompt). */
export async function letThisBrowserSign() {
  const key = await newBrowserKey();
  const start = await keysApi("/browser/start", { browserKey: key.publicKey });
  const delegation = fromB64url(start.delegation);
  const response = await passkeySigns(start.nonce, [await fingerprintOf("delegation", delegation)], start.allow);
  // This browser signs the delegation with its own key too, showing it holds the key it names (keys.js holdsKey).
  const possession = await signAs("delegation", key.privateKey, delegation);
  const done = await keysApi("/browser/finish", { delegation: start.delegation, response, possession });
  await keyAllowed(key, done.person, done.expires);
}

const box = /** @type {HTMLElement | null} */ (document.querySelector("[data-browser-sign]"));
if (box && !(await canSign())) {
  box.hidden = false;
  const button = /** @type {HTMLButtonElement | null} */ (box.querySelector("button"));
  const error = /** @type {HTMLElement | null} */ (box.querySelector(".error"));
  button?.addEventListener("click", async () => {
    button.disabled = true;
    if (error) error.textContent = "";
    try {
      await letThisBrowserSign();
      box.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Done: this browser signs for you now." }));
      setTimeout(() => { box.hidden = true; }, 4000);
    } catch (err) {
      button.disabled = false;
      if (error) error.textContent = /** @type {Error} */ (err).name === "NotAllowedError" ? "That was cancelled. Try again when you're ready." : /** @type {Error} */ (err).message;
    }
  });
}
