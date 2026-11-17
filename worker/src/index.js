// The site's Worker: a front door. Every request comes through here first (run_worker_first) and is handed to the
// site's own object, which holds its database and answers it there, next to the data, so a page's queries cost no
// trips at all (outbox.js, sqlite.js; docs/site-object-plan.md).
//
// Updates are the exception, answered here instead, with the database reached through the object (as the other
// objects reach it): switching to a new version restarts every object of the Worker, so an update run inside one
// would stop half-way, its health check and switching back included. The daily run (automatic updates, friends'
// checks) is here for the same reason.
import { daily, handle } from "./app.js";
import { remote, siteObject, ZONE_HEADER } from "./sqlite.js";

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

export default {
  fetch(request, env, work) {
    if (UPDATES.test(new URL(request.url).pathname)) return handle(request, here(env), work);
    // Handed to the site's object as it came. The visitor's time zone (Cloudflare's request.cf.timezone, the only part
    // of request.cf the site uses) doesn't go along with a request to an object, so it goes in a header, always set
    // here, never taken from the visitor.
    const headers = new Headers(request.headers);
    headers.set(ZONE_HEADER, /^[\w+\-/]{1,64}$/.test(request.cf?.timezone ?? "") ? request.cf.timezone : "");
    return siteObject(env).fetch(new Request(request, { headers }));
  },
  scheduled(event, env, work) {
    work.waitUntil(daily(here(env)));
  },
};
