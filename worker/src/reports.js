// Telling whoever runs a space about something in it (docs/safety-plan.md 3.3): "Tell the admins" on a post or comment
// in a group, and "Tell Ann" on someone else's comment on Ann's post. Never to anyone central, and never to the person
// reported. A report isn't a record in any list: it's a signed call from the reporter's site (calls.js), which is all
// the proof it needs, since nobody else ever reads it.
//
// On the site holding what's reported (a group's, or the person's whose post it's on):
//   POST /_p/report           {item, about, reason, note?, named}: kept, with a copy of what was said; answers {id}
//   POST /_p/reports/check    {ids}: what became of each ({id, outcome, word}), for the reporter's site: unsigned, as
//                             a report's id is its own secret (app.js), so it doesn't say again who reported
// and, for a group's owner and admins (groups.js):
//   GET  /_group/admin/reports            what's been raised, newest first, grouped by what it's about
//   POST /_group/admin/reports/leave      {about, word?}: looked at, and left
// A removal of what was reported (lists.js), or of its writer from the group (groupmembers.js), deals with it too.
//
// Who reported is kept only if they chose to be named (ticked by default); otherwise nothing on this site says who. The
// daily caps (DAILY a reporter, once a thing) are kept under the day's salted hashes (report_caps), so they hold across
// restarts without naming anyone. Whoever runs a site can still change its code: nothing here pretends otherwise.
// A report about an admin's own post or comment goes to the others who run the group, never to them.
//
// On the reporter's own site: reports_sent, asked about hourly (checkSentReports), with a quiet notice when one's dealt
// with, and, for "might be illegal" left a few days, where else to turn (Getting help).
import { safeNext } from "./auth.js";
import { callFriend } from "./calls.js";
import { listEntries } from "./hosted.js";
import { keepNotice } from "./notes.js";
import { html, json, now, randomToken, sha256 } from "./util.js";
import { messagePage } from "./views/pages.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";

export const REASONS = /** @type {const} */ ({
  unkind: "Unkind or bullying",
  wrong: "Not right here",
  spam: "Spam",
  illegal: "Might be illegal",
  other: "Something else",
});
export const MAX_NOTE = 500;
export const MAX_WORD = 300;
const DAILY = 10; // reports from one person to one site in a day
const LATE_SECONDS = 3 * 86400; // "might be illegal" not looked at by then: the reporter is told where else to turn
const KEEP_SECONDS = 90 * 86400; // after it's dealt with
const SHOWN_SECONDS = 30 * 86400; // dealt-with reports still listed for those running the space
const CHECK_SECONDS = 3600;
const ILLEGAL_PUSHES = 3; // phone notifications a day from one space for "might be illegal"
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const REPORT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PER_THING = 20; // open reports kept about one thing; more are answered with one already there
const LISTED = 200; // things listed on Things to look at (every open one first)

// --- the host's side --------------------------------------------------------------------------------------------------

const dayNow = () => Math.floor(Date.now() / 86_400_000);

/**
 * The day's caps for `reporter` reporting `about`: why not, or null (and counted). Kept under SHA-256 of the day's
 * random salt with the person (and the thing), so they last through restarts and updates but name nobody; the salt
 * and yesterday's rows go with today's first report.
 */
async function overCap(db, reporter, about) {
  const day = dayNow();
  const fresh = `${day}:${randomToken()}`;
  await db.batch([
    db.prepare(`INSERT INTO settings (key, value) VALUES ('report_salt', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE substr(settings.value, 1, instr(settings.value, ':') - 1) != ?2`).bind(fresh, String(day)),
    db.prepare("DELETE FROM report_caps WHERE day < ?").bind(day),
  ]);
  const salt = String((await db.prepare("SELECT value FROM settings WHERE key = 'report_salt'").first())?.value ?? fresh);
  const [person, pair] = await Promise.all([sha256(`${salt} ${reporter}`), sha256(`${salt} ${reporter} ${about}`)]);
  if (!(await db.prepare("INSERT INTO report_caps (key, n, day) VALUES (?, 1, ?) ON CONFLICT(key) DO NOTHING RETURNING n").bind(pair, day).first())) {
    return { error: "You've told them about this already.", status: 409 };
  }
  const counted = await db.prepare(`INSERT INTO report_caps (key, n, day) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET n = n + 1
    WHERE report_caps.n < ?3 RETURNING n`).bind(person, day, DAILY).first();
  return counted ? null : { error: "That's a lot for one day. Try again tomorrow.", status: 429 };
}

/**
 * Reports whose post or comment has gone with its list (a whole post deleted or removed, its photos with it) are dealt
 * with as removed; and what was dealt with long enough ago goes, copy and all.
 */
async function tidyReports(db) {
  const at = now();
  await db.batch([
    db.prepare(`UPDATE reports SET handled_at = ?, outcome = 'removed' WHERE handled_at IS NULL
      AND item IN (SELECT id FROM lists WHERE deleted_at IS NOT NULL)`).bind(at),
    db.prepare("DELETE FROM reports WHERE handled_at IS NOT NULL AND handled_at < ?").bind(at - KEEP_SECONDS),
  ]);
}

/**
 * A report from `reporter` (a person id; `reporterName`, as this site knows them) about record `about` on list `item`.
 * `refuse(record)`: why this host won't take a report about that record, or null (a person's site: only comments by
 * others on the owner's posts; a group's: not when there's nobody to tell but its writer). Returns {id, reason, item,
 * author} or {error, status}.
 * @param {any} env @param {{ reporter: string, reporterName: string, body: any, refuse: (record: any) => Promise<string | null> }} what
 */
export async function takeReport(env, { reporter, reporterName, body, refuse }) {
  const db = env.DB;
  const item = String(body?.item ?? "");
  const about = String(body?.about ?? "");
  const reason = String(body?.reason ?? "");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : "";
  if (!ID_RE.test(item) || !ID_RE.test(about) || !Object.hasOwn(REASONS, reason)) return { error: "That didn't work.", status: 400 };
  const entry = (await listEntries(db, item)).find((e) => e.fp === about);
  const record = entry?.sent ? parseSent(entry.sent) : null;
  if (!record) return { error: "That isn't there any more.", status: 404 };
  if (record.record.author === reporter) return { error: "That's yours.", status: 400 };
  const refused = await refuse(record.record);
  if (refused) return { error: refused, status: 400 };
  // Once a thing (a named report, for good; any, for the day), and so many a day from one person.
  if (await db.prepare("SELECT 1 FROM reports WHERE reporter = ? AND about = ?").bind(reporter, about).first()) {
    return { error: "You've told them about this already.", status: 409 };
  }
  const over = await overCap(db, reporter, about);
  if (over) return over;
  await tidyReports(db);
  const author = String(record.record.author);
  // Plenty open about it already: answered with one of those, whose outcome is this one's too.
  const open = await db.prepare("SELECT id, COUNT(*) OVER () AS n FROM reports WHERE about = ? AND handled_at IS NULL ORDER BY created_at LIMIT 1").bind(about).first();
  if (open && Number(open.n) >= PER_THING) return { id: String(open.id), reason, item, author };
  const named = body?.named !== false;
  const id = randomToken();
  // What it said, kept once for each thing.
  const first = !(await db.prepare("SELECT 1 FROM reports WHERE about = ? LIMIT 1").bind(about).first());
  const copy = first ? { kind: record.record.kind, text: String(record.content?.text ?? "").slice(0, 5000),
    photos: Array.isArray(record.content?.photos) ? record.content.photos.length : 0 } : null;
  await db.prepare(`INSERT INTO reports (id, item, about, author, reason, note, reporter, reporter_name, copy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, item, about, author, reason, note || null,
    named ? reporter : null, named ? String(reporterName).slice(0, 100) : null, JSON.stringify(copy), now()).run();
  return { id, reason, item, author };
}

/** The record and its content, from an entry as stored ({record, sig, content, salt}), or null. */
function parseSent(sent) {
  try {
    const record = parseRecord(fromB64url(sent.record));
    const content = sent.content ? JSON.parse(new TextDecoder().decode(fromB64url(sent.content))) : null;
    return record ? { record, content } : null;
  } catch {
    return null;
  }
}

/**
 * POST /_p/reports/check, unsigned (app.js): a report's id is a 256-bit secret only its reporter's site has, so asking
 * by it needn't say again who's asking. At most 50 ids, in a small body.
 */
export async function handleReportCheck(request, env) {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  const text = await request.text().catch(() => "");
  if (text.length > 8192) return json({ error: "Too much." }, 413);
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return json(await answerReportCheck(env.DB, body?.ids));
}

/** What became of each of `ids` (POST /_p/reports/check), for the reporter's site. */
export async function answerReportCheck(db, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((i) => typeof i === "string" && REPORT_ID_RE.test(i)).slice(0, 50);
  if (!list.length) return { reports: [] };
  const { results } = await db.prepare("SELECT id, outcome, word FROM reports WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(list)).all();
  return { reports: results.map((r) => ({ id: String(r.id), outcome: r.outcome ?? null, word: r.word ?? null })) };
}

/**
 * What's been raised, for those running the space: one entry for each thing reported (every open one first, then what
 * was dealt with in the last 30 days), with every reason, note and named reporter, and whether anyone chose not to be
 * named (not how many: one person can raise something unnamed again another day). Never what's about `exclude`'s own
 * post or comment: an admin isn't shown what's been raised about them. `names(people)`: a Map of person id to name.
 */
export async function raised(db, names, { exclude = null } = {}) {
  await tidyReports(db);
  const since = now() - SHOWN_SECONDS;
  // Which things, chosen whole, so a flood about one can't push others off.
  const { results: things } = await db.prepare(`SELECT about, MAX(handled_at IS NULL) AS open, MIN(created_at) AS first FROM reports
    WHERE (handled_at IS NULL OR handled_at > ?1) AND author IS NOT ?2 GROUP BY about ORDER BY open DESC, first DESC LIMIT ?3`)
    .bind(since, exclude, LISTED).all();
  const abouts = things.map((t) => String(t.about));
  const { results } = abouts.length ? await db.prepare(`SELECT * FROM reports WHERE about IN (SELECT value FROM json_each(?1))
    AND (handled_at IS NULL OR handled_at > ?2) ORDER BY created_at`).bind(JSON.stringify(abouts), since).all() : { results: [] };
  const by = new Map();
  for (const r of results) {
    const about = String(r.about);
    const one = by.get(about) ?? { about, item: String(r.item), author: String(r.author), copy: null, reasons: [], notes: [],
      reporters: [], unnamed: false, first: Number(r.created_at), open: false, outcome: null, handledBy: null, handledAt: null, word: null };
    const copy = JSON.parse(String(r.copy ?? "null"));
    if (copy && !one.copy) one.copy = copy;
    if (!one.reasons.includes(String(r.reason))) one.reasons.push(String(r.reason));
    if (r.note) one.notes.push(String(r.note));
    if (r.reporter_name) one.reporters.push(String(r.reporter_name)); else one.unnamed = true;
    if (r.handled_at === null || r.handled_at === undefined) one.open = true;
    else if (!one.handledAt || Number(r.handled_at) > one.handledAt) {
      Object.assign(one, { outcome: String(r.outcome), handledBy: r.handled_by ? String(r.handled_by) : null, handledAt: Number(r.handled_at), word: r.word ?? null });
    }
    by.set(about, one);
  }
  const all = [...by.values()];
  for (const r of all) r.copy ??= { kind: "comment", text: "", photos: 0 };
  // A photo's comments: where to go is the post it's in.
  const photos = new Map((await db.prepare("SELECT photo, post FROM item_photos WHERE photo IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(all.map((r) => r.item))).all()).results.map((r) => [String(r.photo), String(r.post)]));
  for (const r of all) r.post = photos.get(r.item) ?? r.item;
  const known = await names([...new Set(all.flatMap((r) => [r.author, r.handledBy].filter(Boolean)))]);
  for (const r of all) {
    r.authorName = known.get(r.author) ?? "Someone";
    r.handledByName = r.handledBy ? known.get(r.handledBy) ?? "someone" : null;
    r.reasons = r.reasons.map((k) => REASONS[k] ?? k);
  }
  return all.sort((a, b) => Number(b.open) - Number(a.open) || b.first - a.first);
}

/** How many things are waiting to be looked at. */
export const openCount = async (db) => Number((await db.prepare(`SELECT COUNT(DISTINCT about) AS n FROM reports WHERE handled_at IS NULL
  AND item NOT IN (SELECT id FROM lists WHERE deleted_at IS NOT NULL)`).first())?.n ?? 0);

/** Looked at, and left (by `by`, never about their own), with an optional word back to whoever raised it. */
export async function leaveIt(db, about, by, word) {
  if (!ID_RE.test(String(about))) return;
  await db.prepare("UPDATE reports SET handled_at = ?, handled_by = ?, outcome = 'left', word = ? WHERE about = ? AND handled_at IS NULL AND author != ?")
    .bind(now(), by, typeof word === "string" && word.trim() ? word.trim().slice(0, MAX_WORD) : null, about, by).run();
}

/** What was reported has been removed (by `by`): a removal on its list, of it or of the post it's on. */
export async function markRemoved(db, about, by) {
  await db.prepare("UPDATE reports SET handled_at = ?2, handled_by = ?3, outcome = 'removed' WHERE handled_at IS NULL AND (about = ?1 OR item = ?1)")
    .bind(about, now(), by).run();
}

/** Its writer has been removed from the group (by `by`): everything open about what they wrote is dealt with. */
export async function markMemberRemoved(db, author, by) {
  await db.prepare("UPDATE reports SET handled_at = ?, handled_by = ?, outcome = 'member' WHERE handled_at IS NULL AND author = ?").bind(now(), by, author).run();
}

/** Whether a "might be illegal" report may buzz phones: ILLEGAL_PUSHES a day. */
export async function illegalMayBuzz(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reason = 'illegal' AND created_at > ?").bind(now() - 86400).first();
  return Number(row?.n ?? 0) <= ILLEGAL_PUSHES;
}

// --- the reporter's side ----------------------------------------------------------------------------------------------

/**
 * Sends a report from the owner here to `host` (its origin) and keeps it to ask about later. `where`: {connection} or
 * {group} (their ids here). Returns {ok} or {error}.
 */
export async function sendReport(env, from, host, where, { item, post, about, reason, note, named }) {
  if (!ID_RE.test(item) || !ID_RE.test(post) || !ID_RE.test(about) || !Object.hasOwn(REASONS, reason)) return { error: "That didn't work. Try again." };
  let answer;
  try {
    answer = await callFriend(env, from, host, "/_p/report", { body: { item, about, reason, note: String(note ?? "").slice(0, MAX_NOTE), named: Boolean(named) } });
  } catch (error) {
    // A site from before reports answers "Not found." to the call.
    return { error: error.status === 404 && /^Not found\.?$/.test(String(error.message)) ? "Their site needs updating before it can take this. Try again in a few days."
      : String(error.message) };
  }
  if (typeof answer?.id !== "string" || !REPORT_ID_RE.test(answer.id)) return { error: "That didn't work. Try again." };
  await env.DB.prepare(`INSERT OR IGNORE INTO reports_sent (id, connection_id, group_id, item, post, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(answer.id, where.connection ?? null, where.group ?? null, item, post, reason, now()).run();
  return { ok: true };
}

/**
 * What became of what the owner here reported, asked of each site at most hourly; a quiet notice when one's dealt with,
 * and, for "might be illegal" not looked at after LATE_SECONDS, where else to turn.
 */
export async function checkSentReports(env, from) {
  const db = env.DB;
  const at = now();
  // Raised with a friend who isn't one any more, or a group the owner's no longer in: nothing more will come.
  await db.batch([
    db.prepare(`UPDATE reports_sent SET outcome = 'gone', done_at = ?1 WHERE outcome IS NULL AND (
      (connection_id IS NOT NULL AND connection_id NOT IN (SELECT id FROM connections WHERE approved_at IS NOT NULL))
      OR (group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups WHERE joined_at IS NOT NULL)))`).bind(at),
    db.prepare("DELETE FROM reports_sent WHERE done_at IS NOT NULL AND done_at < ?").bind(at - KEEP_SECONDS),
  ]);
  // The longest unasked first, so none waits behind the rest.
  const { results } = await db.prepare(`SELECT r.*, c.origin AS c_origin, c.name AS c_name, g.origin AS g_origin, g.name AS g_name
    FROM reports_sent r LEFT JOIN connections c ON c.id = r.connection_id LEFT JOIN groups g ON g.id = r.group_id
    WHERE r.outcome IS NULL AND r.checked_at < ? ORDER BY r.checked_at, r.created_at LIMIT 100`).bind(at - CHECK_SECONDS).all();
  const byHost = new Map();
  for (const r of results) {
    const origin = r.c_origin ?? r.g_origin;
    if (!origin) continue;
    if (!byHost.has(origin)) byHost.set(origin, []);
    byHost.get(origin).push(r);
  }
  for (const [origin, rows] of byHost) {
    let answer = null;
    // Unsigned: the ids say which, and nothing says again who's asking.
    try {
      const res = await fetch(`${origin}/_p/reports/check`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: rows.map((r) => String(r.id)) }), redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const text = res.ok ? await res.text() : "";
      answer = text && text.length < 65_536 ? JSON.parse(text) : null;
    } catch { answer = null; }
    const outcomes = new Map((Array.isArray(answer?.reports) ? answer.reports : []).map((x) => [String(x.id), x]));
    for (const r of rows) {
      const where = r.connection_id ? { connection: Number(r.connection_id) } : { group: Number(r.group_id) };
      const whose = r.connection_id ? String(r.c_name) : "The admins";
      const target = String(r.post);
      const got = outcomes.get(String(r.id));
      if (got?.outcome && ["removed", "left", "member"].includes(got.outcome)) {
        const word = typeof got.word === "string" ? got.word.slice(0, MAX_WORD) : null;
        await db.prepare("UPDATE reports_sent SET outcome = ?, word = ?, done_at = ?, checked_at = ? WHERE id = ?").bind(got.outcome, word, at, at, r.id).run();
        const did = got.outcome === "removed" ? "removed it" : got.outcome === "member" ? "removed whoever wrote it from the group" : "left it";
        await keepNotice(db, { kind: "reported", fp: `reported-${r.id}`, ...where, item: String(r.item), target, actor: whose,
          text: `${whose === "The admins" ? "The admins" : whose} looked at what you raised, and ${did}.${word ? ` “${word}”` : ""}` });
        continue;
      }
      await db.prepare("UPDATE reports_sent SET checked_at = ? WHERE id = ?").bind(at, r.id).run();
      if (r.reason === "illegal" && !r.late_told && Number(r.created_at) < at - LATE_SECONDS) {
        await db.prepare("UPDATE reports_sent SET late_told = 1 WHERE id = ?").bind(r.id).run();
        await keepNotice(db, { kind: "reported", fp: `reported-late-${r.id}`, ...where, item: String(r.item), target, actor: whose,
          text: `${whose === "The admins" ? "The admins haven't" : `${whose} hasn't`} looked at what you raised yet. If it's serious, you can report it outside afterwrd: see Getting help.` });
      }
    }
  }
}

// --- the owner's forms ------------------------------------------------------------------------------------------------

/**
 * POST /_admin/reports/send   form: where ("friend" or "group"), place (its id here), item, post, about, reason, note,
 *                             named ("1"), back: the owner here telling a friend, or a group's admins
 * POST /_admin/reports/leave  form: where ("own" or "group"), place, about, word, back: looked at, and left
 */
export async function handleReportsAdmin(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const form = await request.formData().catch(() => new FormData());
  const back = safeNext(String(form.get("back") ?? "/"), url);
  const where = String(form.get("where") ?? "");
  const place = Number(form.get("place")) || 0;
  const said = (message, status = 400) => html(messagePage(message, { href: back, label: "Go back" }), status);
  const group = where === "group"
    ? await env.DB.prepare("SELECT id, origin, name FROM groups WHERE id = ? AND joined_at IS NOT NULL AND identity IS NOT NULL").bind(place).first() : null;
  if (where === "group" && !group) return said("That group isn't there any more.", 404);
  if (url.pathname === "/_admin/reports/send") {
    const friend = where === "friend"
      ? await env.DB.prepare("SELECT id, origin, name FROM connections WHERE id = ? AND approved_at IS NOT NULL").bind(place).first() : null;
    if (!friend && !group) return said("That isn't there any more.", 404);
    const host = String((friend ?? group).origin);
    const sent = await sendReport(env, url.origin, host, friend ? { connection: place } : { group: place }, {
      item: String(form.get("item") ?? ""), post: String(form.get("post") ?? ""), about: String(form.get("about") ?? ""),
      reason: String(form.get("reason") ?? ""), note: String(form.get("note") ?? ""), named: form.get("named") === "1" });
    if (sent.error) return said(sent.error);
    const told = friend ? `${friend.name} has` : `The admins of ${group.name} have`;
    return said(`Thanks. ${told} been told. You'll see in Notifications what's done about it.`, 200);
  }
  if (url.pathname === "/_admin/reports/leave") {
    const about = String(form.get("about") ?? "");
    const word = String(form.get("word") ?? "");
    if (where === "own") {
      const me = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
      if (me) await leaveIt(env.DB, about, String(me.person), word);
    } else if (group) {
      try {
        await callFriend(env, url.origin, String(group.origin), "/_group/admin/reports/leave", { body: { about, word } });
      } catch (error) {
        return said(String(error.message));
      }
    }
    return Response.redirect(`${url.origin}${back}`, 303);
  }
  return new Response("Not found", { status: 404 });
}
