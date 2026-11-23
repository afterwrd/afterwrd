// Work to finish after a request has been answered (its waitUntil), from anywhere in handling it, without passing the
// request's context down through every call. app.js handle runs each request inside `withWork`.
import { AsyncLocalStorage } from "node:async_hooks";

/** @type {AsyncLocalStorage<{ waitUntil?: (promise: Promise<any>) => void } | null>} */
const current = new AsyncLocalStorage();

/** Runs `fn` with `work` (a request's context: {waitUntil}) as where `later` hands work to. */
export const withWork = (work, fn) => current.run(work ?? null, fn);

/** Hands `promise` to the request's waitUntil, to finish after the answer has gone; false if there's none to hand it to. */
export function later(promise) {
  const work = current.getStore();
  if (!work?.waitUntil) return false;
  work.waitUntil(promise);
  return true;
}
