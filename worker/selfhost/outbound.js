// Every call a site makes out (to friends' sites, groups, GitHub) comes through here (config.mjs). A call to another
// site on this same server is answered here directly: many home servers can't reach their own public address from
// inside, and it saves a trip out and back. Everything else goes to the internet service, which only connects to
// public addresses: never to this computer, the home network, or a cloud server's metadata address, whatever a
// name resolves to (docs/self-hosting-plan.md).
//   env.SITES  {"<host>": "<binding name>"}, and a service binding of that name for each site; env.INTERNET
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const binding = url.protocol === "https:" && !url.port ? env.SITES[url.hostname.toLowerCase()] : null;
    return binding ? env[binding].fetch(request) : env.INTERNET.fetch(request);
  },
};
