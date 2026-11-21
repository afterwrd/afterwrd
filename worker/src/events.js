// Events (docs/events-plan.md). The owner's own events are signed items (items.js, itemkinds.js): the browser signs each
// form, after this site has read it exactly as it will check it (POST /_admin/events/read, below). Friends' events reach
// this site as signed posts too (friendcopies.js). What's left here:
// - the owner's events from before signing (events, post_audience, event_answers), shown to them alone, read-only,
//   until migration turns them into signed items (docs/signed-conversations.md, step 10);
// - group events the owner's going to, copied into events_elsewhere for the calendar (membership.js), and how a group
//   sends one (parseSharedEvent), until groups are signed too (step 6);
// - forgetting a removed friend (friendGone).
import { ANSWERS, FINISHED_SQL, finishedAt, parseEvent, readEventForm, ruleDates } from "./calendar.js";
import { siteOrigin } from "./sites.js";
import { now, Refusal } from "./util.js";
import { MAX_POST_TEXT } from "./edits.js";
import { MAX_GUESTS } from "./items.js";

const KEEP_SECONDS = 30 * 86400; // copies of events from elsewhere stay this long after they're over
const MAX_PEOPLE = 5000; // in each of an event's lists from elsewhere (going, maybe, can't): well above a big group
const APPROVED = (c = "") => `${c}connected_at IS NOT NULL AND ${c}approved_at IS NOT NULL`;

/**
 * Statements forgetting a removed friend (`connectionId`): their answers on the owner's signed events, their
 * invitations, their posts kept here and notices about them, and their place on the owner's events from before signing
 * (so someone given their number later never stands in for them).
 */
export const friendGone = (db, connectionId) => [
  // afterwrd 2: their answers on the owner's signed events, their invitations, their posts kept here, and notices.
  db.prepare(`UPDATE items SET tally = json_remove(tally, '$.answers."' || (SELECT identity FROM connections WHERE id = ?1) || '"')
    WHERE audience = 'invited' AND tally IS NOT NULL AND id IN (SELECT item FROM item_guests WHERE connection_id = ?1)
    AND (SELECT identity FROM connections WHERE id = ?1) IS NOT NULL`).bind(connectionId),
  db.prepare("DELETE FROM item_guests WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM item_uninvited WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM copies WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM notices WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM post_audience WHERE connection_id = ?").bind(connectionId),
  db.prepare("DELETE FROM event_answers WHERE connection_id = ?").bind(connectionId),
];

// --- the owner's events from before signing --------------------------------------------------------------------------

/**
 * The events in some of the owner's posts from before signing (posts ids), with everyone invited and every answer, as
 * they were: the owner's alone, read-only.
 * @returns {Promise<Map<number, any>>}
 */
export async function eventsFor(db, ids) {
  if (!ids.length) return new Map();
  // By the range of post numbers, then only those asked for, as sitePolls does: only the events in that range are
  // read, rather than each id looked up whether it has one or not.
  const range = [Math.min(...ids), Math.max(...ids)];
  const wanted = new Set(ids);
  const [events, guests] = await db.batch([
    db.prepare("SELECT * FROM events WHERE post_id BETWEEN ? AND ?").bind(...range),
    db.prepare(`SELECT a.post_id, c.id, c.origin, c.name, a.delivery, x.answer FROM post_audience a JOIN connections c ON c.id = a.connection_id AND ${APPROVED("c.")}
      LEFT JOIN event_answers x ON x.post_id = a.post_id AND x.connection_id = a.connection_id
      WHERE a.post_id BETWEEN ? AND ? ORDER BY x.answered_at, c.name COLLATE NOCASE`).bind(...range),
  ]);
  return new Map(events.results.filter((e) => wanted.has(e.post_id)).map((e) => {
    const all = guests.results.filter((g) => g.post_id === e.post_id);
    const who = (answer) => all.filter((g) => g.answer === answer).map((g) => ({ id: g.id, name: g.name, from: g.origin }));
    return [e.post_id, {
      ...e, going: who("going"), maybe: who("maybe"), invited: all.length, cantGo: who("no"),
      waiting: all.filter((g) => !g.answer).map((g) => ({ id: g.id, name: g.name, from: g.origin, delivery: g.delivery })),
      answer: null,
    }];
  }));
}

// --- the owner's forms ------------------------------------------------------------------------------------------------

export async function handleEvents(request, env, url) {
  if (request.method !== "POST" || url.pathname !== "/_admin/events/read") return new Response("Not found", { status: 404 });
  return readForSigning(env, await request.formData().catch(() => new FormData()), request.cf?.timezone);
}

/**
 * POST /_admin/events/read (afterwrd 2: signed events, itemkinds.js): what the owner's browser is to sign for one of the
 * event forms, worked out here exactly as the site will check it. `op`: new (the form), change (the form, for `item`),
 * cancel, invite (`guest`… more) or uninvite (`guest`) on `item`. Answers {event, text, guests?: [{id, person}]} (guests
 * only when who's invited changes), or {error}.
 */
async function readForSigning(env, form, zone) {
  const db = env.DB;
  const op = String(form.get("op") ?? "");
  const group = Number(form.get("group") ?? 0) || null;
  const fail = (error) => Response.json({ error }, { status: 400 });
  // In a signed group, an event may repeat (step 6d): its rule goes with it.
  const plain = ({ title, starts_at, ends_at, all_day, time_zone, place, rrule }) => ({ title, starts_at, ends_at, all_day, time_zone, place,
    ...(group && rrule ? { rrule } : {}) });
  const words = (value) => {
    const text = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
    return text.length > MAX_POST_TEXT ? null : text;
  };
  // Friends with an identity, as invitations name them; anyone without one can't be invited to a signed event yet.
  const people = async (ids) => {
    const list = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (list.length > MAX_GUESTS) throw new Refusal(`You can invite up to ${MAX_GUESTS} friends to an event.`);
    const { results } = list.length ? await db.prepare(`SELECT id, name, identity FROM connections WHERE ${APPROVED()} AND id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(list)).all() : { results: [] };
    const missing = results.find((r) => !r.identity);
    if (missing) throw new Refusal(`${missing.name}'s site needs updating before they can be invited.`);
    return results.map((r) => ({ id: Number(r.id), person: String(r.identity) }));
  };
  try {
    if (op === "new") {
      const read = readEventForm(form, zone, { repeats: Boolean(group) });
      if (read.error) return fail(read.error);
      if (finishedAt(read.event) <= now()) return fail("That's already over: pick a time still to come.");
      const text = words(form.get("text"));
      if (text === null) return fail(`The words about it can be up to ${MAX_POST_TEXT} characters.`);
      // In a signed group (step 6c), an event is for everyone in it: nobody is picked.
      if (group) return Response.json({ event: plain(read.event), text });
      return Response.json({ event: plain(read.event), text, guests: await people(form.getAll("guest").map(String)) });
    }
    const item = group
      ? await db.prepare("SELECT content FROM copies WHERE id = ? AND group_id = ?").bind(String(form.get("item") ?? ""), group).first()
      : await db.prepare("SELECT content FROM items WHERE id = ? AND audience = 'invited'").bind(String(form.get("item") ?? "")).first();
    if (!item) return fail("That event isn't there any more.");
    const content = JSON.parse(String(item.content));
    const was = plain(content.event);
    if (op === "change") {
      const read = readEventForm(form, zone, { repeats: Boolean(group) });
      if (read.error) return fail(read.error);
      const text = words(form.get("text"));
      if (text === null) return fail(`The words about it can be up to ${MAX_POST_TEXT} characters.`);
      return Response.json({ event: plain(read.event), text });
    }
    if (op === "cancel") return Response.json({ event: { ...was, cancelled: true }, text: content.text ?? "" });
    if (group) return fail("That didn't work.");
    const { results } = await db.prepare("SELECT connection_id FROM item_guests WHERE item = ?").bind(String(form.get("item"))).all();
    const now_ = results.map((r) => Number(r.connection_id));
    const picked = form.getAll("guest").map(Number);
    const ids = op === "invite" ? [...now_, ...picked] : op === "uninvite" ? now_.filter((c) => !picked.includes(c)) : null;
    if (!ids) return fail("That didn't work.");
    return Response.json({ event: was, text: content.text ?? "", guests: await people(ids) });
  } catch (error) {
    if (error instanceof Refusal) return fail(error.message);
    throw error;
  }
}

// --- group events, on a member's site ----------------------------------------------------------------------------------

/** Someone named in an event's lists: their name, and the site they're from (if it's a proper site address). */
function person(p, env) {
  const name = typeof p?.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 100) || null : null;
  const from = typeof p?.id === "string" ? siteOrigin(p.id.replace(/\/$/, ""), env) : null;
  return { name, from };
}

/**
 * An event a group sent with a post, checked: the event (calendar.js parseEvent), who's going, who might, who can't,
 * how many were invited, and the owner here's own answer. Null if it isn't one.
 */
export function parseSharedEvent(o, env) {
  const event = parseEvent(o);
  if (!event) return null;
  const people = (list) => (Array.isArray(list) ? list.slice(0, MAX_PEOPLE) : []).map((p) => person(p, env)).filter((p) => p.name);
  const lists = (x) => ({ going: people(x["afterwrd:going"]), maybe: people(x["afterwrd:maybe"]), cantGo: people(x["afterwrd:cantGo"]),
    answer: ANSWERS.includes(x["afterwrd:answer"]) ? x["afterwrd:answer"] : null });
  const invited = o["afterwrd:invited"];
  // A repeating one (a group's): who's coming to each date, and the owner here's answer for it; only its own dates.
  const own = new Set(event.rrule ? ruleDates(event) : []);
  const dates = event.rrule ? (Array.isArray(o["afterwrd:dates"]) ? o["afterwrd:dates"].slice(0, 60) : [])
    .filter((d) => typeof d?.["afterwrd:date"] === "string" && own.has(d["afterwrd:date"]))
    .map((d) => ({ date: d["afterwrd:date"], ...lists(d) })) : [];
  return { ...event, ...(event.rrule ? { going: [], maybe: [], cantGo: [], answer: null } : lists(o)), dates: [...new Map(dates.map((d) => [d.date, d])).values()],
    invited: Number.isSafeInteger(invited) && invited >= 0 && invited <= 10_000 ? invited : null };
}

/** Lets go of copies of events from elsewhere long over. */
export const oldEventsGone = (db) => db.prepare(`DELETE FROM events_elsewhere AS e WHERE ${FINISHED_SQL} < ?`).bind(now() - KEEP_SECONDS);
