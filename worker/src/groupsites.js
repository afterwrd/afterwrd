// Starting a group: this site makes the group its own Worker in the owner's Cloudflare account, with its own database,
// running this same afterwrd release in group mode (groups.js), at <name>.<their subdomain>.workers.dev. It needs the
// owner's Cloudflare connection (cloudflare.js: an hour's token from Connect).
// Each step is its own request (the free plan allows 50 calls out per request), driven by the page (views.js):
//   POST /_groups/create/check    {name} -> {account, script}: the account, and a free name for the Worker
//   POST /_groups/create/assets   {account, script} -> {jwt}: the release's site files
//   POST /_groups/create/deploy   {account, script, jwt, name, about} -> {id}: the database, the code with a new
//                                 GROUP_KEY secret, and its workers.dev address; and a row here, waiting to claim it
//   POST /_groups/create/wait     {id} -> {ready}: whether it's answering yet
//   POST /_groups/create/claim    {id} -> {id}: this site becomes the group's owner (membership.js)
//   POST /_groups/create/local    {origin, setup, name, about} -> {id}: a group's site already running, instead of the
//                                 steps before claiming: on a self-hosted server (hosting.js), one made there by a
//                                 command, from the address and setup code it gave; or, testing, one on this computer
// And for a group this site made (its owner only):
//   POST /_groups/<id>/delete     the group tells its members it's closing, then its Worker and database go
// Updating groups to this site's version is on the Update page (update.js), with the same connection.
import pkg from "../package.json";
import { tokenFor } from "./cloudflare.js";
import { api, deployVersion, existingDatabase, FILES_AT_ONCE, findWorker, loadRelease, uploadAssets, workerSettings } from "./deploy.js";
import { claimGroup, forgetGroup } from "./membership.js";
import { cleanText, MAX_GROUP_ABOUT, MAX_GROUP_NAME } from "./groups.js";
import { ownerName, siteOrigin } from "./peers.js";
import { json, now, randomToken } from "./util.js";
import { selfHosted } from "./hosting.js";

export const GROUP_RELEASE = `https://github.com/${pkg.afterwrd.releases}/releases/download/v${pkg.version}`;
const SCRIPT_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;

/** This site's Worker name and workers.dev subdomain, from its address; throws if it isn't on workers.dev. */
export function whereAmI(url) {
  if (!url.hostname.endsWith(".workers.dev")) throw new Error("This works from your site's workers.dev address.");
  const [script, ...rest] = url.hostname.split(".");
  return { script, domain: rest.join(".") };
}

/** A Worker name for the group: this site's, then the group's, as letters, numbers and dashes. */
function scriptName(own, name, n) {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  const suffix = n > 1 ? `-${n}` : "";
  return `${own}-${slug}`.slice(0, 63 - suffix.length).replace(/-+$/, "") + suffix;
}

export async function databaseNamed(token, account, name) {
  return (await api(token, `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name) ?? null;
}

/** Whether nothing in the account has this name yet: no Worker, and no database (which would hold someone's data). */
async function isFree(token, account, script) {
  return !(await workerSettings(token, account, script)) && !(await databaseNamed(token, account, script));
}

async function create(request, env, url, path, body) {
  const db = env.DB;
  // A group's site that's already running, which this site then claims: on a self-hosted server, one made there with
  // a command (selfhost/), which gave the owner its address and setup code; or, when testing, one on this computer.
  if (path === "/local") {
    const origin = siteOrigin(body.origin, env);
    const testing = env.ALLOW_LOCAL_SITES === "1" && origin?.startsWith("http://");
    if (!testing && !(selfHosted(env) && origin?.startsWith("https://"))) return json({ error: "Not found." }, 404);
    // A plain address (letters, numbers, dots and dashes): it's shown in a command to run on the server.
    if (!/^[a-z0-9.-]+$/.test(new URL(origin).hostname)) throw new Error("That doesn't look like a group's address.");
    if (origin === url.origin) throw new Error("That's your own site's address. Use the group's.");
    // One waiting at a time for an address, and none left for long (a page closed part-way through).
    await db.prepare("DELETE FROM groups WHERE joined_at IS NULL AND script = '' AND (origin = ? OR created_at < ?)")
      .bind(origin, now() - 86400).run();
    return json({ id: await waitingRow(db, { origin, setup: body.setup, name: body.name, about: body.about }) });
  }
  // Self-hosted, there's no Cloudflare account to make a group's site in (hosting.js).
  if (selfHosted(env) && path !== "/wait" && path !== "/claim") return json({ error: "Not found." }, 404);
  if (path === "/wait") {
    const group = await db.prepare("SELECT origin FROM groups WHERE id = ? AND joined_at IS NULL AND script IS NOT NULL").bind(Number(body.id)).first();
    if (!group) return json({ error: "That group isn't waiting to be set up." }, 404);
    const ready = await fetch(`${group.origin}/_group/ping`, { redirect: "manual", signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok).catch(() => false);
    return json({ ready });
  }
  if (path === "/claim") {
    try {
      return json({ id: await claimGroup(env, url, body.id) });
    } catch (error) {
      // A group's site made elsewhere (/local: no Worker of this site's to finish) that said no (a mistyped setup
      // code, say): what was noted goes, so it can simply be typed again. Not when there was no clear answer: the
      // group may have taken the claim.
      if ([400, 401, 403].includes(error.status)) {
        await db.prepare("DELETE FROM groups WHERE id = ? AND joined_at IS NULL AND script = ''").bind(Number(body.id)).run();
      }
      throw error;
    }
  }

  const { script: own, domain } = whereAmI(url);
  const token = tokenFor(request);
  if (path === "/check") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("Give the group a name.");
    const { account } = await findWorker(token, url.hostname);
    // Before anything's made: the token must be able to manage databases too.
    try {
      await api(token, `/accounts/${account}/d1/database?per_page=1`);
    } catch {
      throw new Error("That Cloudflare connection can't make databases, which a group needs. Connect Cloudflare again, and Allow everything it asks.");
    }
    for (let n = 1; n <= 9; n++) {
      const script = scriptName(own, name, n);
      if (await isFree(token, account, script)) return json({ account, script, address: `${script}.${domain}` });
    }
    throw new Error("Couldn't find a free name for the group's Worker. Try a different group name.");
  }
  if (!ACCOUNT_RE.test(body.account ?? "") || !SCRIPT_RE.test(body.script ?? "") || !body.script.startsWith(`${own}-`)) {
    throw new Error("Unexpected details.");
  }
  if (path === "/assets") return json({ jwt: await uploadAssets(token, body.account, body.script, await loadRelease(GROUP_RELEASE), { most: FILES_AT_ONCE }) });
  if (path === "/deploy") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_GROUP_NAME) : "";
    if (!name) throw new Error("Give the group a name.");
    // Checked again here, so a group never lands on someone else's Worker or database.
    if (!(await isFree(token, body.account, body.script))) throw new Error("That name has just been taken. Start again.");
    const database = await api(token, `/accounts/${body.account}/d1/database`, { method: "POST", body: JSON.stringify({ name: body.script }) });
    const setup = randomToken();
    // Noted here straight away, so that if anything after this fails, the group can still be deleted from Groups.
    const id = await waitingRow(db, { origin: `https://${body.script}.${domain}`, setup, name, about: body.about,
      script: body.script, account: body.account, database: database.uuid });
    await deployVersion(token, body.account, body.script, await loadRelease(GROUP_RELEASE),
      { jwt: body.jwt, databaseId: database.uuid, settings: {}, secrets: { GROUP_KEY: setup } });
    // A Worker made through the API isn't on its workers.dev address until it's switched on.
    await api(token, `/accounts/${body.account}/workers/scripts/${body.script}/subdomain`, {
      method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    return json({ id });
  }
  return json({ error: "Not found." }, 404);
}

/** A row for a group Worker that's waiting to be claimed: it holds the GROUP_KEY until then (membership.js). */
async function waitingRow(db, { origin, setup, name, about, script = "", account = "", database = null }) {
  if (typeof setup !== "string" || !setup || typeof name !== "string" || !name.trim()) throw new Error("Unexpected details.");
  const row = await db.prepare(`INSERT INTO groups (name, about, created_at, origin, remote_id, host_name, their_key, role, script, account, database)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'owner', ?, ?, ?) RETURNING id`).bind(name.trim().slice(0, MAX_GROUP_NAME),
    cleanText(about).slice(0, MAX_GROUP_ABOUT) || null, now(), origin, await ownerName(db), setup, script, account, database).first();
  return row.id;
}

/** Whether the Worker these are the settings of is still this group's: bound to the database made for it. */
export const isGroupWorker = (settings, group) => Boolean(settings && group.database && existingDatabase(settings) === group.database);

/**
 * Deletes a group this site made: the group tells its members' sites, then its Worker and database are deleted. Only
 * that Worker (still bound to the database made for it) and that database, never anything else that has its name. A
 * group with no Worker (self-hosted, or testing) is told to close and empty itself, and then forgotten here.
 */
async function remove(request, env, url, group, body) {
  if (group.role !== "owner") throw new Error("Only the group's owner can delete it.");
  if (group.script) {
    const token = tokenFor(request);
    if (!ACCOUNT_RE.test(group.account ?? "") || !group.database) throw new Error("Unexpected details.");
    // Check the token can do it before anything's emptied.
    const settings = await workerSettings(token, group.account, group.script);
    if (group.joined_at) await fetchClose(group);
    if (isGroupWorker(settings, group)) {
      // force: a Worker with stored data (its photos, its notes waiting) is only deleted with it.
      await api(token, `/accounts/${group.account}/workers/scripts/${group.script}?force=true`, { method: "DELETE" });
    }
    try {
      await api(token, `/accounts/${group.account}/d1/database/${group.database}`, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) throw error; // already gone (a deletion that stopped halfway, tried again)
    }
  } else if (group.joined_at) {
    await fetchClose(group); // a group's site on a self-hosted server (its data goes by a command there), or testing here
  }
  await forgetGroup(env.DB, group);
  return json({ ok: true });
}

async function fetchClose(group) {
  const response = await fetch(`${group.origin}/_group/admin/close`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000), body: "{}",
    headers: { Authorization: `Bearer ${group.their_key}`, "Content-Type": "application/json" },
  }).catch(() => null);
  await response?.body?.cancel();
  // A group that's already gone, or unreachable, is deleted all the same.
}

/** POST /_groups/create/… and /_groups/<id>/delete (the Origin check is done by the caller, membership.js). */
export async function handleGroupSites(request, env, url, group = null) {
  const body = await request.json().catch(() => ({}));
  try {
    return group ? await remove(request, env, url, group, body) : await create(request, env, url, url.pathname.slice("/_groups/create".length), body);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}
