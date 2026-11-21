// Notes from a group's Worker to its members' sites, so a member's site can say "something new" without asking every
// group in turn (until groups are signed too: docs/signed-conversations.md, step 6; friends' notes about signed posts
// are notes.js). Queued in the outbox (outbox.js), sent through POST /_member/notify: a group's Worker sends a comment on
// one of its posts to the members' sites whose owners wrote that post or commented on it (notifyGroupComment). New
// posts in a group aren't sent anywhere: members' sites read the group when they open it. A member's site keeps a note in `group_inbox` only if its
// owner wrote or commented on that post there (receiveGroupNote). The only other note a group sends is to those going
// to an event (or who might) when it changes or is called off (notifyEventChange); a member's site keeps it only if
// its owner still has plans for that event (events_elsewhere).
//
// Mentions (mentions.js): a post or comment in a group that mentions members (or everyone, for @here) tells each of them,
// with {type: "Create", object: {type: "Note", …, "afterwrd:mention": true, tag: [Mention…]}}; their site keeps it as
// kind 'mention' (or 'here'), and it may buzz their phones.
import { CONTEXT, groupPostId } from "../public/static/activity.js";
import { eventObject, eventWhen, hasDate, parseEvent } from "./calendar.js";
import { dateCopy, sameCopy } from "./membership.js";
import { outbox } from "./outbox.js";
import { now } from "./util.js";
import { HERE } from "./mentions.js";
import { rateWindow } from "./limits.js";

const SNIPPET = 200;
const KEEP_SECONDS = 60 * 86400;
const RATE = { count: 60, seconds: 600 }; // comment notes from one group
const DAILY = 500;
// Notes from a group about events the owner's going to: changed or called off. A handful is plenty.
const EVENT_RATE = { count: 10, seconds: 600, daily: 30 };

const snippet = (text, size = SNIPPET) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, size) : "");

/**
 * In a group's Worker: tells the members' sites that will want to know about a new comment (`id`) on `post`:
 * its writer's and those of everyone else who's commented on it, apart from the comment's own writer (`from`).
 */
export async function notifyGroupComment(env, site, group, post, { id, name, text, from, mentions = [] }) {
  // Not to those it mentions (or anyone, with @here): notifyGroupMentions tells them instead, once.
  if (mentions.some((m) => m.origin === HERE)) return;
  // Looked up from the few who'd be told (by group_id and origin, the members' index), not by reading every member.
  const { results } = await env.DB.prepare(`SELECT id FROM group_members WHERE group_id = ?1
    AND origin IN (SELECT ?3 UNION SELECT origin FROM group_comments WHERE post_id = ?4 AND origin IS NOT NULL)
    AND approved_at IS NOT NULL AND origin != ?2 AND origin NOT IN (SELECT value FROM json_each(?5)) ORDER BY id`)
    .bind(group.id, from, post.origin, post.id, JSON.stringify(mentions.map((m) => m.origin))).all();
  if (!results.length) return;
  const address = groupPostId(site, group.id, post.id);
  await outbox(env).sendToMembers(results.map((r) => r.id), { "@context": CONTEXT, type: "Create", object: { type: "Note",
    id: `${address}#c${id}`, inReplyTo: address, content: snippet(text), attributedTo: { type: "Person", name: snippet(name, 100) } } });
}

/**
 * In a group's Worker: tells the members a post (or, with `comment`, a comment on it) mentions that it does, or, for
 * @here, every member, apart from its writer (`from`). `mentions` are only of members already (groups.js).
 * @param {any} env
 * @param {string} site
 * @param {any} group
 * @param {{ id: number }} post
 * @param {{ comment?: number | null, name: string, text: string, mentions: import("./mentions.js").Mention[], from: string }} what
 */
export async function notifyGroupMentions(env, site, group, post, { comment = null, name, text, mentions, from }) {
  const db = env.DB;
  const here = mentions.some((m) => m.origin === HERE);
  // Someone mentioned by the same member more than a few times a day isn't told again (it's kept, and shown, all the
  // same), so one member can't use up what that person's site will take from the group (receiveGroupMention).
  const named = mentions.filter((m) => m.origin !== HERE).map((m) => m.origin);
  const { results: counted } = named.length ? await db.prepare(`SELECT j.value AS origin,
      (SELECT COUNT(*) FROM group_posts WHERE origin = ?1 AND created_at > ?2 AND instr(mentions, '"origin":' || json_quote(j.value)) > 0)
      + (SELECT COUNT(*) FROM group_comments WHERE origin = ?1 AND created_at > ?2 AND instr(mentions, '"origin":' || json_quote(j.value)) > 0) AS n
    FROM json_each(?3) j`).bind(from, now() - 86400, JSON.stringify(named)).all() : { results: [] };
  const people = counted.filter((r) => r.n <= MENTION_PAIR_DAILY).map((r) => r.origin);
  if (!here && !people.length) return;
  // Everyone for @here; otherwise only those named, looked up by the members' index rather than reading every member.
  const { results } = await (here
    ? db.prepare("SELECT id FROM group_members WHERE group_id = ?1 AND approved_at IS NOT NULL AND origin != ?2 ORDER BY id").bind(group.id, from)
    : db.prepare(`SELECT id FROM group_members WHERE group_id = ?1 AND origin IN (SELECT value FROM json_each(?3))
      AND approved_at IS NOT NULL AND origin != ?2 ORDER BY id`).bind(group.id, from, JSON.stringify(people))).all();
  if (!results.length) return;
  const address = groupPostId(site, group.id, post.id);
  await outbox(env).sendToMembers(results.map((r) => r.id), { "@context": CONTEXT, type: "Create", object: { type: "Note",
    ...(comment ? { id: `${address}#c${comment}` } : {}), inReplyTo: address, content: snippet(text),
    attributedTo: { type: "Person", name: snippet(name, 100) }, "afterwrd:mention": true, ...(here && { "afterwrd:here": true }) } });
}

/**
 * In a group's Worker: tells the sites of the members going to an event, or who might, that it's changed or been
 * called off (`kind`), apart from whoever did it (`from`). With `date`, it's about that date of a repeating event,
 * and goes to those going to that date. Nothing else about events is sent to anyone.
 */
export async function notifyEventChange(env, site, group, post, event, { kind, name, from, date = null }) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT m.id FROM group_members m JOIN group_answers a ON a.origin = m.origin AND a.post_id = ?1
    WHERE m.group_id = ?2 AND m.approved_at IS NOT NULL AND m.origin != ?3 AND a.answer IN ('going', 'maybe') AND (?4 IS NULL OR a.date = ?4)
    ORDER BY m.id`).bind(post.id, group.id, from, date).all();
  if (!results.length) return;
  await outbox(env).sendToMembers(results.map((r) => r.id), { "@context": CONTEXT, type: "Update", "afterwrd:change": kind,
    actor: { type: "Person", name: snippet(name, 100) }, "afterwrd:date": date ?? undefined,
    object: { type: "Note", id: groupPostId(site, group.id, post.id), "afterwrd:event": eventObject(event) } });
}

/**
 * A group's note that an event the owner here is going to (or might) has changed or been called off: their copy of
 * it is brought up to date, the note kept, and the owner's devices told (`tell`). Ignored if they've no plans for it.
 * @param {any} db
 * @param {any} group
 * @param {any} note
 * @param {(notice: import("./push.js").Notice) => void} tell
 * @returns {Promise<import("./util.js").Answer>}
 */
async function receiveEventNote(db, group, note, tell) {
  const prefix = groupPostId(group.origin, group.remote_id, "");
  const id = typeof note.object?.id === "string" && note.object.id.startsWith(prefix) ? note.object.id.slice(prefix.length) : "";
  const event = parseEvent(note.object?.["afterwrd:event"]);
  const kind = note["afterwrd:change"];
  // About one date of a repeating event (that date called off), or about the whole of it.
  const date = typeof note["afterwrd:date"] === "string" ? note["afterwrd:date"] : null;
  // A note about one date only calls that date off: changes are always to the whole of it.
  if (!/^\d{1,15}$/.test(id) || !event || (kind !== "changed" && kind !== "cancelled")
    || (date !== null && (kind !== "cancelled" || !event.rrule || !hasDate(event, date)))) {
    return [{ error: "That isn't about an event in this group." }, 400];
  }
  const at = now();
  if (kind === "cancelled" && date === null) event.cancelled_at ??= at;
  // An event the owner here added keeps their own words, time, place and repeat: the group can only say it's off.
  const mine = await db.prepare("SELECT event FROM group_mine WHERE site = ? AND remote_group = ? AND kind = 'post' AND remote_id = ?")
    .bind(group.origin, group.remote_id, Number(id)).first();
  let kept = null;
  try { kept = JSON.parse(mine?.event ?? "null"); } catch {}
  if (mine && kept) {
    if (kind !== "cancelled") return [{ ok: true }, 202]; // their own change: nothing to tell them
    Object.assign(event, { title: kept.title, starts_at: kept.starts_at, ends_at: kept.ends_at, all_day: kept.all_day,
      time_zone: kept.time_zone, place: kept.place, rrule: kept.rrule ?? null });
  }
  // The owner's copies of the dates they're going to (one date, if that's what it's about).
  const { results: copies } = await db.prepare(`SELECT * FROM events_elsewhere WHERE group_id = ? AND post_id = ?${date === null ? "" : " AND date = ?"}`)
    .bind(group.id, Number(id), ...(date === null ? [] : [date])).all();
  if (!copies.length) return [{ ok: true }, 202];
  // What the note says: the date it's about, or the next of theirs (or the event's first).
  const shown = (date !== null ? dateCopy(event, date) : copies.length === 1 ? dateCopy(event, copies[0].date) : null) ?? event;
  const words = `${event.title} · ${eventWhen(shown)}${event.place ? ` · ${event.place}` : ""}`;
  // Counted apart from comments, and far fewer: event news can't crowd out comments, or become a stream of nags. The
  // allowance is checked (and the note kept) first: over it, nothing at all is written.
  const row = await db.prepare(`INSERT INTO group_inbox (group_id, post_id, actor, text, created_at, kind, date)
    SELECT ?1, ?2, ?3, ?4, ?5, ?9, ?10
    WHERE (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IS NOT NULL AND created_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IS NOT NULL AND created_at > ?5 - 86400) < ?8
    RETURNING id`).bind(group.id, Number(id), snippet(note.actor?.name, 100) || "Someone", snippet(words, 400), at,
    rateWindow(EVENT_RATE.seconds), EVENT_RATE.count, EVENT_RATE.daily, kind, date).first();
  if (!row) return [{ error: "That's a lot of notes for now." }, 429];
  tell({
    title: group.name,
    text: `${kind === "changed" ? "Changed" : date !== null ? "One date called off" : "Called off"}: ${words}`,
    hidden: kind === "changed" ? "An event you're going to has changed" : "An event you're going to is off",
    url: `/groups/${group.id}/posts/${Number(id)}${date !== null ? `?date=${encodeURIComponent(date)}` : ""}`,
    tag: `group-${group.id}-${Number(id)}`,
  });
  // Then each copy brought up to date, if it's changed; a date the event no longer has is let go.
  const writes = copies.flatMap((c) => {
    const fresh = dateCopy(event, c.date);
    if (!fresh) return [db.prepare("DELETE FROM events_elsewhere WHERE id = ?").bind(c.id)];
    const copy = date !== null ? { ...fresh, cancelled_at: c.cancelled_at ?? at } : fresh;
    if (sameCopy(c, copy)) return [];
    return [db.prepare(`UPDATE events_elsewhere SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, time_zone = ?, place = ?,
      cancelled_at = ?, updated_at = ? WHERE id = ?`).bind(copy.title, copy.starts_at, copy.ends_at, copy.all_day, copy.time_zone, copy.place,
      copy.cancelled_at ?? null, at, c.id)];
  });
  if (writes.length) await db.batch(writes);
  return [{ ok: true }, 202];
}

/**
 * A note from a group the owner here is in: kept, ignored, or refused. Returns [body, status]. `tell`: as for
 * receiveNote, about a change to an event the owner's going to.
 * @param {any} db
 * @param {any} group
 * @param {any} note
 * @param {(notice: import("./push.js").Notice) => void} [tell]
 * @returns {Promise<import("./util.js").Answer>}
 */
export async function receiveGroupNote(db, group, note, tell = () => {}) {
  if (note?.type === "Update" && note.object?.type === "Note") return receiveEventNote(db, group, note, tell);
  const object = note?.type === "Create" && note.object?.type === "Note" ? note.object : null;
  const prefix = groupPostId(group.origin, group.remote_id, "");
  const post = typeof object?.inReplyTo === "string" && object.inReplyTo.startsWith(prefix) ? object.inReplyTo.slice(prefix.length) : "";
  if (!/^\d{1,15}$/.test(post)) return [{ error: "That isn't about a post in this group." }, 400];
  if (object["afterwrd:mention"] === true) return receiveGroupMention(db, group, Number(post), object, tell);
  // Only news if the owner here wrote that post or commented on it.
  if (!(await db.prepare("SELECT 1 FROM group_mine WHERE site = ? AND remote_group = ? AND post_id = ? LIMIT 1")
    .bind(group.origin, group.remote_id, Number(post)).first())) {
    return [{ ok: true }, 202];
  }
  const at = now();
  const row = await db.prepare(`INSERT INTO group_inbox (group_id, post_id, actor, text, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IS NULL AND created_at > ?5 - ?6) < ?7
      AND (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IS NULL AND created_at > ?5 - 86400) < ?8
    RETURNING id`).bind(group.id, Number(post), snippet(object.attributedTo?.name, 100) || "Someone", snippet(object.content) || null,
    at, rateWindow(RATE.seconds), RATE.count, DAILY).first();
  await db.prepare("DELETE FROM group_inbox WHERE created_at < ? OR group_id NOT IN (SELECT id FROM groups)").bind(at - KEEP_SECONDS).run();
  return row ? [{ ok: true }, 202] : [{ error: "That's a lot of notes for now." }, 429];
}

// In a group's Worker: how many times a day one member's mentions of the same person tell them (notifyGroupMentions).
const MENTION_PAIR_DAILY = 5;
// Mentions from one group (and @here there): plenty for a group of friends, few enough that it can't flood a phone.
const MENTION_RATE = { count: 20, seconds: 600, daily: 60 };
// Of those kept (from one friend's site, or one group), how many may reach the owner's phones: the rest wait quietly on
// Notifications. `sql` counts those kept so far, including the one just kept, since ?2 (with ?1 who from, and ?3
// anything else it needs).
export const MENTION_PUSH = { count: 5, seconds: 600, daily: 20 };
export async function pushAllowed(db, sql, from, at, more = null) {
  const [recent, today] = await db.batch([
    db.prepare(sql).bind(from, at - rateWindow(MENTION_PUSH.seconds), ...(more === null ? [] : [more])),
    db.prepare(sql).bind(from, at - 86400, ...(more === null ? [] : [more])),
  ]);
  return recent.results[0].n <= MENTION_PUSH.count && today.results[0].n <= MENTION_PUSH.daily;
}

/**
 * A group saying a post or comment there mentions the owner here, or is to everyone (@here, notifyGroupMentions):
 * kept as kind 'mention' or 'here', within limits of its own, and said on the owner's devices that take mentions.
 * @returns {Promise<import("./util.js").Answer>}
 */
async function receiveGroupMention(db, group, post, object, tell) {
  const here = object["afterwrd:here"] === true;
  const actor = snippet(object.attributedTo?.name, 100) || "Someone";
  const text = snippet(object.content);
  const at = now();
  const row = await db.prepare(`INSERT INTO group_inbox (group_id, post_id, actor, text, created_at, kind)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IN ('mention', 'here') AND created_at > ?5 - ?7) < ?8
      AND (SELECT COUNT(*) FROM group_inbox WHERE group_id = ?1 AND kind IN ('mention', 'here') AND created_at > ?5 - 86400) < ?9
    RETURNING id`).bind(group.id, post, actor, text || null, at, here ? "here" : "mention",
    rateWindow(MENTION_RATE.seconds), MENTION_RATE.count, MENTION_RATE.daily).first();
  if (!row) return [{ error: "That's a lot of mentions for now." }, 429];
  if (await pushAllowed(db, "SELECT COUNT(*) AS n FROM group_inbox WHERE group_id = ?1 AND kind IN ('mention', 'here') AND created_at > ?2", group.id, at)) {
    tell({ kind: "mention", title: group.name, text: `${actor} ${here ? "to everyone" : "mentioned you"}: ${text}`,
      hidden: here ? "Wrote to everyone (@here)" : "Mentioned you", url: `/groups/${group.id}/posts/${post}`,
      tag: `mention-g${group.id}-${post}` });
  }
  return [{ ok: true }, 202];
}
