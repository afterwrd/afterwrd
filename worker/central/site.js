// afterwrd.app itself, served by the installer's Worker (central/index.js) rather than GitHub Pages, so whoever controls
// GitHub can't change what people read before installing, or the Connect page every site's sign-in goes through. The
// pages are installer/*.html, as in the repository, bundled when the installer is deployed (by hand, from the project's
// Cloudflare account). The install page names the newest release signed with afterwrd's own key (src/signing.js):
// the one the installer installs.
//
//   /               the install page
//   /connect/       the Connect page: where Cloudflare's sign-in sends people back to (src/cloudflare.js RELAY)
//   /how-it-works/  /compared/  /check/
// www.afterwrd.app sends people to afterwrd.app.
import pkg from "../package.json";
import INSTALL from "../installer/page.html";
import CONNECT from "../installer/connect.html";
import HOW from "../installer/how-it-works.html";
import COMPARED from "../installer/compared.html";
import CHECK from "../installer/check.html";

export const SITE_HOST = pkg.afterwrd.site;
const REPO_PAGE = `https://github.com/${pkg.afterwrd.releases}`;
const PAGES = { "/": INSTALL, "/connect/": CONNECT, "/how-it-works/": HOW, "/compared/": COMPARED, "/check/": CHECK };

// Nothing is fetched but the page itself: no scripts at all but the Connect page's own, by its nonce.
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Whether `request` is for afterwrd.app (or www.): by its address, or, on this computer, a test's header.
 * @param {Request} request
 * @param {{ url: URL, testing: boolean }} here
 */
export function forSite(request, { url, testing }) {
  return url.hostname === SITE_HOST || url.hostname === `www.${SITE_HOST}` || (testing && request.headers.get("X-Test-Site") === "1");
}

/**
 * One of afterwrd.app's pages. `newest()` gives the newest signed release ({version, manifestSha256}), only asked for
 * pages that name it.
 * @param {Request} request
 * @param {{ url: URL, testing: boolean }} here
 * @param {() => Promise<{ version: string, manifestSha256: string }>} newest
 */
export async function sitePage(request, { url, testing }, newest) {
  if (url.hostname === `www.${SITE_HOST}`) return Response.redirect(`https://${SITE_HOST}${url.pathname}${url.search}`, 301);
  if (url.protocol === "http:" && !testing) return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
  if (request.method !== "GET" && request.method !== "HEAD") return plain("Not found.", 404);
  // As GitHub Pages did: a folder's address without its last slash goes to the one with it.
  if (Object.hasOwn(PAGES, `${url.pathname}/`)) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  if (!Object.hasOwn(PAGES, url.pathname)) return plain("There's nothing here. afterwrd.app is at https://afterwrd.app/.", 404);
  let page = PAGES[url.pathname];
  const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": POLICY, "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000" };
  if (url.pathname === "/connect/") {
    // Its script runs by a nonce made for this answer; the page is the repository's file, with the sign-in apps in.
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_");
    page = page.replaceAll("__OAUTH_CLIENTS__", [pkg.afterwrd.cloudflareClient, ...(pkg.afterwrd.cloudflareClientsBefore ?? [])].join(" "))
      .replaceAll("__OAUTH_CLIENT_UNSAID__", (pkg.afterwrd.cloudflareClientsBefore ?? [])[0] ?? pkg.afterwrd.cloudflareClient)
      .replace("<script>", `<script nonce="${nonce}">`);
    headers["Content-Security-Policy"] = `${POLICY}; script-src 'nonce-${nonce}'`;
  } else {
    let release;
    try {
      release = await remembered(newest);
    } catch {
      return plain("afterwrd.app couldn't check which release is signed just now. Try again in a minute.", 503);
    }
    page = page.replaceAll("__VERSION__", release.version)
      .replaceAll("__MANIFEST_SHORT__", release.manifestSha256.slice(0, 12))
      .replaceAll("__RELEASE_PAGE__", `${REPO_PAGE}/releases/tag/v${release.version}`)
      .replaceAll("__REPO_PAGE__", REPO_PAGE);
  }
  return new Response(request.method === "HEAD" ? null : page, { headers });
}

// The newest signed release, as last read (a few minutes fresh), and as a fallback for a week when GitHub can't be read
// or its list doesn't check: the pages stay up, naming the last release that was signed.
const FRESH_MS = 10 * 60_000;
const CACHE_KEY = `https://${SITE_HOST}/_cache/newest-signed`;
async function remembered(newest) {
  const cache = /** @type {any} */ (globalThis).caches?.default;
  const kept = cache ? await cache.match(CACHE_KEY).then((r) => r?.json()).catch(() => null) : null;
  if (kept?.release && Date.now() - kept.at < FRESH_MS) return kept.release;
  try {
    const release = await newest();
    if (cache) await cache.put(CACHE_KEY, new Response(JSON.stringify({ release, at: Date.now() }), { headers: { "Cache-Control": "max-age=604800" } })).catch(() => {});
    return release;
  } catch (error) {
    if (kept?.release) return kept.release;
    throw error;
  }
}

const plain = (text, status) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
