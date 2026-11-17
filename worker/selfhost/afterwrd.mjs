// afterwrd's tools on a self-hosted server, run inside the container:
//
//   docker compose exec afterwrd owner "Your Name"         make yourself the owner of your new site: a link to open
//   docker compose exec afterwrd owner                     a link to add another phone or computer
//   docker compose exec afterwrd recover                   lost every device: signs them all out, and a link to make a
//                                                          passkey that replaces the old ones
//   docker compose exec afterwrd new-group <address>       a group's site at that address, and its setup code
//   docker compose exec afterwrd delete-group <address>    removes a group's site and its data (delete the group on
//                                                          your site first, so its members are told)
//   docker compose exec afterwrd sites                     the sites on this server
//
// With more than one person's site on the server, say which: --site me.example.com.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DATA, HOST_RE, readSites, saveSites, TOOLS } from "./serve.mjs";

const args = process.argv.slice(2);
const siteFlag = args.indexOf("--site");
const chosen = siteFlag === -1 ? null : args.splice(siteFlag, 2)[1]?.toLowerCase();
const [command, ...rest] = args;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Asks the tools inside the container (tools.js). */
async function tools(path, body) {
  const res = await fetch(`http://${TOOLS}${path}`, body ? { method: "POST", body: JSON.stringify(body) } : {}).catch(() => null);
  if (!res) fail("Couldn't reach afterwrd in this container. Is it running? (docker compose ps)");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `Something went wrong (${res.status}).`);
  return data;
}

const PORT = Number((process.env.AFTERWRD_LISTEN ?? "*:8080").split(":").pop());

/** What the server answers for a group's site at `host`: 200 when it's there, 404 when not, 0 while it's restarting. */
function groupStatus(host) {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/_group/ping", headers: { Host: host }, timeout: 2000 }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on("error", () => done(0));
    req.on("timeout", () => { req.destroy(); done(0); });
    req.end();
  });
}

async function waitFor(test, what) {
  for (let i = 0; i < 60; i++) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`afterwrd didn't ${what} within a minute. See: docker compose logs afterwrd`);
}

/** The person's site a command is for. */
function personSite(sites) {
  const people = sites.filter((s) => !s.group);
  if (chosen) {
    if (!people.some((s) => s.host === chosen)) fail(`There's no person's site at ${chosen} on this server.`);
    return chosen;
  }
  if (people.length > 1) fail(`There's more than one site here; say which with --site (${people.map((s) => s.host).join(", ")}).`);
  return people[0].host;
}

const address = (text) => {
  const host = String(text ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!HOST_RE.test(host)) fail(`Give the address, like walkers.example.com${text ? ` ("${text}" isn't one)` : ""}.`);
  return host;
};

const sites = readSites();
if (command === "owner") {
  const name = rest.join(" ").trim();
  const made = await tools("/owner", { host: personSite(sites), name });
  console.log(`${name ? `${made.name} owns the site now. ` : ""}A link to add a phone or computer, for ${made.name}:\n\n  ${made.link}\n`);
  console.log(`It works once, for ${made.minutes} minutes, and gives owner access: open it only on your own device.`);
} else if (command === "recover") {
  const made = await tools("/recover", { host: personSite(sites) });
  console.log(`Every device signed in to the site has been signed out. Open this on the phone or computer you'll use now:\n\n  ${made.link}\n`);
  console.log(`It works once, for ${made.minutes} minutes. The passkey you make with it replaces all the others,`);
  console.log("so a lost phone can't sign in again. Add your other devices afresh from Your devices.");
} else if (command === "new-group") {
  const host = address(rest[0]);
  if (sites.some((s) => s.host === host)) fail(`There's already a site at ${host} on this server.`);
  const key = randomBytes(32).toString("base64url");
  saveSites([...sites, { host, group: true, key }]);
  console.log(`Starting the group's site at https://${host}…`);
  await waitFor(async () => (await groupStatus(host)) === 200, "start the group's site");
  console.log(`\nIts setup code:\n\n  ${key}\n`);
  console.log(`On your site: Groups → Start a group, and give the address ${host} and that code.`);
  console.log(`Its address must reach this server, as your site's does (DNS, and ${host} in your Caddyfile or tunnel).`);
} else if (command === "delete-group") {
  const host = address(rest[0]);
  const group = sites.find((s) => s.host === host);
  if (!group?.group) fail(`There's no group's site at ${host} on this server.`);
  if (!rest.includes("--yes")) {
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await ask.question(`This removes the group's site at ${host} and everything in it. Delete the group on your\n`
      + `site first, so its members are told. Type the address again to go ahead: `);
    ask.close();
    if (typed.trim().toLowerCase() !== host) fail("Nothing was removed.");
  }
  saveSites(sites.filter((s) => s.host !== host));
  // Gone once workerd is running again without it: only then is its folder unused.
  await waitFor(async () => (await groupStatus(host)) === 404, "stop the group's site");
  rmSync(join(DATA, "sites", host), { recursive: true, force: true });
  console.log(`Removed the group's site at ${host}, and its data.`);
} else if (command === "sites") {
  for (const site of sites) console.log(`${site.group ? "group " : "person"}  https://${site.host}`);
} else {
  fail(`afterwrd's tools: owner ["Your Name"], recover, new-group <address>, delete-group <address>, sites`);
}
