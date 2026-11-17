// afterwrd on its own server: the release's code (index.js, bundled exactly as for Cloudflare), whose site object
// holds the database just as it does on Cloudflare (src/sqlite.js; docs/site-object-plan.md). The Database object
// (d1.js) is where a site's database was kept before that: its own object copies it in once (src/sitecopy.js), and
// it's kept for that. Every other binding comes from workerd's config (config.mjs).
import site, { MediaStore, Outbox } from "./index.js";
import { Database } from "./d1.js";

export { Database, MediaStore, Outbox };

export default {
  fetch: (request, env, ctx) => site.fetch(request, env, ctx),
};
