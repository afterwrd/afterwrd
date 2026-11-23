// Which scripts a page may run. Every answer's Content-Security-Policy (app.js) lets scripts run only from this site's
// own files or when they carry the answer's nonce: a number made fresh for that one answer, which the page's own
// <script> tags are given as they're drawn (`nonce="${nonce()}"`). Something that got into a page any other way (an
// onclick, an injected <script>) has no way to know it, so it doesn't run. The nonce is given at drawing time, never
// added to a finished page afterwards: that would bless whatever else the page had in it too.
import { AsyncLocalStorage } from "node:async_hooks";

/** @type {AsyncLocalStorage<string>} */
const current = new AsyncLocalStorage();

/** A new nonce: 18 random bytes, base64url (nothing in it is changed by escaping). */
export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Runs `fn` with `value` as the nonce pages drawn in it give their scripts. */
export const withNonce = (value, fn) => current.run(value, fn);

/** The nonce for the page being drawn now; "" outside an answer (a script with it doesn't run). */
export const nonce = () => current.getStore() ?? "";

/** The Content-Security-Policy for an answer whose pages' scripts carry `value`. */
export const contentSecurityPolicy = (value) => `script-src 'self'${value ? ` 'nonce-${value}'` : ""}; ${BASE_POLICY}`;

// No framing, plugins, <base> tricks or forms posting elsewhere. Pages' own calls (fetch) go only to this site, so a
// library running in the page, such as zip.js reading a Facebook download, can't send what it reads anywhere else
// that way. Calls to Cloudflare, GitHub and friends' sites are made by the Worker, not the page.
export const BASE_POLICY = "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
