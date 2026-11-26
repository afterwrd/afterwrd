// How many mentions may reach the owner's phones (notes.js, groupcopies.js). Notes from friends' sites and groups'
// are notes.js and groupcopies.js; groups' old keyed notes (POST /_member/notify) went in step 6e.
import { daySecondsNow, LIMITS, rateWindow } from "./limits.js";

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
 * Whether an event's news (an invitation, a change, calling it off) just kept from a friend's site (`connection`) or a
 * group's (`group`) may reach the owner's phones too: as many as mentions may from one place, five in ten minutes and
 * twenty a day; past that it waits on Notifications (security review 2026-11 L5).
 * @param {D1Database} db @param {{ connection?: number | null, group?: number | null }} from
 */
export function eventsMayBuzz(db, { connection = null, group = null }) {
  const by = group === null ? "connection_id" : "group_id";
  return pushAllowed(db, `SELECT COUNT(*) AS n FROM notices WHERE ${by} = ?1 AND kind IN ('invite', 'changed', 'cancelled') AND created_at > ?2`,
    group ?? connection, Math.floor(Date.now() / 1000));
}

/**
 * Whether a mention by `author` that's just been kept may reach the owner's phones too: the first LIMITS.pushes a day
 * from one writer do, wherever they wrote (step 8), so one person can't keep a phone buzzing through several sites.
 * @param {D1Database} db @param {string} author
 */
export async function writerMayBuzz(db, author) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE author = ? AND kind IN ('mention', 'here') AND created_at > ?")
    .bind(author, Math.floor(Date.now() / 1000) - daySecondsNow()).first();
  return Number(row?.n ?? 0) <= LIMITS.pushes;
}
