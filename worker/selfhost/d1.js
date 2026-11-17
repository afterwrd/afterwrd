// A stand-in for Cloudflare's D1 when afterwrd runs on its own server (docs/self-hosting-plan.md). workerd, the
// open-source engine Workers run on, has Durable Objects with SQLite but no D1, so the site's database is one
// Durable Object (Database) and env.DB is a small client that sends it statements. It covers only what afterwrd
// uses: prepare().bind(), first(), all(), run(), raw() and batch() (one transaction), with D1's result shapes.
import { DurableObject } from "cloudflare:workers";

/** The site's database: one Durable Object holding it, so every statement runs one at a time, as on D1. */
export class Database extends DurableObject {
  /**
   * Runs statements and returns D1-shaped results. With `together` they run in one transaction, as D1's batch()
   * does: if one fails, none of them happened.
   * @param {{sql: string, params: unknown[]}[]} statements
   * @param {boolean} together
   */
  query(statements, together) {
    const sql = this.ctx.storage.sql;
    const one = ({ sql: text, params }) => {
      const cursor = sql.exec(text, ...params);
      const results = cursor.toArray().map(fromSqlite);
      const written = cursor.rowsWritten;
      const { changes, last_row_id } = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").one();
      return {
        success: true,
        results,
        columns: cursor.columnNames,
        meta: { changes: written ? changes : 0, last_row_id, rows_read: cursor.rowsRead, rows_written: written,
          changed_db: written > 0, duration: 0, size_after: 0, served_by: "afterwrd-selfhost" },
      };
    };
    return together ? this.ctx.storage.transactionSync(() => statements.map(one)) : statements.map(one);
  }
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
 * env.DB for a site whose database is the Database Durable Object in `namespace`. The object is looked up for each
 * call: a stub made while answering one request can't be used while answering another.
 */
export function d1(namespace, name = "db") {
  const db = {
    send: (statements, together) => namespace.get(namespace.idFromName(name)).query(statements, together),
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      if (!statements.length) return [];
      return (await db.send(statements.map((s) => s.plain()), true)).map(({ columns, ...result }) => result);
    },
    exec() {
      throw new Error("exec() isn't available on a self-hosted site's database.");
    },
  };
  return db;
}
