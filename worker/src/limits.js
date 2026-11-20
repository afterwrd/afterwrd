// Answers to events and polls from other sites (friends answering the owner's, members answering in a group) are
// limited, as comments and notes are: an answer is a write, and a free plan has only so many a day. Each answer is
// logged (answer_log) only while its answerer is within their allowance, in the same transaction as the answer, and
// the answer is kept only if its log row was: so answers sent all at once can't slip past. The owner's own aren't.
import { now, randomToken } from "./util.js";

export const ANSWER_LIMIT = { count: 30, seconds: 600, daily: 200 };

// A scale test (test/scale: self-hosted, with TEST_SCALE) squeezes a day into an hour or two, so its rate limits' short
// windows (ten minutes, an hour) shrink by the same factor (TEST_SQUEEZE), or they'd bite that many times sooner than
// for real; so does how long Home's copy of a friend's posts counts as fresh (feed.js). Daily limits stay as they are: the test's day is one real day. Set by timing.js scaleTest, the only place
// that knows a site is a scale test's; each site runs in its own isolate there, so this is that site's. Always 1
// anywhere else.
let squeeze = 1;
/** @param {Record<string, any>} env */
export function squeezeFrom(env) {
  const factor = env?.TEST_SCALE && env.HOSTING === "self" ? Number(env.TEST_SQUEEZE) : 1;
  squeeze = factor > 1 ? factor : 1;
}
/** A rate limit's window (seconds), as long as it is, or shorter in a squeezed scale test (see above). */
export const rateWindow = (seconds) => Math.max(1, Math.round(seconds / squeeze));
export const TOO_MANY_ANSWERS = "That's a lot of answers for now. Try again later.";

/**
 * For one answer from `who` (their site): the statements that log it if they're within their allowance (and let go of
 * their log over a day old), to run first in the answer's batch; and its `token`, for ALLOWED_SQL.
 * @returns {{ statements: any[], token: string }}
 */
export function answerAllowance(db, who, at = now()) {
  const token = randomToken();
  return { token, statements: [
    db.prepare("DELETE FROM answer_log WHERE who = ? AND at < ?").bind(who, at - 86400),
    db.prepare(`INSERT INTO answer_log (who, token, at) SELECT ?1, ?2, ?3
      WHERE (SELECT COUNT(*) FROM answer_log WHERE who = ?1 AND at > ?3 - ?4) < ?5
        AND (SELECT COUNT(*) FROM answer_log WHERE who = ?1 AND at > ?3 - 86400) < ?6`)
      .bind(who, token, at, rateWindow(ANSWER_LIMIT.seconds), ANSWER_LIMIT.count, ANSWER_LIMIT.daily),
  ] };
}

/** SQL: the answer whose token is bound at `param` (say "?7") was within its answerer's allowance. */
export const ALLOWED_SQL = (param) => `EXISTS (SELECT 1 FROM answer_log WHERE token = ${param})`;

/** Whether the answer with this token was within its answerer's allowance (asked after its batch has run). */
export const wasAllowed = async (db, token) => Boolean(await db.prepare("SELECT 1 FROM answer_log WHERE token = ?").bind(token).first());
