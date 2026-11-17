// Static files (public/: the scripts, stylesheet and fonts the pages use), each checked against the release before
// it's sent. Every request for one comes through here (run_worker_first in wrangler.jsonc), and the hash of every
// file is built into this code (scripts/asset-hashes.mjs), so checking that the code matches a release covers these
// files too: a changed file is refused, and the page breaks visibly instead of running something else. (Provided
// Cloudflare sends every request here: a friend's check, src/checks.js, makes sure it does.)
import HASHES from "../generated/asset-hashes.json";

const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

export async function serveStatic(request, env, hashes = HASHES) {
  const url = new URL(request.url);
  const { pathname } = url;
  const expected = Object.hasOwn(hashes, pathname) ? hashes[pathname] : null;
  if (!expected) return new Response("Not found", { status: 404 });
  // Asked for by its fingerprint (views/nav.js asset), the file can be kept for good: that address only ever has
  // these contents, checked below before they're sent. Any other address is checked by the browser each time.
  const pinned = url.searchParams.get("v") === expected.slice(0, 16);
  // The fonts are named in the stylesheet, so their addresses can't carry a fingerprint: they're kept a week. (Give a
  // font a new file name if it ever changes, or browsers may show the old one for up to a week.)
  const font = pathname.startsWith("/static/fonts/");
  // The file's own hash is its ETag. A browser asking whether its copy (checked when it was sent) is still current
  // gets an answer without the file being read again.
  const headers = { "Cache-Control": pinned ? "private, max-age=31536000, immutable" : font ? "private, max-age=604800" : "private, no-cache",
    ETag: `"${expected}"` };
  const asked = (request.headers.get("If-None-Match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (asked.includes(`"${expected}"`)) return new Response(null, { status: 304, headers });

  const asset = await env.ASSETS.fetch(new Request(request.url)); // the whole file, never a 304 or part of it
  if (!asset.ok) return new Response("Not found", { status: 404 });
  const body = await asset.arrayBuffer();
  if ((await sha256(body)) !== expected) {
    console.error(`${pathname} doesn't match the release, so it wasn't sent.`);
    return new Response("This file isn't the one this version of afterwrd was released with, so it wasn't sent.",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  headers["Content-Type"] = asset.headers.get("Content-Type") ?? "application/octet-stream";
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
