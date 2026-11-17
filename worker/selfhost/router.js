// Every visit to the server comes in here (config.mjs), from Caddy or a tunnel in front, which deals with HTTPS. It's
// sent on to the site at the address it was for. Sites must see their own https:// address, as passkeys, friends'
// sites and every link they make depend on it, so the request is passed on as https, whatever came in.
//   env.SITES  {"<host>": "<binding name>"}, and a service binding of that name for each site
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // Only the sites listed, never an inherited name like "__proto__".
    const binding = Object.hasOwn(env.SITES, host) ? env.SITES[host] : null;
    if (!binding) return new Response("There's no afterwrd site at this address on this server.", { status: 404 });
    return env[binding].fetch(new Request(`https://${host}${url.pathname}${url.search}`, request));
  },
};
