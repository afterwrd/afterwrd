// Where an afterwrd site runs: on Cloudflare (each person's own account, the usual way), or on someone's own server
// (selfhost/, docs/self-hosting-plan.md), where the setting HOSTING is "self".
//
// Self-hosted, the same code runs, but everything done through Cloudflare's API isn't there: installing and
// updating (the server pulls a new image instead), automatic updates, getting back in through Cloudflare, starting
// groups as Workers, and friends' checks, both ways. A check reads what Cloudflare says about a site, and nothing
// outside someone's own server can say what runs on it. So a self-hosted site can't be checked; and it can't check
// others, as Cloudflare's answers only ever come back to a workers.dev address (installer/connect.html).

/** Whether this site runs on its owner's own server rather than on Cloudflare. */
export const selfHosted = (env) => env.HOSTING === "self";

/**
 * Whether the site at `origin` is on Cloudflare, so friends' sites can check it: by its address, which a tampered
 * site can't change (a site saying it's self-hosted could be lying to dodge its checks). Every afterwrd site on
 * Cloudflare is at its workers.dev address; any other address is a self-hosted site. Testing here, sites are on
 * localhost, and TEST_SELF_HOSTED lists the ones that stand for self-hosted sites.
 * @param {string} origin
 * @param {{ ALLOW_LOCAL_SITES?: string, TEST_SELF_HOSTED?: string }} env
 */
export function onCloudflare(origin, env) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && url.hostname.endsWith(".workers.dev")) return true;
  const testing = env.ALLOW_LOCAL_SITES === "1" && ["localhost", "127.0.0.1"].includes(url.hostname);
  return testing && !(env.TEST_SELF_HOSTED ?? "").split(/\s+/).includes(url.origin);
}

/** The command that runs one of afterwrd's tools on a self-hosted server (selfhost/README.md). */
export const serverCommand = (tool) => `docker compose exec afterwrd ${tool}`;
