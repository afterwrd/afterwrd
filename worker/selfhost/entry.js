// afterwrd on its own server: the release's code (index.js, bundled exactly as for Cloudflare) with the pieces
// Cloudflare would provide filled in (docs/self-hosting-plan.md). The database is a Durable Object (d1.js); every
// other binding comes from workerd's config (config.mjs).
import site, { MediaStore as Media, Outbox as Notes } from "./index.js";
import { d1, Database } from "./d1.js";

export { Database };

const wrapped = new WeakMap();

/** env with DB, the stand-in for D1, added. The same object each time for the same env. */
function withDatabase(env) {
  let full = wrapped.get(env);
  if (!full) {
    full = { ...env, DB: d1(env.DATABASE) };
    wrapped.set(env, full);
  }
  return full;
}

export class MediaStore extends Media {
  constructor(ctx, env) {
    super(ctx, withDatabase(env));
  }
}

export class Outbox extends Notes {
  constructor(ctx, env) {
    super(ctx, withDatabase(env));
  }
}

export default {
  fetch: (request, env, ctx) => site.fetch(request, withDatabase(env), ctx),
};
