// How long a request spent waiting on the database and on other sites, and how many calls out it made, for the
// signed-in owner to see in the browser's devtools (Network → a request → Timing; docs/speed-and-scale-plan.md, step 2).
// It's sent as a Server-Timing header, on the owner's own pages and actions only: friends' sites, groups and anyone
// signed out never see it.
//
// - db: time with at least one query waiting, and how many statements ran (a batch counts each of its statements).
//   On Cloudflare there's a cap of about 1,000 a request. Rounds: how many times the page waited for the database
//   afresh (queries sent side by side are one round). On Cloudflare each round costs 10–15 ms, so fewer is quicker.
// - sql: of that, the time D1 says it spent running them, and the rows they read (from each result's meta; not for
//   raw()). A lot of rows read means a query looking through a whole table.
// - sites: time with at least one call to another site waiting (friends' sites, groups, GitHub), and how many.
// - calls: calls out to other sites (fetch) this request has made so far: the free plan allows 50 a request. Calls
//   to Durable Objects (photos, the Outbox, the site's own object) don't count towards that (tried on Cloudflare,
//   18 Nov 2026: 60 by RPC or stub.fetch went through where the 51st fetch failed); each is one of the account's
//   object requests a day, so they're shown alongside. Calls made after the reply has gone (work.waitUntil) also count
//   against the 50 but can't be in the header.
// - total: from the request arriving to the reply being ready.
//
// A Worker's clock only moves while it waits on something (Cloudflare's guard against timing attacks), so these
// are waiting times. CPU time can't be measured from inside: Cloudflare's dashboard shows it.
import { AsyncLocalStorage } from "node:async_hooks";
import { squeezeFrom } from "./limits.js";

/**
 * @typedef {{ n: number, ms: number, active: number, since: number, rounds: number }} Clock
 * @typedef {{ start: number, db: Clock, sites: Clock, objects: number, show: boolean, delays: { db: number, sites: number },
 *   sql: { ms: number, rows: number }, scale?: Scale }} Timing
 * @typedef {{ object: any, refused: number, cursors: any[], texts: string[], writes: number, pending: Promise<unknown>[] }} Scale
 */

/** @type {AsyncLocalStorage<Timing>} */
const current = new AsyncLocalStorage();
const clock = () => ({ n: 0, ms: 0, active: 0, since: 0, rounds: 0 });
/** Calls out to other sites (fetch) a free-plan request may make; calls to objects don't count (docs/speed-and-scale-plan.md). */
export const CALLS_ALLOWED = 50;

/**
 * Times `work` against `which` clock: the clock runs while anything on it is waiting, so calls side by side count
 * once, as the time they took together.
 * @template T
 * @param {"db" | "sites"} which
 * @param {number} count
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function timed(which, count, work) {
  const timing = current.getStore();
  if (!timing) return work();
  const c = timing[which];
  c.n += count;
  if (c.active++ === 0) {
    c.since = Date.now();
    c.rounds++;
  }
  try {
    const delay = timing.delays[which];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return await work();
  } finally {
    if (--c.active === 0) c.ms += Date.now() - c.since;
  }
}

/**
 * Scale tests only (scaleTest below): the free plan's 50 calls out per run, enforced as Cloudflare does, by refusing
 * the 51st fetch. Calls to objects don't count. Null to go ahead.
 */
function refused(timing) {
  if (!timing?.scale || timing.sites.n < CALLS_ALLOWED) return null;
  timing.scale.refused++;
  return new Error("Too many subrequests.");
}

// Every fetch() a site makes, wherever it is in the code, is timed while a request is being measured.
const original = globalThis.fetch;
globalThis.fetch = (...args) => {
  const no = refused(current.getStore());
  return no ? Promise.reject(no) : timed("sites", 1, () => original(...args));
};

const fresh = () => ({ start: Date.now(), db: clock(), sites: clock(), objects: 0, show: false, delays: { db: 0, sites: 0 },
  sql: { ms: 0, rows: 0 } });

/**
 * Runs `answer` (one request) with its own timing. In a scale test, a request is already being measured as one run of
 * its object (scaleTest), and carries on with that.
 * @template T
 * @param {() => Promise<T>} answer
 */
export function measure(answer) {
  if (current.getStore()?.scale) return answer();
  return current.run(fresh(), answer);
}

// --- Scale tests (test/scale; docs/scale-test-plan.md) --------------------------------------------------------------
//
// Only for a self-hosted site (HOSTING=self) whose config sets TEST_SCALE (to its address): the scale test's sites.
// Nothing here runs anywhere else. Every run of one of its objects (a request, an alarm, a call from another object)
// is counted as Cloudflare counts it: its calls out to other sites (the 51st is refused; calls to objects don't count,
// but are logged), and the rows its SQLite read and wrote
// (setting an alarm counts as one written). When the run and whatever it left going (waitUntil) have finished, one
// line goes to the log: AFTERWRD_STATS {...}. It holds counts and the request's path, never what anyone wrote.

const patched = new WeakSet();

/**
 * Called by each object's constructor (Outbox, MediaStore). With TEST_SCALE set, every method of its class (including
 * fetch and alarm) runs as one counted run. `name`: which object, as the log line says it ("site", "outbox", "media").
 * @param {any} object  the object (its ctx is protected, so it can't be typed more closely here)
 * @param {Record<string, any>} env
 * @param {string} name
 */
export function scaleTest(object, env, name) {
  // Two settings, as cloudflare.js testingHere asks for ALLOW_LOCAL_SITES: the scale test runs self-hosted only, so a
  // single variable added to a site on Cloudflare can't switch this on.
  if (!env.TEST_SCALE || env.HOSTING !== "self") return;
  squeezeFrom(env);
  const ctx = /** @type {any} */ (object.ctx);
  object.scaleName = name;
  // Whatever a run hands to waitUntil counts towards that run (as on Cloudflare): noted against the run in progress.
  const waitUntil = ctx.waitUntil.bind(ctx);
  object.scaleWaitUntil = waitUntil;
  ctx.waitUntil = (promise) => {
    current.getStore()?.scale?.pending.push(promise);
    waitUntil(promise);
  };
  const sqlProto = Object.getPrototypeOf(ctx.storage.sql);
  if (!patched.has(sqlProto)) {
    patched.add(sqlProto);
    const exec = sqlProto.exec;
    sqlProto.exec = function (...args) {
      const cursor = Reflect.apply(exec, this, args);
      const scale = current.getStore()?.scale;
      if (scale) {
        scale.cursors.push(cursor);
        scale.texts.push(String(args[0]));
      }
      return cursor;
    };
  }
  const storageProto = Object.getPrototypeOf(ctx.storage);
  if (!patched.has(storageProto)) {
    patched.add(storageProto);
    const setAlarm = storageProto.setAlarm;
    storageProto.setAlarm = function (...args) {
      const scale = current.getStore()?.scale;
      if (scale) scale.writes++;
      return Reflect.apply(setAlarm, this, args);
    };
  }
  const proto = Object.getPrototypeOf(object);
  if (patched.has(proto)) return;
  patched.add(proto);
  for (const method of Object.getOwnPropertyNames(proto)) {
    const plain = proto[method];
    if (method === "constructor" || typeof plain !== "function") continue;
    proto[method] = function (...args) {
      // A method the object calls on itself is part of the run that called it.
      if (current.getStore()?.scale?.object === this) return Reflect.apply(plain, this, args);
      return counted(this, method, args[0] instanceof Request ? new URL(args[0].url).pathname : "", () => Reflect.apply(plain, this, args));
    };
  }
}

/** One run of `object`'s `method`, counted and logged (scaleTest). */
function counted(object, method, path, work) {
  const timing = { ...fresh(), scale: { object, refused: 0, cursors: [], texts: [], writes: 0, pending: [] } };
  return current.run(timing, async () => {
    let failed = false;
    let status;
    try {
      const result = await work();
      if (result instanceof Response) status = result.status;
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const replied = Date.now();
      object.scaleWaitUntil((async () => {
        const { pending } = timing.scale;
        for (let seen = -1; seen !== pending.length;) {
          seen = pending.length;
          await Promise.allSettled(pending);
        }
        logRun(object, method, path, timing, pending.length ? Date.now() : replied, failed, status);
      })());
    }
  });
}

function logRun(object, method, path, timing, end, failed, status) {
  const { scale } = timing;
  let read = 0;
  let written = scale.writes;
  for (const cursor of scale.cursors) {
    read += cursor.rowsRead;
    written += cursor.rowsWritten;
  }
  // A run that read a lot says which statements did it: the start of their SQL, with whole numbers written in
  // (sqlite.js inlineIntegers), never the text bound to them.
  const heavy = read > 200 ? scale.cursors.map((c, i) => [c.rowsRead, scale.texts[i].replace(/\s+/g, " ").slice(0, 160)])
    .filter(([rows]) => rows >= 20).sort((a, b) => b[0] - a[0]).slice(0, 6) : undefined;
  // And a run that wrote a lot, which statements wrote it: added up by statement (numbers taken out), as a batch
  // repeats the same few for each friend.
  let heavyWrites;
  if (written > 50) {
    const by = new Map();
    scale.cursors.forEach((c, i) => {
      if (!c.rowsWritten) return;
      const shape = scale.texts[i].replace(/\s+/g, " ").replace(/\b\d+\b/g, "N").slice(0, 120);
      const [rows, runs] = by.get(shape) ?? [0, 0];
      by.set(shape, [rows + c.rowsWritten, runs + 1]);
    });
    heavyWrites = [...by].map(([shape, [rows, runs]]) => [rows, runs, shape]).sort((a, b) => b[0] - a[0]).slice(0, 6);
  }
  // Paths with anything long in them (friend and invite links' tokens, files' hashes) are logged without it.
  const shown = path.replace(/\/[\w-]{20,}/g, "/:token").slice(0, 80);
  console.log(`AFTERWRD_STATS ${JSON.stringify({ site: object.env.TEST_SCALE, obj: object.scaleName, m: method, path: shown,
    t0: timing.start, ms: end - timing.start, calls: timing.sites.n, objects: timing.objects, refused: scale.refused, rr: read, rw: written,
    q: scale.cursors.length, st: status, failed, heavy, hw: heavyWrites })}`);
}

/**
 * Test sites only (ALLOW_LOCAL_SITES): each query waits TEST_DB_DELAY ms first, and each call to another site
 * TEST_SITE_DELAY ms, so a site on this computer is as slow as one on Cloudflare, where a query takes 10–15 ms and a
 * friend's site 0.5–0.7 s (measured 17 Nov 2026). Then chains of queries that wait on each other show up in tests.
 */
export function testDelays(env) {
  const timing = current.getStore();
  if (!timing || !env.ALLOW_LOCAL_SITES) return;
  timing.delays = { db: Number(env.TEST_DB_DELAY) || 0, sites: Number(env.TEST_SITE_DELAY) || 0 };
}

/** This request's reply should carry the timing header: the owner is signed in (index.js). */
export function showTiming() {
  const timing = current.getStore();
  if (timing) timing.show = true;
}

/** The Server-Timing header's value for this request, or null if it isn't to have one. */
export function timingHeader() {
  const timing = current.getStore();
  if (!timing?.show) return null;
  const { db, sites, objects, start, sql } = timing;
  return [
    `db;dur=${db.ms};desc="Database: ${db.n} ${db.n === 1 ? "query" : "queries"} in ${db.rounds} ${db.rounds === 1 ? "round" : "rounds"}"`,
    `sql;dur=${Math.round(sql.ms * 10) / 10};desc="Running them: ${sql.rows} rows read"`,
    `sites;dur=${sites.ms};desc="Other sites: ${sites.n} ${sites.n === 1 ? "call" : "calls"}"`,
    `calls;desc="Calls out: ${sites.n} of ${CALLS_ALLOWED}; to objects: ${objects}"`,
    `total;dur=${Date.now() - start}`,
  ].join(", ");
}

const wrapped = new WeakMap();

/**
 * env with the database and Durable Objects measured. The same object each time for the same env, so wrapping
 * costs nothing after the first request.
 * @template {Record<string, any>} E
 * @param {E} env
 * @returns {E}
 */
export function measured(env) {
  let full = wrapped.get(env);
  if (!full) {
    full = { ...env };
    if (env.DB) full.DB = timedDatabase(env.DB);
    for (const name of ["MEDIA", "OUTBOX"]) if (env[name]) full[name] = countedNamespace(env[name]);
    wrapped.set(env, full);
  }
  return full;
}

/** Adds what D1 says a result took to run, and the rows it read, to this request's figures. */
function ran(results) {
  const timing = current.getStore();
  if (timing) for (const r of [results].flat()) {
    timing.sql.ms += Number(r?.meta?.duration) || 0;
    timing.sql.rows += Number(r?.meta?.rows_read) || 0;
  }
  return results;
}

/** D1 (or the self-hosted stand-in), with each statement's wait timed. */
function timedDatabase(db) {
  const statement = (s) => ({
    bind: (...values) => statement(s.bind(...values)),
    // first() through all(), as D1's own does, so its meta (time and rows read) is there too.
    first: (column) => timed("db", 1, () => s.all()).then(ran).then(({ results: [row] }) => {
      if (!row) return null;
      if (column === undefined) return row;
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      return row[column];
    }),
    all: () => timed("db", 1, () => s.all()).then(ran),
    run: () => timed("db", 1, () => s.run()).then(ran),
    raw: (...args) => timed("db", 1, () => s.raw(...args)),
    unwrapped: s,
  });
  return {
    prepare: (sql) => statement(db.prepare(sql)),
    batch: (statements) => timed("db", statements.length, () => db.batch(statements.map((s) => s.unwrapped ?? s))).then(ran),
    batches: db.batches && ((batches) => timed("db", batches.reduce((n, b) => n + b.length, 0),
      () => db.batches(batches.map((b) => b.map((s) => s.unwrapped ?? s))))),
    exec: (sql) => timed("db", 1, () => db.exec(sql)),
    dump: () => db.dump(),
  };
}

/** A Durable Object binding whose objects count each call (an object request: not one of the 50 calls out). */
function countedNamespace(namespace) {
  return new Proxy(namespace, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "get") return (...args) => countedStub(target.get(...args));
      return typeof value === "function" ? (...args) => Reflect.apply(value, target, args) : value;
    },
  });
}

function countedStub(stub) {
  return new Proxy(stub, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop);
      const method = Reflect.get(target, prop);
      if (typeof method !== "function") return method;
      return (...args) => {
        const timing = current.getStore();
        if (timing) timing.objects++;
        // Not method.apply: on a Durable Object's stub, any name (apply too) is a call to the object.
        return Reflect.apply(method, target, args);
      };
    },
  });
}
