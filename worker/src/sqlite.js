// The site's database, in its own object's SQLite (an Outbox object named "site": docs/site-object-plan.md), with D1's
// interface, on Cloudflare and self-hosted alike. Inside the object (local) a query is a function call, with no trip
// anywhere; the other objects reach it with remote, one call per statement or batch.
// It covers only what afterwrd uses: prepare().bind(), first(), all(), run(), raw() and batch() (one transaction),
// with D1's result shapes.

import { countRows } from "./limits.js";

/**
 * `sql` and its parameters, with every whole-number parameter written into the SQL itself. A Durable Object's SQLite
 * binds every JavaScript number as a decimal (5 becomes 5.0, and "5.0" in a text column) and won't take a BigInt,
 * where D1 stores whole numbers as integers. A whole number written out is only digits (and a minus sign, kept in
 * brackets so it can't run into a "-" before it and start a comment), so nothing can be slipped in this way. The
 * other parameters stay bound, renumbered. (A whole number written in where SQLite expects a column number, as in
 * ORDER BY ?, would mean that column: afterwrd never binds those.) Placeholders are ? and ?NNN, as SQLite numbers them; ones inside quotes,
 * names in brackets or comments aren't placeholders. Anything else (named parameters, or a count that doesn't match)
 * is left exactly as it was, for SQLite to deal with.
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {{ sql: string, params: unknown[] }}
 */
export function inlineIntegers(sql, params) {
  if (!params.some((p) => typeof p === "number" && Number.isInteger(p))) return { sql, params };
  const places = [];
  let highest = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const skipTo = (end, from) => { const at = sql.indexOf(end, from); return at < 0 ? sql.length : at + end.length - 1; };
    if (c === "'" || c === '"' || c === "`") {
      // A quote ends at the next one that isn't doubled.
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      i = j;
    } else if (c === "[") i = skipTo("]", i + 1);
    else if (c === "-" && sql[i + 1] === "-") i = skipTo("\n", i + 2);
    else if (c === "/" && sql[i + 1] === "*") i = skipTo("*/", i + 2);
    else if (c === ":" || c === "@" || c === "$") {
      if (/[A-Za-z_]/.test(sql[i + 1] ?? "")) return { sql, params };
    } else if (c === "?") {
      let j = i + 1;
      while (/[0-9]/.test(sql[j] ?? "")) j++;
      const n = j > i + 1 ? Number(sql.slice(i + 1, j)) : highest + 1;
      highest = Math.max(highest, n);
      places.push({ start: i, end: j, n });
      i = j - 1;
    }
  }
  if (highest !== params.length) return { sql, params };
  const renumbered = new Map();
  const kept = [];
  let out = "";
  let from = 0;
  for (const { start, end, n } of places) {
    const value = params[n - 1];
    let replacement;
    if (typeof value === "number" && Number.isInteger(value)) {
      // Exact even past 2^53 (BigInt), and spaced from a word either side, so "LIMIT?" can't become "LIMIT5".
      const digits = BigInt(value).toString();
      replacement = value < 0 ? `(${digits})` : digits;
      if (/\w/.test(sql[start - 1] ?? "")) replacement = ` ${replacement}`;
      if (/[\w.]/.test(sql[end] ?? "")) replacement = `${replacement} `;
    }
    else {
      if (!renumbered.has(n)) {
        kept.push(value);
        renumbered.set(n, kept.length);
      }
      replacement = `?${renumbered.get(n)}`;
    }
    out += sql.slice(from, start) + replacement;
    from = end;
  }
  return { sql: out + sql.slice(from), params: kept };
}

/**
 * Runs statements on `storage` and returns D1-shaped results. With `together` they run in one transaction, as D1's
 * batch() does: if one fails, none of them happened.
 * @param {DurableObjectStorage} storage
 * @param {{ sql: string, params: unknown[] }[]} statements
 * @param {boolean} together
 */
export function runStatements(storage, statements, together) {
  const sql = storage.sql;
  const one = (statement) => {
    const { sql: text, params } = inlineIntegers(statement.sql, statement.params);
    const cursor = sql.exec(text, ...params);
    const results = cursor.toArray().map(fromSqlite);
    const written = cursor.rowsWritten;
    countRows(cursor.rowsRead, written); // today's usage (limits.js), for the busy-account warning
    const { changes, last_row_id } = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").one();
    return {
      success: true,
      results,
      columns: cursor.columnNames,
      meta: { changes: written ? changes : 0, last_row_id, rows_read: cursor.rowsRead, rows_written: written,
        changed_db: written > 0, duration: 0, size_after: 0, served_by: "afterwrd-object" },
    };
  };
  return together ? storage.transactionSync(() => statements.map(one)) : statements.map(one);
}

/** D1 gives blobs back as arrays of byte values; Durable Objects give ArrayBuffers. */
function fromSqlite(row) {
  for (const [key, value] of Object.entries(row)) if (value instanceof ArrayBuffer) row[key] = [...new Uint8Array(value)];
  return row;
}

/** A value as D1 would bind it: booleans as 1 and 0; undefined, objects and the like refused, as D1 refuses them. */
function toSqlite(value) {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return new Uint8Array(value).buffer;
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${value}'`);
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values.map(toSqlite));
  }

  plain() {
    return { sql: this.sql, params: this.params };
  }

  async all() {
    const [{ columns, ...result }] = await this.db.send([this.plain()], false);
    return result;
  }

  run() {
    return this.all();
  }

  async first(column) {
    const [row] = (await this.all()).results;
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  async raw({ columnNames = false } = {}) {
    const [{ columns, results }] = await this.db.send([this.plain()], false);
    const rows = results.map((row) => columns.map((name) => row[name]));
    return columnNames ? [columns, ...rows] : rows;
  }
}

/**
 * Runs several batches on `storage`, each in its own transaction (one failing doesn't stop the others); for each, null
 * or what went wrong.
 * @returns {(string | null)[]}
 */
export function runBatches(storage, batches) {
  return batches.map((statements) => {
    try {
      runStatements(storage, statements, true);
      return null;
    } catch (error) {
      return String(error?.message ?? error);
    }
  });
}

/**
 * env.DB over `send(statements, together)`, which runs them and gives back runStatements' results, and
 * `sendBatches(batches)` (runBatches).
 */
export function client(send, sendBatches) {
  const db = {
    send,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      if (!statements.length) return [];
      return (await send(statements.map((s) => s.plain()), true)).map(({ columns, ...result }) => result);
    },
    /**
     * Several batches at once, each its own transaction, as one call when the database is in another object: from
     * the Outbox, one call instead of one per batch (each counts towards a run's 50; docs/speed-and-scale-plan.md,
     * "Scale test"). For each batch, null or what went wrong.
     * @param {Statement[][]} batches
     * @returns {Promise<(string | null)[]>}
     */
    async batches(batches) {
      return sendBatches(batches.map((statements) => statements.map((s) => s.plain())));
    },
    exec() {
      throw new Error("exec() isn't available on a database in an object.");
    },
  };
  return db;
}

/** env.DB inside the object that holds the database: each statement runs here and now. */
export const local = (storage) => client(async (statements, together) => runStatements(storage, statements, together),
  async (batches) => runBatches(storage, batches));

/** The object holding the site's database: an Outbox object named "site" (no new kind of object: scripts/release.mjs). */
export const siteObject = (env) => objectNamed(env, "site");

/**
 * The site's object called `name` ("site", "outbox", "vault"), whose every call but `fetch` carries the site's own key
 * (env.OUTBOX_KEY, a secret only the site's Worker has: outbox.js `allowed`). Another Worker in the same account can be
 * bound to these objects, but without the key it gets nothing from them.
 * @param {any} env @param {string} name
 * @returns {any}
 */
export function objectNamed(env, name) {
  const stub = env.OUTBOX.get(env.OUTBOX.idFromName(name));
  const key = typeof env.OUTBOX_KEY === "string" ? env.OUTBOX_KEY : "";
  return new Proxy(stub, {
    get(target, prop) {
      const value = target[prop];
      if (typeof prop !== "string" || prop === "fetch" || prop === "then" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return (...args) => target[prop](key, ...args);
    },
  });
}

/** env.DB anywhere else (the Outbox, the Worker): each statement or batch is one call to the site's object. */
export const remote = (env) => client((statements, together) => siteObject(env).query(statements, together),
  (batches) => siteObject(env).queryBatches(batches));

/** The header the Worker passes the visitor's time zone in (request.cf.timezone), to the site's object. */
export const ZONE_HEADER = "Afterwrd-Zone";

/**
 * The header the Worker passes its own version in ({id, timestamp}: env.VERSION), to the site's object, which
 * restarts itself when it's running older code (outbox.js). A Durable Object keeps the code it started with until it
 * restarts, and one kept busy (as it is during an update) may not restart for minutes: tried on Cloudflare, 18 Nov 2026.
 */
export const FRONT_HEADER = "Afterwrd-Front";
/** Why the site's object restarted itself (FRONT_HEADER): the Worker asks again once when it sees this. */
export const OLDER_CODE = "The site's object was running older code than its Worker, so it has restarted.";

/** Whether the Worker's version (FRONT_HEADER's value) is a newer one than `own` (this code's env.VERSION). */
export function frontIsNewer(value, own) {
  try {
    const front = JSON.parse(value);
    return typeof front?.id === "string" && front.id !== own?.id && Date.parse(front.timestamp) > Date.parse(own?.timestamp);
  } catch {
    return false;
  }
}

/**
 * The database the site used before it moved into its object (sitecopy.js copies it once, then leaves it alone): the
 * Database object when self-hosted (selfhost/d1.js), or D1. Null if there's neither.
 */
export function oldDatabase(env) {
  if (env.DATABASE) {
    return client((statements, together) => env.DATABASE.get(env.DATABASE.idFromName("db")).query(statements, together), () => {
      throw new Error("Not for the database being moved.");
    });
  }
  return env.DB ?? null;
}
