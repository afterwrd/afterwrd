// How long a request spent waiting on the database and on other sites, and how many calls out it made, for the
// signed-in owner to see in the browser's devtools (Network → a request → Timing; docs/speed-and-scale-plan.md, step 2).
// It's sent as a Server-Timing header, on the owner's own pages and actions only: friends' sites, groups and anyone
// signed out never see it.
//
// - db: time with at least one query waiting, and how many statements ran (a batch counts each of its statements).
//   On Cloudflare there's a cap of about 1,000 a request.
// - sites: time with at least one call to another site waiting (friends' sites, groups, GitHub), and how many.
// - calls: every call out this request has made so far, other sites and Durable Objects (photos, the Outbox)
//   together. The free plan allows 50 a request. Calls made after the reply has gone (work.waitUntil) also count
//   against the 50 but can't be in the header.
// - total: from the request arriving to the reply being ready.
//
// A Worker's clock only moves while it waits on something (Cloudflare's guard against timing attacks), so these
// are waiting times. CPU time can't be measured from inside: Cloudflare's dashboard shows it.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * @typedef {{ n: number, ms: number, active: number, since: number }} Clock
 * @typedef {{ start: number, db: Clock, sites: Clock, objects: number, show: boolean }} Timing
 */

/** @type {AsyncLocalStorage<Timing>} */
const current = new AsyncLocalStorage();
const clock = () => ({ n: 0, ms: 0, active: 0, since: 0 });
/** Calls out a free-plan request may make (docs/speed-and-scale-plan.md). */
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
  if (c.active++ === 0) c.since = Date.now();
  try {
    return await work();
  } finally {
    if (--c.active === 0) c.ms += Date.now() - c.since;
  }
}

// Every fetch() a site makes, wherever it is in the code, is timed while a request is being measured.
const original = globalThis.fetch;
globalThis.fetch = (...args) => timed("sites", 1, () => original(...args));

/**
 * Runs `answer` (one request) with its own timing.
 * @template T
 * @param {() => Promise<T>} answer
 */
export function measure(answer) {
  return current.run({ start: Date.now(), db: clock(), sites: clock(), objects: 0, show: false }, answer);
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
  const { db, sites, objects, start } = timing;
  return [
    `db;dur=${db.ms};desc="Database: ${db.n} ${db.n === 1 ? "query" : "queries"}"`,
    `sites;dur=${sites.ms};desc="Other sites: ${sites.n} ${sites.n === 1 ? "call" : "calls"}"`,
    `calls;desc="Calls out: ${sites.n + objects} of ${CALLS_ALLOWED}"`,
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

/** D1 (or the self-hosted stand-in), with each statement's wait timed. */
function timedDatabase(db) {
  const statement = (s) => ({
    bind: (...values) => statement(s.bind(...values)),
    first: (...args) => timed("db", 1, () => s.first(...args)),
    all: () => timed("db", 1, () => s.all()),
    run: () => timed("db", 1, () => s.run()),
    raw: (...args) => timed("db", 1, () => s.raw(...args)),
    unwrapped: s,
  });
  return {
    prepare: (sql) => statement(db.prepare(sql)),
    batch: (statements) => timed("db", statements.length, () => db.batch(statements.map((s) => s.unwrapped ?? s))),
    exec: (sql) => timed("db", 1, () => db.exec(sql)),
    dump: () => db.dump(),
  };
}

/** A Durable Object binding whose objects count each call as one call out. */
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
