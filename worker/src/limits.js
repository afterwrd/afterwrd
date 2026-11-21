// Rate limits' windows. (Answers from other sites were once limited here, in answer_log; signed answers are held to
// each list's caps instead: lists.js, and per-key allowances are step 8 of docs/signed-conversations.md.)

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
