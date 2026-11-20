// The owner's area (/_admin): Your devices is here (passkeys for the owner's phones and computers, links to add
// another, signing out everywhere), and every other owner page is routed from here. Only the owner signs in, so
// no one else needs a way in: friends see each other from their own sites (connect.js).
// scripts/owner.mjs makes the first device link for a new site from the terminal.
import { handleKeys, identitySummary } from "./keys.js";
import { forgetDeviceById, listDevices, pushDevicesSeen } from "./push.js";
import { handleCheckAdmin } from "./checks.js";
import { handleConnections } from "./connect.js";
import { handleExport } from "./export.js";
import { handleImport } from "./importer.js";
import { handlePhotos, headerMe } from "./photos.js";
import { handlePosts } from "./posts.js";
import { handleEvents } from "./events.js";
import { handleUpdate } from "./update.js";
import { recoveredSeen, recovering } from "./recover.js";
import { html, json, now, pageData, randomToken, Refusal, sha256 } from "./util.js";
import { devicesPage } from "./views/devices.js";
import { setupDonePage } from "./views/pages.js";

// A device link grants owner access to whoever opens it, so it's short-lived.
export const DEVICE_LINK_SECONDS = 3600;

export async function handleAdmin(request, env, url, owner) {
  if (url.pathname === "/_admin/keys" || url.pathname.startsWith("/_admin/keys/")) return handleKeys(request, env, url, owner);
  if (url.pathname === "/_admin/import" || url.pathname.startsWith("/_admin/import/")) {
    return handleImport(request, env, url, owner);
  }
  if (url.pathname === "/_admin/update" || url.pathname.startsWith("/_admin/update/")) {
    return handleUpdate(request, env, url, owner);
  }
  if (url.pathname.startsWith("/_admin/checks/")) return handleCheckAdmin(request, env, url);
  if (url.pathname === "/_admin/posts" || url.pathname.startsWith("/_admin/posts/")) return handlePosts(request, env, url);
  if (url.pathname === "/_admin/events" || url.pathname.startsWith("/_admin/events/")) return handleEvents(request, env, url);
  if (/^\/_admin\/(photos|albums|profile)(\/|$)/.test(url.pathname)) return handlePhotos(request, env, url, owner);
  if (url.pathname === "/_admin/export" || url.pathname.startsWith("/_admin/export/")) return handleExport(request, env, url, owner);
  if (url.pathname === "/_admin/connections" || url.pathname.startsWith("/_admin/connections/")) {
    return handleConnections(request, env, url, owner);
  }
  if (request.method === "GET" && url.pathname === "/_admin") {
    return html(devicesPage(pageData(env, { ...(await devicesData(env.DB, owner)), me: await headerMe(env.DB, owner) })));
  }
  // Where a new site's setup ends, after its permissions (views/pages.js afterPasskey).
  if (request.method === "GET" && url.pathname === "/_admin/setup/done") return html(setupDonePage());
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  // Notifications about events (push.js): turning a device off from here, and "That was me" on Home's notice.
  const forget = /^\/_admin\/notifications\/(\d+)\/forget$/.exec(url.pathname);
  if (forget) {
    await forgetDeviceById(env, forget[1]);
    return Response.redirect(`${url.origin}/_admin`, 303);
  }
  if (url.pathname === "/_admin/notifications/seen") {
    await pushDevicesSeen(env);
    return Response.redirect(`${url.origin}/`, 303);
  }

  const body = await request.json().catch(() => ({}));
  // While a recovery through Cloudflare waits for its new passkey (recover.js), a session that slipped in from before
  // it can't make a way in of its own, or cancel the recovery's link.
  if (/^\/_admin\/devices\/(link|cancel-links)$/.test(url.pathname) && await recovering(env.DB)) {
    return json({ error: "Someone is getting back into your site without a passkey: finish that first." }, 409);
  }
  const action = /^\/_admin\/devices\/(link|cancel-links|sign-out|delete-passkey|seen|recovered-seen)$/.exec(url.pathname)?.[1];
  try {
    switch (action) {
      case "seen":
        await devicesSeen(env, owner);
        return Response.redirect(`${url.origin}/`, 303);
      case "recovered-seen": // "Done" on Home's notice after getting back in through Cloudflare (recover.js)
        await recoveredSeen(env, owner);
        return Response.redirect(`${url.origin}/`, 303);
      case "link":
        return json({ link: await createDeviceLink(env, url, owner.id) });
      case "cancel-links":
        await cancelDeviceLinks(env, owner);
        return json({ ok: true });
      case "sign-out":
        await signOutEverywhere(env, owner);
        return json({ ok: true });
      case "delete-passkey":
        await deletePasskey(env, owner, body.credential);
        return json({ ok: true });
    }
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.message }, error.status);
    throw error;
  }
  return new Response("Not found", { status: 404 });
}

// --- actions (see util.js Refusal) -----------------------------------------------------------------------------------

/**
 * "That was me" on Home's new-device notice. Only a device whose own passkey isn't new can say so, so an intruder
 * can't hide their passkey's notice, even by adding a second one and confirming from the first.
 */
export async function devicesSeen(env, owner) {
  if (!(await newDevices(env.DB, owner)).canConfirm) throw new Refusal("Confirm this from one of your older devices.", 403);
  const seen = await env.DB.prepare("SELECT created_at AS at, rowid AS row FROM credentials WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(owner.id).first();
  if (seen?.at) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('devices_seen', ?)").bind(String(seen.at)),
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('devices_seen_row', ?)").bind(String(seen.row)),
    ]);
  }
}

/** Cancels the device links nobody has used yet. */
export async function cancelDeviceLinks(env, owner) {
  await env.DB.prepare("DELETE FROM device_links WHERE user_id = ? AND used_at IS NULL").bind(owner.id).run();
}

/**
 * Signs out on every device, this one included, and turns notifications off on all of them. "Get updates first" goes
 * off too (auto.js setEarly): a session someone else had could have turned it on.
 */
export async function signOutEverywhere(env, owner) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
    env.DB.prepare("DELETE FROM push_devices"),
    env.DB.prepare("UPDATE settings SET value = json_remove(value, '$.early') WHERE key = 'auto_update'"),
    // No browser may sign for the owner here any more (keys.js) until it signs in again.
    env.DB.prepare("DELETE FROM delegations"),
  ]);
}

/** Removes one of the owner's passkeys (never the last), and signs out the device it's on. */
export async function deletePasskey(env, owner, credential) {
  const { results: keys } = await env.DB.prepare("SELECT id FROM credentials WHERE user_id = ?").bind(owner.id).all();
  if (!keys.some((k) => k.id === credential)) throw new Refusal("That isn't one of your passkeys.", 404);
  if (keys.length === 1) throw new Refusal("That's your only passkey; add another device first, or you'd be locked out.", 400);
  // Sign out the device it's on too. Sessions from before 0.15.0 don't say which passkey began them, so they go as well.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?").bind(credential, owner.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND (credential_id = ? OR credential_id IS NULL)").bind(owner.id, credential),
    // And notifications on any device that turned them on while signed in with it (push.js).
    env.DB.prepare("DELETE FROM push_devices WHERE credential_id = ? OR credential_id IS NULL").bind(credential),
    // And browser keys it allowed stop signing for the owner here (keys.js). Taking it out of the owner's identity, so
    // other sites stop believing it too, is a signed change that waits 7 days (docs/signed-conversations.md, 2d).
    env.DB.prepare("DELETE FROM delegations WHERE credential_id = ?").bind(credential),
  ]);
}

// How long Home mentions a newly added device, unless the owner says it was them sooner.
const NEW_DEVICE_SECONDS = 14 * 86400;

// A passkey is "new" while all of these hold: it was added in the last 14 days, it isn't the first one (made when
// the site was set up), and the owner hasn't since said it was them (settings 'devices_seen', 'devices_seen_row').
// Which came first goes by the second it was added, then by the order it was stored: two passkeys added in the same
// second are still told apart (a row's number alone isn't enough, as SQLite can give a deleted row's number again).
// A 'devices_seen' from before 'devices_seen_row' counts everything in that second as seen, as it always did.
const IS_NEW = `created_at > ?2
  AND (created_at, rowid) > (SELECT created_at, rowid FROM credentials WHERE user_id = ?1 ORDER BY created_at, rowid LIMIT 1)
  AND (created_at, rowid) > (COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'devices_seen'), 0),
    COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'devices_seen_row'), 9223372036854775807))`;

/**
 * For a notice on Home ("A new device was added… Not you? Remove it."): someone who got in would add their own
 * passkey to stay in, and this makes that visible. `devices`: the new passkeys other than the one this device signed
 * in with. `canConfirm`: whether this device may say they were all the owner's, which needs its own passkey not to be
 * new (otherwise a new passkey could vouch for itself or for another the same person added).
 */
export async function newDevices(db, owner) {
  const since = now() - NEW_DEVICE_SECONDS;
  const [{ results: devices }, { results: own }] = await db.batch([
    db.prepare(`SELECT id, created_at FROM credentials WHERE user_id = ?1 AND ${IS_NEW} AND id IS NOT ?3 ORDER BY created_at`)
      .bind(owner.id, since, owner.session_credential ?? null),
    db.prepare(`SELECT ${IS_NEW} AS new FROM credentials WHERE user_id = ?1 AND id = ?3`)
      .bind(owner.id, since, owner.session_credential ?? null),
  ]);
  return { devices, canConfirm: own.length === 1 && !own[0].new };
}

// Only a hash is stored, so the link can be shown once and never again.
export async function createDeviceLink(env, url, userId, seconds = DEVICE_LINK_SECONDS) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO device_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now() + seconds).run();
  return `${url.origin}/_auth/device/${token}`;
}

/** Your devices: the owner's passkeys, how many device links are still unused, and how many devices are signed in. */
async function devicesData(db, owner) {
  const [{ results: passkeys }, links, sessions] = await db.batch([
    db.prepare("SELECT id, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY created_at").bind(owner.id),
    db.prepare("SELECT COUNT(*) AS n FROM device_links WHERE user_id = ? AND used_at IS NULL AND expires_at > ?").bind(owner.id, now()),
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(owner.id, now()),
  ]);
  return { owner: owner.name, passkeys, openLinks: links.results[0].n, sessions: sessions.results[0].n, notifying: await listDevices(db),
    identity: await identitySummary(db), thisCredential: owner.session_credential ?? null };
}
