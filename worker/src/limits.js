// Rate limits' windows. (Answers from other sites were once limited here, in answer_log; signed answers are held to
// each list's caps instead: lists.js, and per-key allowances are step 8 of docs/signed-conversations.md.)

// A scale test (test/scale: self-hosted, with TEST_SCALE) squeezes a day into an hour or a few, so its rate limits' short
// windows (ten minutes, an hour) shrink by the same factor (TEST_SQUEEZE), or they'd bite that many times sooner than
// for real; so do the hourly pulls of friends' and groups' sites (friendcopies.js, groupcopies.js) and the background
// checks' schedule (sentchecks.js), so the squeezed day does a day's work; and the daily limits' day (allowances, caps)
// is the squeezed one. Set by timing.js scaleTest, the only place
// that knows a site is a scale test's; each site runs in its own isolate there, so this is that site's. Always 1
// anywhere else.
let squeeze = 1;
/** @param {Record<string, any>} env */
export function squeezeFrom(env) {
  const factor = env?.TEST_SCALE && env.HOSTING === "self" ? Number(env.TEST_SQUEEZE) : 1;
  squeeze = factor > 1 ? factor : 1;
  // The daily limits' day too, so a squeezed day's limits are a day's, and the days before it (setting up) don't count.
  if (squeeze > 1) daySeconds = Math.round(86400 / squeeze);
}
/** A rate limit's window (seconds), as long as it is, or shorter in a squeezed scale test (see above). */
export const rateWindow = (seconds) => Math.max(1, Math.round(seconds / squeeze));

// --- Daily limits (step 8 of docs/signed-conversations.md, "8 in detail") ----------------------------------------------
//
// calls, rows: each caller's allowance on this site a day (allowances.js), by their identity: 2% of the account's
//   requests and 1% of its reads. records: the records one writer's site may leave here a day, across every post (on
//   top of 20 an item: lists.js). notices, pushes: what one writer may set off on the owner's Notifications, and on
//   their phones, a day, across every friend's site and group (notes.js).
export const LIMITS = { calls: 2000, rows: 50_000, records: 200, notices: 20, pushes: 5 };
// The free plan's daily limits for a whole Cloudflare account, which the busy-account warning measures against.
export const ACCOUNT = { requests: 100_000, read: 5_000_000, written: 100_000 };
let daySeconds = 86400;

/**
 * Local test sites only (app.js, with ALLOW_LOCAL_SITES): smaller limits (TEST_LIMITS, as "calls=40,records=3") and a
 * shorter day (TEST_DAY_SECONDS), so a test can reach them and see a day end.
 * @param {Record<string, any>} env
 */
export function testLimits(env) {
  if (!env?.ALLOW_LOCAL_SITES) return;
  for (const pair of String(env.TEST_LIMITS ?? "").split(",")) {
    const [name, value] = pair.split("=");
    if (name in LIMITS && Number.isSafeInteger(Number(value)) && Number(value) > 0) LIMITS[name] = Number(value);
  }
  const day = Number(env.TEST_DAY_SECONDS);
  if (Number.isSafeInteger(day) && day > 0) daySeconds = day;
}

/** The day `at` (seconds) is in: UTC days, as Cloudflare's limits are. */
export const dayOf = (at = Math.floor(Date.now() / 1000)) => Math.floor(at / daySeconds);
/** When the day after `at`'s starts. */
export const nextDayAt = (at = Math.floor(Date.now() / 1000)) => (dayOf(at) + 1) * daySeconds;
/** Seconds in a day (shorter on a test site). */
export const daySecondsNow = () => daySeconds;

// What this object has done today, counted in memory, so counting costs nothing: requests answered, and rows read and
// written by SQLite (sqlite.js). `saved`: how much of it is in the `usage` table already (allowances.js keepCounts);
// `earlier`: a previous day's not yet saved, when the day turned over before it was.
export const usage = { day: -1, requests: 0, read: 0, written: 0, saved: { requests: 0, read: 0, written: 0 }, earlier: /** @type {any[]} */ ([]) };
function today() {
  const day = dayOf();
  if (usage.day !== day) {
    const { requests, read, written, saved } = usage;
    if (usage.day >= 0 && (requests > saved.requests || read > saved.read || written > saved.written)) {
      usage.earlier.push({ day: usage.day, requests: requests - saved.requests, read: read - saved.read, written: written - saved.written });
    }
    Object.assign(usage, { day, requests: 0, read: 0, written: 0, saved: { requests: 0, read: 0, written: 0 } });
  }
  return usage;
}
/** A request answered by this object. */
export function countRequest() { today().requests++; }
/** Rows SQLite read and wrote for one statement (sqlite.js runStatements). */
export function countRows(read, written) {
  const u = today();
  u.read += Number(read) || 0;
  u.written += Number(written) || 0;
}
