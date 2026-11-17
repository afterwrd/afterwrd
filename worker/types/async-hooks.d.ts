// The one Node module the Worker uses (nodejs_compat in wrangler.jsonc): AsyncLocalStorage, for timing each request
// (src/timing.js). Just what's used, rather than all of Node's types.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
