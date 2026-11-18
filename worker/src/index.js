// The site's Worker: a front door. Every request comes through here first (run_worker_first) and is handed to the
// site's own object, which holds its database and answers it there, next to the data, so a page's queries cost no
// trips at all (outbox.js, sqlite.js; docs/site-object-plan.md).
//
// Updates are the exception, answered here instead, with the database reached through the object (as the other
// objects reach it): switching to a new version restarts every object of the Worker, so an update run inside one
// would stop half-way, its health check and switching back included. The daily run (automatic updates, friends'
// checks) is here for the same reason.
import { daily, handle, HEADERS } from "./app.js";
import { FRONT_HEADER, OLDER_CODE, remote, siteObject, ZONE_HEADER } from "./sqlite.js";

export { MediaStore } from "./media.js";
export { Outbox } from "./outbox.js";

const UPDATES = /^\/(_auto|_admin\/update)(\/|$)/;
const outside = new WeakMap();
/** env for answering here, outside the site's object: its database reached through the object. */
function here(env) {
  let full = outside.get(env);
  if (!full) outside.set(env, (full = { ...env, DB: remote(env) }));
  return full;
}

/**
 * A request handed to the site's object, with the visitor's time zone and this Worker's version (each always set
 * here, never taken from the visitor). An object still running an older version restarts itself on seeing a newer
 * one (outbox.js), and is asked again, then running this one. Only a request without a body can be sent twice: others
 * get "try again", which only happens in the moments after an update.
 */
async function toSite(request, env) {
  const headers = new Headers(request.headers);
  // The visitor's time zone (Cloudflare's request.cf.timezone, the only part of request.cf the site uses) doesn't go
  // along with a request to an object, so it goes in a header.
  headers.set(ZONE_HEADER, /^[\w+\-/]{1,64}$/.test(request.cf?.timezone ?? "") ? request.cf.timezone : "");
  headers.set(FRONT_HEADER, JSON.stringify({ id: env.VERSION?.id ?? null, timestamp: env.VERSION?.timestamp ?? null }));
  const ask = () => siteObject(env).fetch(new Request(request, { headers }));
  try {
    return await ask();
  } catch (error) {
    const restarted = String(error?.message ?? error).includes(OLDER_CODE);
    if (["GET", "HEAD"].includes(request.method)) return ask();
    if (!restarted) throw error;
    return new Response(JSON.stringify({ error: "Your site has just been updated. Try that again." }),
      { status: 503, headers: { ...HEADERS, "Content-Type": "application/json", "Retry-After": "1", "Cache-Control": "no-store" } });
  }
}

/**
 * GET /_version: which version of the Worker is answering, from the Worker itself. With ?health=1 (what an update
 * waits for before it counts: auto.js), also whether the site's object answers healthily, asked through toSite so
 * it's running this version too where it can. The id is the Worker's: since 0.57.0 the object answered, and a busy one
 * kept its old code and so its old id, so no update could pass (docs/speed-and-scale-plan.md, "Scale test").
 */
async function version(request, env, url) {
  const id = env.VERSION?.id ?? null;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!url.searchParams.has("health")) return json({ id });
  const reply = await toSite(new Request(`${url.origin}/_version?health=1`), env).catch(() => null);
  const site = reply?.ok ? await reply.json().catch(() => null) : (await reply?.body?.cancel(), null);
  return site?.ok === true ? json({ id, ok: true }) : json({ id, ok: false }, 503);
}

export default {
  fetch(request, env, work) {
    const url = new URL(request.url);
    if (UPDATES.test(url.pathname)) return handle(request, here(env), work);
    if (url.pathname === "/_version" && request.method === "GET") return version(request, env, url);
    return toSite(request, env);
  },
  scheduled(event, env, work) {
    work.waitUntil(daily(here(env)));
  },
};
