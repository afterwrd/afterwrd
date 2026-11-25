// Muting (docs/safety-plan.md 3.2): quiet, local, and by key, as blocking is (blocks.js), but lighter. A muted friend's
// posts are left off Home; a muted member's posts in a group fold to one line, with a way to see each. Nothing else
// changes: you stay friends (or both in the group), their own page shows everything, their comments show as ever,
// and anything addressed to you (mentions, invitations, replies) still comes. They aren't told.
//   POST /_admin/mutes                    form: person, name, back: mute someone
//   POST /_admin/mutes/<person>/unmute    form: back
import { safeNext } from "./auth.js";
import { now } from "./util.js";

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Whether the owner here has muted `person`. @param {D1Database} db @param {unknown} person */
export async function isMuted(db, person) {
  return typeof person === "string" && Boolean(await db.prepare("SELECT 1 FROM mutes WHERE person = ?").bind(person).first());
}

/** Which of `people` the owner here has muted. @param {D1Database} db @param {unknown[]} people */
export async function mutedAmong(db, people) {
  const list = [...new Set(people.filter((p) => typeof p === "string"))];
  if (!list.length) return new Set();
  const { results } = await db.prepare("SELECT person FROM mutes WHERE person IN (SELECT value FROM json_each(?))").bind(JSON.stringify(list)).all();
  return new Set(results.map((r) => String(r.person)));
}

/** Everyone muted, for Friends. @param {D1Database} db */
export const mutedList = async (db) => (await db.prepare("SELECT person, name, created_at FROM mutes ORDER BY created_at DESC").all()).results;

/** The owner's mute and unmute. */
export async function handleMutes(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const form = await request.formData().catch(() => new FormData());
  const back = safeNext(String(form.get("back") ?? "/friend"), url);
  const unmute = /^\/_admin\/mutes\/([A-Za-z0-9_-]{43})\/unmute$/.exec(url.pathname);
  if (unmute) {
    await env.DB.prepare("DELETE FROM mutes WHERE person = ?").bind(unmute[1]).run();
    return Response.redirect(`${url.origin}${back}`, 303);
  }
  if (url.pathname !== "/_admin/mutes") return new Response("Not found", { status: 404 });
  const person = String(form.get("person") ?? "");
  const me = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  if (!ID_RE.test(person) || person === me?.person) return Response.redirect(`${url.origin}${back}`, 303);
  // A friend by the name the owner knows them by; anyone else (a member of a group) by the name the page showed.
  const friend = await env.DB.prepare("SELECT name FROM connections WHERE identity = ? AND approved_at IS NOT NULL").bind(person).first();
  const name = String(friend?.name ?? form.get("name") ?? "Someone").slice(0, 100);
  await env.DB.prepare("INSERT OR IGNORE INTO mutes (person, name, created_at) VALUES (?, ?, ?)").bind(person, name, now()).run();
  return Response.redirect(`${url.origin}${back}`, 303);
}
