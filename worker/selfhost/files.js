// The site's own files (public/), from workerd's disk service, with the Content-Type Cloudflare's ASSETS would
// give them. Only GET and HEAD; static.js in the site's code checks each file against the release before sending it.
const TYPES = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  woff2: "font/woff2",
  html: "text/html; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
};

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    const { pathname } = new URL(request.url);
    if (pathname.split("/").some((part) => part === ".." || part.startsWith("."))) return new Response("Not found", { status: 404 });
    const file = await env.DISK.fetch(new URL(pathname, "http://files"), { method: request.method });
    if (!file.ok) return new Response("Not found", { status: 404 });
    const type = TYPES[pathname.split(".").pop()] ?? "application/octet-stream";
    return new Response(file.body, { headers: { "Content-Type": type } });
  },
};
