// Checks src/sitecopy.js, the one-off move of a site's database into its own object, against real SQLite databases
// (Node's own, standing in for D1 and for the object's storage): everything comes across, a copy cut short carries on
// without copying anything twice, the counters carry on, binary data survives, and a site too big for a day's writes
// moves without its Facebook archive and says so.
//   node test/sitecopy.mjs
import { DatabaseSync } from "node:sqlite";
import { copied, copyOnce, MOVED } from "../src/sitecopy.js";
import { client, runStatements } from "../src/sqlite.js";

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };

/** A Durable Object's storage (ctx.storage: sql.exec, transactionSync), over Node's SQLite. */
function storage(db = new DatabaseSync(":memory:")) {
  return {
    db,
    sql: {
      exec(text, ...params) {
        const statement = db.prepare(text);
        const columns = statement.columns().map((c) => c.name);
        const rows = columns.length ? statement.all(...params) : [];
        const written = columns.length ? 0 : Number(statement.run(...params).changes);
        return { toArray: () => rows.map((r) => ({ ...r })), one: () => ({ ...rows[0] }), columnNames: columns, rowsRead: rows.length, rowsWritten: written };
      },
    },
    transactionSync(work) {
      db.exec("BEGIN");
      try {
        const answer = work();
        db.exec("COMMIT");
        return answer;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** The old database: D1's interface over another SQLite, which can be told to fail after so many reads. */
function oldSite({ posts = 3, archive = 2 } = {}) {
  const store = storage();
  store.db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT);
    CREATE INDEX posts_created ON posts(created_at);
    CREATE TABLE credentials (id TEXT PRIMARY KEY, public_key BLOB NOT NULL);
    CREATE TABLE facebook_people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT);
    INSERT INTO users (name) VALUES ('Sam Taylor');
    INSERT INTO settings VALUES ('sections', '["posts"]'), ('count', '5');
    INSERT INTO credentials VALUES ('key-1', X'00FF10');
    INSERT INTO d1_migrations (name) VALUES ('0001_schema.sql'), ('0022_day_index.sql');`);
  for (let i = 1; i <= posts; i++) store.db.prepare("INSERT INTO posts (key, source, created_at, text) VALUES (?, 'afterwrd', ?, ?)").run(`post-${i}`, 1700000000 + i, `Post ${i}`);
  for (let i = 1; i <= archive; i++) {
    store.db.prepare("INSERT INTO posts (key, source, created_at, text) VALUES (?, 'facebook', ?, 'From Facebook')").run(`fb-${i}`, 1600000000 + i);
    store.db.prepare("INSERT INTO facebook_people (name) VALUES (?)").run(`Ann Example ${i}`);
  }
  // A deleted post: the counter is past the highest id, and must stay past it.
  store.db.exec("INSERT INTO posts (key, source, created_at) VALUES ('gone', 'afterwrd', 1); DELETE FROM posts WHERE key = 'gone'");
  let reads = 0;
  let failAfter = Infinity;
  const db = client(async (statements, together) => {
    if (++reads > failAfter) throw new Error("D1 went away");
    return runStatements(store, statements, together);
  });
  return { store, db, failAfter: (n) => { reads = 0; failAfter = n; } };
}

const rows = (store, sql) => store.sql.exec(sql).toArray();

// Everything comes across.
{
  const old = oldSite();
  const here = storage();
  await copyOnce(here, old.db);
  check("users, settings, posts and the migrations list come across", rows(here, "SELECT COUNT(*) AS n FROM posts")[0].n === 5
    && rows(here, "SELECT name FROM users")[0].name === "Sam Taylor" && rows(here, "SELECT COUNT(*) AS n FROM d1_migrations")[0].n === 2
    && rows(here, "SELECT value FROM settings WHERE key = 'count'")[0].value === "5");
  check("…with the same ids", JSON.stringify(rows(here, "SELECT id, key FROM posts ORDER BY id")) === JSON.stringify(rows(old.store, "SELECT id, key FROM posts ORDER BY id")));
  check("binary data survives", Buffer.from(rows(here, "SELECT public_key FROM credentials")[0].public_key).toString("hex") === "00ff10");
  check("indexes come too", rows(here, "SELECT 1 FROM sqlite_master WHERE name = 'posts_created'").length === 1);
  check("the post counter carries on 1000 past the deleted post", rows(here, "SELECT seq FROM sqlite_sequence WHERE name = 'posts'")[0].seq === 1006);
  check("the old database is marked moved, so older versions stand aside", rows(old.store, `SELECT 1 FROM d1_migrations WHERE name = '${MOVED}'`).length === 1);
  check("…but the mark isn't copied, so this one doesn't think its database is newer",
    rows(here, `SELECT 1 FROM d1_migrations WHERE name = '${MOVED}'`).length === 0);
  check("it says it's done", copied(here));
  check("the archive came, so Home doesn't ask for it", rows(here, "SELECT COUNT(*) AS n FROM facebook_people")[0].n === 2
    && rows(here, "SELECT 1 FROM settings WHERE key = 'archive_dropped'").length === 0);
  // Done: never again, even if the old one changes.
  old.store.db.exec("INSERT INTO users (name) VALUES ('Someone Else')");
  await copyOnce(here, old.db);
  check("once done, it never copies again", rows(here, "SELECT COUNT(*) AS n FROM users")[0].n === 1);
}

// A copy cut short carries on, copying nothing twice.
{
  const old = oldSite({ posts: 2500 }); // more than one chunk of posts
  const here = storage();
  old.failAfter(4);
  let threw = false;
  try { await copyOnce(here, old.db); } catch { threw = true; }
  check("a copy cut short says so", threw && !copied(here));
  old.failAfter(Infinity);
  await copyOnce(here, old.db);
  const counts = rows(here, "SELECT COUNT(*) AS n, COUNT(DISTINCT key) AS keys FROM posts")[0];
  check("…and carries on next time, with every row exactly once", copied(here) && counts.n === 2502 && counts.keys === 2502, JSON.stringify(counts));
}

// Too big for a day's writes: the site moves without the archive, and says so.
{
  const old = oldSite({ posts: 3, archive: 5 });
  const here = storage();
  await copyOnce(here, old.db, { mostRows: 10 });
  check("the site's own posts come, the archive's don't", rows(here, "SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'")[0].n === 3
    && rows(here, "SELECT COUNT(*) AS n FROM posts WHERE source = 'facebook'")[0].n === 0 && rows(here, "SELECT COUNT(*) AS n FROM facebook_people")[0].n === 0);
  check("…the archive's tables are there, empty, for importing again", rows(here, "SELECT 1 FROM sqlite_master WHERE name = 'facebook_people'").length === 1);
  check("…and Home will ask for it", rows(here, "SELECT 1 FROM settings WHERE key = 'archive_dropped'").length === 1);
}

// Nothing to copy: a new site.
{
  const here = storage();
  await copyOnce(here, null);
  check("a new site has nothing to copy, and is ready", copied(here) && rows(here, "SELECT 1 FROM sqlite_master WHERE name = 'users'").length === 0);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
