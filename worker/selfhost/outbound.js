// Every call a site makes out (to friends' sites, groups, GitHub) comes through here (config.mjs). A call to another
// site on this same server is answered here directly: many home servers can't reach their own public address from
// inside, and it saves a trip out and back. Everything else goes to the internet service, which only connects to
// public addresses: never to this computer, the home network, or a cloud server's metadata address, whatever a
// name resolves to (docs/self-hosting-plan.md).
//   env.SITES  {"<host>": "<binding name>"}, and a service binding of that name for each site; env.INTERNET
//   env.TEST_NET  tests only (test/scale, never in a real server's config): calls between sites are made as slow and
//                 unreliable as on Cloudflare, {minMs, maxMs, slowRate, slowMs, hangRate, hangMs, failRate}, and with
//                 internet: false nothing else goes out at all.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tests only: waits as a call to a friend's site on Cloudflare would; null to carry on, or what to answer instead. */
async function asOnCloudflare(net) {
  const roll = Math.random();
  if (roll < net.failRate) {
    await sleep(net.minMs);
    throw new TypeError("Network connection lost.");
  }
  if (roll < net.failRate + net.hangRate) {
    await sleep(net.hangMs);
    return new Response("Timed out (test)", { status: 504 });
  }
  const slow = roll < net.failRate + net.hangRate + net.slowRate;
  await sleep(slow ? net.slowMs : net.minMs + Math.random() * (net.maxMs - net.minMs));
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const binding = url.protocol === "https:" && !url.port && Object.hasOwn(env.SITES, host) ? env.SITES[host] : null;
    if (env.TEST_NET) {
      if (!binding && env.TEST_NET.internet === false) throw new TypeError("No internet in this test.");
      if (binding) {
        const instead = await asOnCloudflare(env.TEST_NET);
        if (instead) return instead;
      }
    }
    return binding ? env[binding].fetch(request) : env.INTERNET.fetch(request);
  },
};
