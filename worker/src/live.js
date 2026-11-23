// What's changed since an open page loaded, for public/static/live.js to say quietly ("2 new posts · Show"):
//   GET /_live?since=<time>&items=<id>,…
//   -> { notifications, requests, posts, comments, update }
// notifications and requests are the header's counts. posts counts friends' new posts (from the notes their sites
// send: notes.js notices). comments counts new comments by others on the posts and photos the page shows (`items`:
// notices, friends' and groups'). Only reads this site's own database. Times are in seconds, so
// anything from the second the page was made counts: at worst, offering something the page already shows.
// update is the newer afterwrd release that's out, if any (update.js), for the mark on the Update button.
import { newCount } from "./archive/comments.js";
import { waitingRelease } from "./update.js";
import { json, now } from "./util.js";

const MAX_TARGETS = 80;

export async function handleLive(request, env, url, user, work) {
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const db = env.DB;
  const since = Math.min(now(), Math.max(0, Number.parseInt(url.searchParams.get("since"), 10) || now()));
  const list = (name) => (url.searchParams.get(name) ?? "").split(",").filter(Boolean).slice(0, MAX_TARGETS);
  const items = list("items").filter((id) => /^[A-Za-z0-9_-]{43}$/.test(id)); // signed posts and photos (afterwrd 2: notes.js)

  const [requests, posts, signed] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL"),
    db.prepare(`SELECT COUNT(*) AS n FROM notices n JOIN connections co ON co.id = n.connection_id AND co.approved_at IS NOT NULL
      WHERE n.kind = 'post' AND n.created_at >= ?`).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE kind IN ('comment', 'mention') AND created_at >= ?
      AND item IN (SELECT value FROM json_each(?))`).bind(since, JSON.stringify(items)),
  ]);
  return json({
    notifications: await newCount(db, user),
    requests: requests.results[0].n,
    posts: posts.results[0].n,
    comments: signed.results[0].n,
    update: await waitingRelease(env, work, url.origin),
  }, 200);
}
