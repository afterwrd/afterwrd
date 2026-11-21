// Blocking (afterwrd 2, step 7c: docs/signed-conversations.md, "Blocking", decision 20, threat model T22): quiet, and
// by key, so it holds if they move site. A blocked person's notes, replies, mentions and @here are dropped here; their
// friend asks and introductions of them are dropped as if declined; on the owner's own posts their records aren't
// taken; their comments and group posts are folded away ("Hidden: someone you've blocked"); polls and events still count
// them (the count is what's signed), without naming them. They aren't told. Blocking a friend ends the friendship
// first (they're told it ended, as now, not why). It's the owner's own: blocking a member of a group they own hides them
// from the owner only (Remove is for the group).
//   POST /_admin/blocks                    form: person, name, back: block someone
//   POST /_admin/blocks/<person>/unblock   form: back
import { safeNext } from "./auth.js";
import { removeFriend } from "./connect.js";
import { now } from "./util.js";

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Whether the owner here has blocked `person`. @param {D1Database} db @param {unknown} person */
export async function isBlocked(db, person) {
  return typeof person === "string" && Boolean(await db.prepare("SELECT 1 FROM blocks WHERE person = ?").bind(person).first());
}

/** Which of `people` the owner here has blocked. @param {D1Database} db @param {unknown[]} people */
export async function blockedAmong(db, people) {
  const list = [...new Set(people.filter((p) => typeof p === "string"))];
  if (!list.length) return new Set();
  const { results } = await db.prepare("SELECT person FROM blocks WHERE person IN (SELECT value FROM json_each(?))").bind(JSON.stringify(list)).all();
  return new Set(results.map((r) => String(r.person)));
}

/** Everyone blocked, for Friends. @param {D1Database} db */
export const blockedList = async (db) => (await db.prepare("SELECT person, name, created_at FROM blocks ORDER BY created_at DESC").all()).results;

/** The owner's block and unblock. */
export async function handleBlocks(request, env, url) {
  const form = await request.formData().catch(() => new FormData());
  const back = safeNext(String(form.get("back") ?? "/friend"), url);
  const unblock = /^\/_admin\/blocks\/([A-Za-z0-9_-]{43})\/unblock$/.exec(url.pathname);
  if (unblock) {
    await env.DB.prepare("DELETE FROM blocks WHERE person = ?").bind(unblock[1]).run();
    return Response.redirect(`${url.origin}${back}`, 303);
  }
  if (url.pathname !== "/_admin/blocks") return new Response("Not found", { status: 404 });
  const person = String(form.get("person") ?? "");
  const me = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  if (!ID_RE.test(person) || person === me?.person) return Response.redirect(`${url.origin}${back}`, 303);
  // A friend: the friendship ends first (they're told it ended, not why), under the name the owner knew them by. Someone
  // asking: their request goes, with nothing said (they see it waiting, as if declined).
  const friend = await env.DB.prepare("SELECT id, name, origin, approved_at FROM connections WHERE identity = ?").bind(person).first();
  const name = String(friend?.name ?? form.get("name") ?? "Someone").slice(0, 100);
  if (friend?.approved_at) await removeFriend(env, url.origin, Number(friend.id)).catch(() => null);
  else if (friend) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(Number(friend.id)),
      env.DB.prepare("INSERT OR REPLACE INTO declined_asks (origin, declined_at) VALUES (?, ?)").bind(String(friend.origin), now()),
    ]);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO blocks (person, name, created_at) VALUES (?, ?, ?)").bind(person, name, now()).run();
  return Response.redirect(`${url.origin}${friend?.approved_at ? "/friend" : back}`, 303);
}
