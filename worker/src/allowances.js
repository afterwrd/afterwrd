// What other sites may ask of this one in a day, and how busy the site has been (step 8 of
// docs/signed-conversations.md, "8 in detail").
//
// Serving allowances: each site calling this one (by its owner's identity, once their signature has checked) may make
// LIMITS.calls calls a day and have LIMITS.rows rows read for it, counted in this object's memory, so counting costs no
// rows. A caller past a quarter of either is also saved (`allowances`), at most every ten minutes, so letting the
// object go to sleep doesn't start them afresh. Past it, every call is refused (429, with when to try again) until the
// day ends, at midnight UTC as Cloudflare's own limits do. Refused calls still count towards Cloudflare's daily
// requests, so this holds back a buggy or greedy site, not a determined one (section 10).
//
// Usage: what the site's own object has done today (limits.js usage), saved to `usage` at most every ten minutes, on
// Cloudflare only (self-hosted sites have no daily limits). A group's site reports its own to its owner's site with
// each pull (groupposts.js, groupcopies.js); the owner's site adds them up, and Home says so calmly if the account
// has been over half of a daily limit on three days in a week (decision 13).
import { ACCOUNT, dayOf, LIMITS, nextDayAt, usage } from "./limits.js";
import { noteCaller, requestCaller } from "./timing.js";
import { selfHosted } from "./hosting.js";
import { now, Refusal } from "./util.js";

const SAVE_SECONDS = 600;
const KEEP_DAYS = 8;
const BUSY_DAYS = 3; // of the last 7

/** A call past its caller's allowance: answered 429, with `retry` (when the day ends). */
export class OverAllowance extends Refusal {
  /** @param {number} retry */
  constructor(retry) {
    super("This site has had a lot of requests from yours today. Try again tomorrow.", 429, { retry });
  }
}

/** @type {Map<string, { day: number, calls: number, rows: number, savedAt: number }>} */
const callers = new Map();
let loadedDay = -1;
let usageSavedAt = 0;

const quarter = (c) => c.calls * 4 >= LIMITS.calls || c.rows * 4 >= LIMITS.rows;

function entry(person, day) {
  let c = callers.get(person);
  if (!c || c.day !== day) {
    c = { day, calls: 0, rows: 0, savedAt: 0 };
    callers.set(person, c);
  }
  return c;
}

/**
 * Lets a call from `person` (a friend's site, a member's, a group's, a writer's) go on, counting it; or throws
 * OverAllowance (app.js answers it). The rows the call reads are charged at the end (settle).
 * @param {{ DB: D1Database }} env @param {string | null | undefined} person
 */
export async function admit(env, person) {
  if (!person) return;
  const at = now();
  const day = dayOf(at);
  if (loadedDay !== day) {
    // Callers already busy today, from before this object last slept: one read, once a day.
    loadedDay = day;
    for (const [p, c] of callers) if (c.day !== day) callers.delete(p);
    const { results } = await env.DB.prepare("SELECT person, calls, rows FROM allowances WHERE day = ?").bind(day).all();
    for (const r of results) {
      const c = entry(String(r.person), day);
      c.calls = Math.max(c.calls, Number(r.calls));
      c.rows = Math.max(c.rows, Number(r.rows));
    }
  }
  const c = entry(person, day);
  if (c.calls >= LIMITS.calls || c.rows >= LIMITS.rows) throw new OverAllowance(nextDayAt(at));
  c.calls++;
  noteCaller(person);
}

/**
 * At the end of a request (app.js): its rows charged to whoever it was from, a busy caller's count saved now and then,
 * and today's usage saved now and then.
 * @param {{ DB: D1Database, HOSTING?: string }} env
 */
export async function settle(env) {
  const at = now();
  const done = requestCaller();
  if (done?.person) {
    const c = entry(done.person, dayOf(at));
    c.rows += done.rows;
    if (quarter(c) && at - c.savedAt >= SAVE_SECONDS) {
      c.savedAt = at;
      await env.DB.prepare(`INSERT INTO allowances (person, day, calls, rows) VALUES (?, ?, ?, ?)
        ON CONFLICT (person) DO UPDATE SET day = excluded.day, calls = excluded.calls, rows = excluded.rows`).bind(done.person, c.day, c.calls, c.rows).run();
    }
  }
  if (selfHosted(env) || at - usageSavedAt < SAVE_SECONDS) return;
  usageSavedAt = at;
  await keepUsage(env.DB);
}

/** What's counted in memory and not saved yet, saved (`usage`, the site's own row: site ''), and old rows gone. */
async function keepUsage(db) {
  const days = [...usage.earlier.splice(0)];
  const { day, requests, read, written, saved } = usage;
  if (day >= 0 && (requests > saved.requests || read > saved.read || written > saved.written)) {
    days.push({ day, requests: requests - saved.requests, read: read - saved.read, written: written - saved.written });
    usage.saved = { requests, read, written };
  }
  if (!days.length) return;
  await db.batch([
    ...days.map((d) => db.prepare(`INSERT INTO usage (day, site, requests, rows_read, rows_written) VALUES (?, '', ?, ?, ?)
      ON CONFLICT (day, site) DO UPDATE SET requests = requests + excluded.requests, rows_read = rows_read + excluded.rows_read,
      rows_written = rows_written + excluded.rows_written`).bind(d.day, d.requests, d.read, d.written)),
    db.prepare("DELETE FROM usage WHERE day < ?").bind(dayOf() - KEEP_DAYS),
    db.prepare("DELETE FROM allowances WHERE day < ?").bind(dayOf()),
  ]);
}

/**
 * The site's own usage for the last 7 days, today's with what's in memory and not saved yet: [{day, requests, read,
 * written}]. What a group's site reports to its owner's (groupposts.js).
 * @param {D1Database} db
 */
export async function ownUsage(db) {
  const from = dayOf() - 6;
  const { results } = await db.prepare("SELECT day, requests, rows_read, rows_written FROM usage WHERE site = '' AND day >= ? ORDER BY day").bind(from).all();
  const days = new Map(results.map((r) => [Number(r.day), { day: Number(r.day), requests: Number(r.requests), read: Number(r.rows_read), written: Number(r.rows_written) }]));
  for (const d of [...usage.earlier, usage.day >= from ? {
    day: usage.day, requests: usage.requests - usage.saved.requests, read: usage.read - usage.saved.read, written: usage.written - usage.saved.written,
  } : null]) {
    if (!d || d.day < from) continue;
    const kept = days.get(d.day) ?? { day: d.day, requests: 0, read: 0, written: 0 };
    days.set(d.day, { day: d.day, requests: kept.requests + d.requests, read: kept.read + d.read, written: kept.written + d.written });
  }
  return [...days.values()];
}

/**
 * A group's figures (as its site reported them with a pull: groupcopies.js), kept as its rows here, `group:<id>`. Only
 * days that changed are written.
 * @param {D1Database} db @param {number} groupId @param {any} reported
 */
export async function keepGroupUsage(db, groupId, reported) {
  if (!Array.isArray(reported)) return;
  const from = dayOf() - 6;
  const days = reported.slice(0, 7).filter((d) => Number.isSafeInteger(d?.day) && d.day >= from && d.day <= dayOf()
    && [d.requests, d.read, d.written].every((n) => Number.isSafeInteger(n) && n >= 0));
  if (!days.length) return;
  await db.batch(days.map((d) => db.prepare(`INSERT INTO usage (day, site, requests, rows_read, rows_written) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, site) DO UPDATE SET requests = excluded.requests, rows_read = excluded.rows_read, rows_written = excluded.rows_written
    WHERE requests != excluded.requests OR rows_read != excluded.rows_read OR rows_written != excluded.rows_written`)
    .bind(d.day, `group:${groupId}`, d.requests, d.read, d.written)));
}

/**
 * Whether the owner's Cloudflare account has been busy: over half of any daily limit (ACCOUNT) on BUSY_DAYS of the last
 * 7, adding up this site and its groups. Null if not (and always self-hosted); otherwise {days, sources: [{name,
 * share}]}, each one's share of the week's busiest measure, largest first.
 * @param {{ DB: D1Database, HOSTING?: string }} env
 */
export async function busyAccount(env) {
  if (selfHosted(env)) return null;
  const db = env.DB;
  const from = dayOf() - 6;
  const own = await ownUsage(db);
  const { results } = await db.prepare(`SELECT u.day, u.site, u.requests, u.rows_read, u.rows_written, g.name FROM usage u
    LEFT JOIN groups g ON u.site = 'group:' || g.id WHERE u.site != '' AND u.day >= ?`).bind(from).all();
  const rows = [...own.map((d) => ({ ...d, name: null })),
    ...results.map((r) => ({ day: Number(r.day), requests: Number(r.requests), read: Number(r.rows_read), written: Number(r.rows_written), name: r.name ?? "a group" }))];
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { requests: 0, read: 0, written: 0 };
    byDay.set(r.day, { requests: d.requests + r.requests, read: d.read + r.read, written: d.written + r.written });
  }
  const measures = /** @type {const} */ (["requests", "read", "written"]);
  const busy = [...byDay].filter(([, d]) => measures.some((m) => d[m] * 2 > ACCOUNT[m])).map(([day]) => day);
  if (busy.length < BUSY_DAYS) return null;
  // Which measure came nearest its limit on the busy days, and who used it.
  const total = (m) => busy.reduce((n, day) => n + byDay.get(day)[m] / ACCOUNT[m], 0);
  const measure = measures.reduce((a, b) => (total(b) > total(a) ? b : a));
  const bySource = new Map();
  for (const r of rows.filter((r) => busy.includes(r.day))) bySource.set(r.name, (bySource.get(r.name) ?? 0) + r[measure]);
  const sum = [...bySource.values()].reduce((a, b) => a + b, 0) || 1;
  const sources = [...bySource].map(([name, n]) => ({ name, share: Math.round((n / sum) * 100) })).filter((s) => s.share > 0)
    .sort((a, b) => b.share - a.share);
  return { days: busy.length, sources };
}
