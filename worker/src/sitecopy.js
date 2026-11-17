// The one-off move of a site's database into its own object (docs/site-object-plan.md, release A): the first time the
// site's object finds its own database empty while the old one has a site in it, everything is copied across. The
// old one is D1 on Cloudflare, or the Database object when self-hosted. It's left as it was, a safety copy, apart
// from one row first: MOVED in its list of migrations, which no older version knows. So an older version (one still
// running for a few seconds while Cloudflare switches over, or one an update would switch back to) sees a database
// newer than itself and says the site is being updated rather than carry on with the old copy (migrate.js), and an
// update to here never switches back (auto.js switchCarefully `migrated`). Without it, going back would let the old
// copy drift (a passkey removed there, say), and the next move would bring back a stale one.
// The object runs this while every other request waits (outbox.js: blockConcurrencyWhile), so nothing changes while
// it copies. Progress is kept as it goes (afterwrd_copy), so a copy cut short (a time limit, a day's writes) carries
// on with the next request; until it's finished, requests are told the site is moving.
import { runStatements } from "./sqlite.js";

const CHUNK = 1000; // rows read at a time
// More than this many rows to write, and the Facebook archive isn't copied: the free plan writes 100,000 rows a day,
// shared with photos and any groups, and an index's entries count too. The owner imports it again, which Home asks
// them to (settings archive_dropped).
export const MOST_ROWS = 40_000;
/** The row the move leaves in the old database's list of migrations (see above). */
export const MOVED = "moved_to_the_site_object";
// Counters carry on this far past the old database's, so anything an older version wrote there in its last seconds
// (before it saw MOVED) can't share a number with something new here: friends' sites keep posts by their number.
const SEQUENCE_GAP = 1000;
// The archive: its own tables, and its rows in the tables it shares with what's written here.
const ARCHIVE_TABLE = /^facebook_/;
const SHARED = { posts: "source = 'afterwrd'", media: "source = 'afterwrd'" };

/** Whether the object's own database is ready: copied (or with nothing to copy). */
export function copied(storage) {
  return Boolean(storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'afterwrd_copy'").toArray().length
    && storage.sql.exec("SELECT 1 FROM afterwrd_copy WHERE name = '' AND done = 1").toArray().length);
}

/**
 * Copies the old database (`old`, D1-shaped: prepare/bind/all/batch) into `storage`, carrying on from wherever an
 * earlier try got to. Throws if it can't finish this time (the next request tries again). `mostRows` is for tests.
 * @param {DurableObjectStorage} storage
 * @param {any} old
 */
export async function copyOnce(storage, old, { mostRows = MOST_ROWS } = {}) {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS afterwrd_copy (name TEXT PRIMARY KEY, after INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0)");
  if (copied(storage)) return;
  const finish = (dropped = false) => {
    sql.exec("INSERT INTO afterwrd_copy (name, done) VALUES ('', 1) ON CONFLICT (name) DO UPDATE SET done = 1");
    if (dropped) sql.exec("INSERT INTO settings (key, value) VALUES ('archive_dropped', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(Math.floor(Date.now() / 1000)));
  };
  // Nothing there (a new site, or one that's never been opened): nothing to copy. migrate.js makes the tables.
  const schema = old ? (await old.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL
    AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type = 'table' DESC, rowid`).all()).results : [];
  if (!schema.some((s) => s.type === "table" && s.name === "users")) return finish();
  // First, the old database stops being used (see above).
  if (schema.some((s) => s.type === "table" && s.name === "d1_migrations")) {
    await old.prepare(`INSERT INTO d1_migrations (name, applied_at) SELECT ?1, datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`).bind(MOVED).run();
  }
  // Here already (this own database has its tables): only the rows are left to copy.
  const here = new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
  const tables = schema.filter((s) => s.type === "table");
  for (const t of tables) if (!here.has(t.name)) sql.exec(t.sql);
  // Too many rows for a day's writes: leave the archive out (decided once, and kept with the progress).
  let keepArchive = sql.exec("SELECT done FROM afterwrd_copy WHERE name = '*archive'").toArray()[0]?.done;
  if (keepArchive === undefined) {
    const counts = await old.batch(tables.map((t) => old.prepare(`SELECT COUNT(*) AS n FROM ${quoted(t.name)}`)));
    const total = counts.reduce((sum, c) => sum + Number(c.results[0]?.n ?? 0), 0);
    keepArchive = total <= mostRows ? 1 : 0;
    sql.exec("INSERT INTO afterwrd_copy (name, done) VALUES ('*archive', ?)", keepArchive);
  }
  // The site's own tables first, the archive's last.
  const ordered = [...tables.filter((t) => !ARCHIVE_TABLE.test(t.name)), ...(keepArchive ? tables.filter((t) => ARCHIVE_TABLE.test(t.name)) : [])];
  for (const t of ordered) {
    const only = t.name === "d1_migrations" ? `name != '${MOVED}'` : keepArchive ? null : SHARED[t.name] ?? null;
    await copyTable(storage, old, t, only);
  }
  // AUTOINCREMENT counters carry on from the old database's, never below what's been used (deleted rows included),
  // and SEQUENCE_GAP past it.
  const hasSequences = (await old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").all()).results.length > 0;
  const sequences = hasSequences ? (await old.prepare("SELECT name, seq FROM sqlite_sequence").all()).results : [];
  for (const { name, seq } of sequences) {
    if (!sql.exec("SELECT 1 FROM sqlite_sequence WHERE name = ?", name).toArray().length) sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, 0)", name);
    sql.exec("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?", Number(seq) + SEQUENCE_GAP, name);
  }
  // Indexes, triggers and views once the rows are in.
  const made = new Set(sql.exec("SELECT name FROM sqlite_master").toArray().map((r) => r.name));
  for (const s of schema) if (s.type !== "table" && !made.has(s.name)) sql.exec(s.sql);
  finish(!keepArchive);
}

/** One table's rows, in rowid order, a chunk at a time, carrying on after the last one copied. `only`: a WHERE for them. */
async function copyTable(storage, old, table, only) {
  const sql = storage.sql;
  const progress = sql.exec("SELECT after, done FROM afterwrd_copy WHERE name = ?", table.name).toArray()[0];
  if (progress?.done) return;
  let after = Number(progress?.after ?? 0);
  if (!progress) sql.exec("INSERT INTO afterwrd_copy (name) VALUES (?)", table.name);
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql);
  for (;;) {
    // A table without rowids (none yet) is read by position instead.
    const { results } = await old.prepare(withoutRowid
      ? `SELECT * FROM ${quoted(table.name)}${only ? ` WHERE ${only}` : ""} LIMIT ${CHUNK} OFFSET ?`
      : `SELECT rowid AS afterwrd_rowid, * FROM ${quoted(table.name)} WHERE rowid > ?${only ? ` AND ${only}` : ""} ORDER BY rowid LIMIT ${CHUNK}`)
      .bind(after).all();
    if (!results.length) break;
    const statements = results.map((row) => {
      const { afterwrd_rowid: rowid, ...values } = row;
      const columns = Object.keys(values);
      const names = [...(withoutRowid ? [] : ["rowid"]), ...columns.map(quoted)];
      return {
        sql: `INSERT INTO ${quoted(table.name)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        params: [...(withoutRowid ? [] : [rowid]), ...columns.map((c) => fromD1(values[c]))],
      };
    });
    after = withoutRowid ? after + results.length : Number(results.at(-1).afterwrd_rowid);
    // The chunk and where it got to, together: a chunk is never copied twice.
    statements.push({ sql: "UPDATE afterwrd_copy SET after = ? WHERE name = ?", params: [after, table.name] });
    runStatements(storage, statements, true);
    if (results.length < CHUNK) break;
  }
  sql.exec("UPDATE afterwrd_copy SET done = 1 WHERE name = ?", table.name);
}

/** A table's or column's name, quoted for SQL. */
const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** D1 gives blobs as arrays of byte values: back to bytes for SQLite. Everything else goes in as it came. */
const fromD1 = (value) => (Array.isArray(value) ? new Uint8Array(value).buffer : value);
