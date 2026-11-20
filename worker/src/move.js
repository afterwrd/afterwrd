// Moving a whole afterwrd site here (to a server of your own, say, or back to Cloudflare): the other site's Download
// everything carries its rows as they are (site/ in the zip, export.js), and this takes them in. The browser reads the
// zip (public/static/import/move.js) and sends it a piece at a time:
//   GET  /_admin/import/move           the page
//   POST /_admin/import/move/check     {about}: can this download come here? (same database, nothing here yet)
//   POST /_admin/import/move/start     {about}: empty <table>_move copies of the tables that move
//   POST /_admin/import/move/rows      {table, rows} into <table>_move
//   POST /_admin/import/move/finish    {about}: every _move table in at once, once every photo is stored
// Photos and videos go first, through the Facebook import's /_admin/import/missing and /files/<sha256>.
//
// Only what's the owner's own moves: posts, photos, albums, comments here (friends' too), polls, events, what edits
// replaced, the Facebook archive and the profile pictures. Friends and groups can't: their keys never leave a site
// (export.js), so the new site makes friends afresh. The download is the owner's, but could have come from anyone
// else, so every value is checked as the Facebook import checks its own.
import { POST_KEY_RE } from "../public/static/activity.js";
import { SERVABLE_TYPES } from "../public/static/import/schema.js";
import { SECTIONS } from "../public/static/import/select.js";
import { TABLES } from "./export.js";
import { insertStatements, literal } from "./importer.js";
import { HASH_RE, mediaStore } from "./media.js";
import { DATABASE } from "./migrate.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { MAX_POST_TEXT } from "./edits.js";
import { MAX_MENTIONS } from "./mentions.js";
import { MAX_OPTION, MAX_OPTIONS } from "./polls.js";
import { siteOrigin } from "./peers.js";
import { headerMe } from "./photos.js";
import { html, json, now, pageData } from "./util.js";
import { movePage } from "./views/import.js";

/** The tables that move, in the order they go in. */
export const MOVED = ["settings", "albums", "posts", "media", "facebook_people", "facebook_post_tags", "facebook_comments",
  "facebook_reactions", "facebook_tagged_photos", "comments", "polls", "poll_votes", "events", "post_versions",
  "comment_versions"];
// Only the owner's choices move from settings; the rest of it is the site's own keys, which the download hasn't got.
const SETTINGS = ["sections", "profile_hash", "cover_hash"];
// A site that has anything in these isn't new: moving would mix two sites together, and its rows would be replaced.
const IN_USE = [...MOVED.filter((t) => t !== "settings"), "connections", "groups"];
// Checked again in the same transaction as the move itself, so nothing made in the meantime (in another tab) is lost.
// (A chain of EXISTS, not one UNION: D1 allows only a few terms in a compound SELECT.)
const STILL_NEW = `SELECT CASE WHEN ${IN_USE.map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(" OR ")} THEN json('not new') END`;
const TARGET_RE = /^(post-\d+-[0-9a-f]{8}|photo-[0-9a-f]{64})$/;
const MAX_TEXT = 1_000_000; // the Facebook archive's own text (its posts can be long)
const MAX_NAME = 100;
const MAX_ID = 1e12; // as the Facebook import's ids (importer.js): room to spare, far inside JavaScript's safe integers
// Times that are in the past by nature: none may be later than now (a comment dated 2099 would use up a friend's
// allowance for good, limits counting what's recent). A start, an end or a poll's closing time may be ahead.
const PAST_RE = /^(created|edited|replaced|voted|changed|cancelled|closed|taken)_at$|^last_modified$/;
// Longest text a column may hold: as afterwrd lets it be written. Posts written here are checked as rows (rows()).
// Looked up when used, not when this file starts: limits read from other files as it starts could be found before
// they're set, if a change elsewhere altered the order files start in, and silently fall back to MAX_TEXT.
const longest = (column) => ({ "comments.text": MAX_COMMENT, "comment_versions.text": MAX_COMMENT, "post_versions.text": MAX_POST_TEXT,
  "comments.author_name": MAX_NAME, "poll_votes.name": MAX_NAME })[column];
// What a row of one table points at in another, as in the Facebook import (schema.js refs): after the move, pointers
// to rows the download didn't bring are removed (NOT NULL) or emptied, so nothing made later on this site picks up a
// planted photo, poll or edit history by being given that number.
const POINTERS = [["media", "album_id", "albums", "id"], ["media", "post_id", "posts", "id"], ["albums", "cover_media_id", "media", "id"],
  ["facebook_people", "profile_media_id", "media", "id"], ["facebook_people", "cover_media_id", "media", "id"],
  ["facebook_post_tags", "post_id", "posts", "id", true], ["facebook_post_tags", "person_id", "facebook_people", "id", true],
  ["polls", "post_id", "posts", "id", true], ["poll_votes", "post_id", "polls", "post_id", true], ["events", "post_id", "posts", "id", true],
  ["post_versions", "post_id", "posts", "id", true], ["comment_versions", "comment_id", "comments", "id", true]];

export async function handleMove(request, env, url, owner) {
  const path = url.pathname.slice("/_admin/import/move".length);
  if (request.method === "GET" && path === "") {
    return html(movePage(pageData(env, { me: await headerMe(env.DB, owner), site: url.origin })));
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
    if (path === "/check") return json(await ready(env, url, body.about));
    if (path === "/start") return json(await start(env, url, body.about));
    if (path === "/rows") return json(await rows(env, body));
    if (path === "/finish") return json(await finish(env, url, body.about));
  } catch (error) {
    if (error instanceof MoveRefused) return json({ error: error.message }, 400);
    throw error;
  }
  return new Response("Not found", { status: 404 });
}

class MoveRefused extends Error {}
const refuse = (message) => { throw new MoveRefused(message); };

/** Whether `about` (the download's site/about.json) can come here; returns where it's from. */
async function ready(env, url, about) {
  if (about?.format !== 1) refuse("This isn't a download this version of afterwrd can read. Make it again from Download everything on your old site.");
  const from = siteOrigin(about.site, env);
  if (!from) refuse("This download doesn't say which site it came from.");
  if (from === url.origin) refuse("This download is from this site.");
  // afterwrd 2: signed posts and photos are signed by their owner's identity, which moves with a signed change of
  // address and new passkeys at the new one (docs/signed-conversations.md). Until that's built, a download with any
  // is refused, with nothing moved, rather than bringing them over without what proves them.
  if (Number(about.signed) > 0) {
    refuse("This download has signed posts. Moving them comes with moving your identity to the new site, which isn't ready yet. Nothing has been moved.");
  }
  if (about.database !== DATABASE) {
    refuse(`This download was made by afterwrd ${String(about.version ?? "?").slice(0, 20)}, which keeps things differently from `
      + "this site's version. Update whichever of the two sites is older, so both run the same version, then make the download again.");
  }
  const counts = await env.DB.batch(IN_USE.map((t) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  if (counts.some((c) => c.results[0].n > 0)) {
    refuse("This site already has posts, photos, friends or an import of its own. A site can only be moved into a new one, before anything is on it.");
  }
  return { ok: true, from, tables: MOVED };
}

async function start(env, url, about) {
  await ready(env, url, about);
  await env.DB.batch(MOVED.flatMap((t) => [
    `DROP TABLE IF EXISTS ${t}_move`,
    `CREATE TABLE ${t}_move AS SELECT ${columnsOf(t, null) ?? "*"} FROM ${t} WHERE 0`,
  ]).map((s) => env.DB.prepare(s)));
  return { ok: true };
}

/** The columns that move for a table: export.js's list where it gives one, else every column (null: ask the table). */
function columnsOf(table, info) {
  const listed = TABLES[table].columns;
  if (listed !== "*") return listed.split(",").map((c) => c.trim()).join(", ");
  return info ? info.map((c) => c.name).join(", ") : null;
}

/** The table's columns: name, declared type and whether it may be empty. */
async function tableInfo(env, table) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const wanted = columnsOf(table, results).split(", ");
  return results.filter((c) => wanted.includes(c.name)).map((c) => ({ name: c.name, type: String(c.type).toUpperCase(),
    required: Boolean(c.notnull) && c.dflt_value === null && !c.pk, key: Boolean(c.pk) }));
}

async function rows(env, { table, rows: list }) {
  if (!MOVED.includes(table) || !Array.isArray(list) || !list.length || list.length > 5000) refuse("Bad rows.");
  // A post written here is no longer than afterwrd lets one be (Facebook's own may be).
  if (table === "posts" && list.some((r) => r?.source === "afterwrd" && typeof r.text === "string" && r.text.length > MAX_POST_TEXT)) {
    refuse("The download has something unexpected in posts.text, so nothing was moved.");
  }
  const info = await tableInfo(env, table);
  const names = info.map((c) => c.name);
  const tuples = list.map((row) => {
    if (!row || typeof row !== "object" || Object.keys(row).some((k) => !names.includes(k))) {
      refuse(`The download's ${table} don't match this site's: is it from the same version of afterwrd?`);
    }
    return `(${info.map((c) => literal(checked(env, table, c, row[c.name] ?? null))).join(", ")})`;
  });
  await env.DB.batch(insertStatements(`${table}_move`, names, tuples).map((s) => env.DB.prepare(s)));
  return { ok: true };
}

/** A value from the download, if it suits its column; anything else stops the move. */
function checked(env, table, { name, type, required, key }, value) {
  const bad = () => refuse(`The download has something unexpected in ${table}.${name}, so nothing was moved.`);
  if (value === null) return required || key ? bad() : null;
  if (type.startsWith("INTEGER")) {
    if (!Number.isSafeInteger(value)) bad();
    if ((name === "id" || name.endsWith("_id")) && (value < 1 || value > MAX_ID)) bad();
    if (PAST_RE.test(name) && (value < 0 || value > now() + 600)) bad();
  } else if (type.startsWith("REAL")) {
    if (typeof value !== "number" || !Number.isFinite(value)) bad();
  } else if (typeof value !== "string" || value.length > (longest(`${table}.${name}`) ?? MAX_TEXT)) bad();
  const ok = RULES[`${table}.${name}`]?.(value, env) ?? true;
  return ok ? value : bad();
}

const isOrigin = (v, env) => siteOrigin(v, env) === v;
const parsed = (v) => { try { return JSON.parse(v); } catch { return undefined; } };
const mentions = (v, env) => {
  const list = parsed(v);
  return Array.isArray(list) && list.length <= MAX_MENTIONS + 1 && list.every((m) => typeof m?.name === "string"
    && m.name.length <= MAX_NAME && (m.origin === "here" || isOrigin(m.origin, env)));
};
const options = (v) => {
  const list = parsed(v);
  return Array.isArray(list) && list.length >= 2 && list.length <= MAX_OPTIONS
    && list.every((o) => typeof o === "string" && o.length <= MAX_OPTION);
};
const timeZone = (v) => { try { new Intl.DateTimeFormat("en-GB", { timeZone: v }); return true; } catch { return false; } };

// Values that end up in addresses, links or code paths that trust them: the same shapes afterwrd itself makes.
const RULES = {
  "settings.key": (v) => SETTINGS.includes(v),
  "media.hash": (v) => HASH_RE.test(v),
  "media.thumb_hash": (v) => HASH_RE.test(v),
  "media.type": (v) => SERVABLE_TYPES.has(v),
  "posts.key": (v) => POST_KEY_RE.test(v),
  "posts.mentions": mentions,
  "comments.target": (v) => TARGET_RE.test(v),
  "comments.origin": (v, env) => v === "site" || isOrigin(v, env),
  "comments.mentions": mentions,
  "poll_votes.voter": (v, env) => v === "site" || isOrigin(v, env),
  "polls.options": options,
  "poll_votes.choices": (v) => v >= 0 && v < 2 ** MAX_OPTIONS,
  "events.time_zone": timeZone,
};

/** The settings that moved must hold what afterwrd would put there. */
function settingOk({ key, value }) {
  if (key === "sections") return Array.isArray(parsed(value)) && parsed(value).every((s) => SECTIONS.includes(s));
  return HASH_RE.test(value);
}

async function finish(env, url, about) {
  const { from } = await ready(env, url, about);
  const db = env.DB;
  const { results: settings } = await db.prepare("SELECT key, value FROM settings_move").all();
  if (!settings.every(settingOk)) refuse("The download has something unexpected in its settings, so nothing was moved.");

  // Every photo, video and thumbnail the rows name must be here first, or posts would show holes.
  const { results: files } = await db.prepare(`SELECT hash FROM media_move WHERE hash IS NOT NULL
    UNION SELECT thumb_hash FROM media_move WHERE thumb_hash IS NOT NULL`).all();
  const wanted = [...new Set([...files.map((f) => f.hash), ...settings.filter((s) => s.key !== "sections").map((s) => s.value)])];
  const stored = new Set((await Promise.all([..."0123456789abcdef"].map((shard) => {
    const mine = wanted.filter((h) => h[0] === shard);
    return mine.length ? mediaStore(env, shard).has(mine) : [];
  }))).flat());
  const missing = wanted.filter((h) => !stored.has(h)).length;
  if (missing) refuse(`${missing} of the download's photos and videos haven't reached this site. Was it made with "Include photos and videos" ticked?`);

  // One transaction: if anything doesn't fit (a row the tables refuse), none of it happened.
  const statements = [];
  for (const table of MOVED) {
    const names = (await tableInfo(env, table)).map((c) => c.name);
    // The owner's comments are the owner's here too (comments.author_id is the owner's user id, a foreign key).
    const values = names.map((c) => (table === "comments" && c === "author_id"
      ? "CASE WHEN author_id IS NULL THEN NULL ELSE (SELECT id FROM users LIMIT 1) END" : c));
    statements.push(table === "settings" ? `DELETE FROM settings WHERE key IN (${SETTINGS.map(literal).join(", ")})` : `DELETE FROM ${table}`);
    statements.push(`INSERT INTO ${table} (${names.join(", ")}) SELECT ${values.join(", ")} FROM ${table}_move`);
  }
  statements.push(...MOVED.map((t) => `DROP TABLE ${t}_move`));
  // No pointers to rows that didn't come (see POINTERS), and no comments on posts or photos that aren't here.
  for (const [table, column, target, id, required] of POINTERS) {
    statements.push(required ? `DELETE FROM ${table} WHERE ${column} NOT IN (SELECT ${id} FROM ${target})`
      : `UPDATE ${table} SET ${column} = NULL WHERE ${column} IS NOT NULL AND ${column} NOT IN (SELECT ${id} FROM ${target})`);
  }
  statements.push(`DELETE FROM comments WHERE (target LIKE 'post-%' AND target NOT IN (SELECT key FROM posts))
    OR (target LIKE 'photo-%' AND substr(target, 7) NOT IN (SELECT hash FROM media WHERE hash IS NOT NULL))`,
  `DELETE FROM comment_versions WHERE comment_id NOT IN (SELECT id FROM comments)`);
  // Comment numbers carry on 1000 past the highest moved, as migration 0015 has them do, so the old site's newest
  // deleted comments' numbers (a comment's address ends #c<n>) aren't given out again.
  statements.push(`INSERT INTO comments (id, target, author_name, text, created_at) SELECT COALESCE(MAX(id), 0) + 1000, '', '', '', 0 FROM comments`,
    "DELETE FROM comments WHERE target = ''");
  try {
    await db.batch([
      db.prepare(STILL_NEW),
      ...statements.map((s) => db.prepare(s)),
      // Friends' comments that mentioned the owner named the old site: they name this one now.
      db.prepare("UPDATE comments SET mentions = replace(mentions, json_quote(?1), json_quote(?2)) WHERE instr(mentions, json_quote(?1)) > 0")
        .bind(from, url.origin),
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('moved_from', ?)").bind(from),
    ]);
  } catch (error) {
    await ready(env, url, about); // something was made here meanwhile: say so
    console.error("move finish", error);
    refuse("This site couldn't take some of the download's rows, so nothing was moved. Is the download from the same version of afterwrd?");
  }
  return { ok: true, from };
}
