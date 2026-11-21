// How many mentions may reach the owner's phones (notes.js, groupcopies.js). Notes from friends' sites and groups'
// are notes.js and groupcopies.js; groups' old keyed notes (POST /_member/notify) went in step 6e.
import { rateWindow } from "./limits.js";

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
