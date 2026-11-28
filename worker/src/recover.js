// Getting back in without a passkey: the owner has lost every device they sign in with, but can still sign in to the
// Cloudflare account their site is in. Whoever can change the site's Worker there already has the site (they could
// change its code), so proving that gives nothing away that wasn't already theirs. Reading isn't enough: a friend's
// check is given read access (checks.js), and a code someone was talked into allowing for that must never open this.
//   GET  /_auth/recover            what happens, and a button
//   GET  /_auth/recover/start      a fresh PKCE secret and state in a short cookie, and the page before Cloudflare's,
//                                  which asks for an hour's access to change Workers (cloudflare.js allowLink)
//   GET  /_auth/recover/done#code=…&state=…  back from the relay: a tiny page posts the code to…
//   POST /_auth/recover/finish {code, state}  swaps the code for the token; finds this site's own Worker in the
//                                  account whose workers.dev name is this address's, serving the version answering
//                                  now; and proves the token can change it, by making that same version live again
//                                  (no change, and the step automatic updates make). Then every device is signed out
//                                  and a one-hour device link handed back. Until it's used (or runs out), the older
//                                  passkeys can't sign in; when it's used, they're removed (auth.js registerVerify).
// The token is used for those few calls and then dropped. Anyone can start this (and learn its PKCE secret, as it's in
// the cookie they're given), which is why the proof has to be a change, not a read.
import { createDeviceLink, DEVICE_LINK_SECONDS } from "./admin.js";
import { sign, verify } from "./auth.js";
import { releaseLock, takeLock } from "./auto.js";
import { cloudflareReader } from "./checks.js";
import { allowLink, allowPage, CODE_RE, donePage, exchangeCode, readCookie, testingHere, withCookie } from "./cloudflare.js";
import { switchTo, useApiBase } from "./deploy.js";
import { html, json, now, sha256 } from "./util.js";
import { recoverPage } from "./views/pages.js";

const COOKIE = "__Host-recover";
const COOKIE_SECONDS = 600;
const CLEAR = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const MOST_ACCOUNTS = 10; // each is one or two of the 50 outside calls a request may make

/** The steps under /_auth/recover; null for any other path. POSTs have had their Origin checked (auth.js). */
export async function handleRecover(request, env, url, body, signedIn) {
  const path = url.pathname.slice("/_auth/recover".length);
  if (request.method === "GET" && path === "") return signedIn ? Response.redirect(`${url.origin}/`, 302) : html(recoverPage());
  if (request.method === "GET" && path === "/done") return html(donePage("/_auth/recover/finish"));
  if (request.method === "GET" && path === "/start") return start(request, env, url);
  if (request.method === "POST" && path === "/finish") return finish(request, env, url, body);
  return null;
}

// What recovery asks Cloudflare for: an hour's access to change Workers, never read-only, as anyone can start it and the
// proof has to be a change (above).
const RECOVER_SCOPES = "workers-scripts.edit";

// A link, not a form: the site's pages may only send forms to the site itself (index.js, form-action), and this goes
// on to Cloudflare. Only from this site's own page (or typed in), as cloudflare.js's start.
async function start(request, env, url) {
  const from = request.headers.get("Sec-Fetch-Site");
  if (from && from !== "same-origin" && from !== "none") return html(recoverPage(), 403);
  const { verifier, state, link } = await allowLink(`${url.origin}/_auth/recover/done`, RECOVER_SCOPES);
  // Lax, so the cookie comes along when the relay page sends the browser back here. Signed by this site, so finish
  // knows it started it before writing anything or taking the update lock (security review 2026-11 L15).
  const mac = await sign(env, `recover.${state}.${verifier}`);
  return withCookie(html(allowPage("recover", link, url.host)),
    `${COOKIE}=${state}.${verifier}.${mac}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

async function finish(request, env, url, body) {
  const [state, verifier, mac] = (readCookie(request, COOKIE) ?? "").split(".");
  const fail = (error, status = 400) => withCookie(json({ error }, status), CLEAR);
  if (!state || !verifier || !mac || !(await verify(env, `recover.${state}.${verifier}`, mac))) return fail("This has expired. Start again from the sign-in page.");
  if (typeof body.state !== "string" || body.state !== state) return fail("That isn't the one this page started. Start again from the sign-in page.");
  if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return fail("Cloudflare didn't send a code.");
  const owner = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
  if (!owner) return fail("This site hasn't been set up yet: use the setup link from the installer.", 409);
  // An update makes a version live too: one at a time, with automatic updates' lock, so neither undoes the other.
  const run = await takeLock(env.DB);
  if (!run) return fail("Your site is updating itself just now. Try again in a few minutes.", 409);
  let why;
  try {
    const token = (await exchangeCode(env, body.code, verifier, url.origin)).access_token;
    why = await cantChangeThisSite(token, env, url.origin);
  } catch (error) {
    return fail(`Couldn't finish: ${String(error.message).slice(0, 300)} Try again.`);
  } finally {
    await releaseLock(env.DB, run);
  }
  if (why) return fail(why, 403);
  const link = await createDeviceLink(env, url, owner.id, DEVICE_LINK_SECONDS);
  const hash = await sha256(new URL(link).pathname.split("/").pop() ?? "");
  // Every device is signed out and its notifications turned off: whoever has a lost one shouldn't stay in, or keep
  // seeing events on its lock screen. Older device links go, and so does "Get updates first" (a session no one knew
  // about could have turned it on). Until this link is used or runs out, the older passkeys can't sign in, so someone
  // with a lost device can't get back in and cancel it.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
    env.DB.prepare("DELETE FROM push_devices"),
    env.DB.prepare("DELETE FROM device_links WHERE user_id = ? AND used_at IS NULL AND token_hash != ?").bind(owner.id, hash),
    env.DB.prepare("UPDATE settings SET value = json_remove(value, '$.early') WHERE key = 'auto_update'"),
    env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('recovering', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`)
      .bind(JSON.stringify({ link: hash, at: now(), until: now() + DEVICE_LINK_SECONDS })),
  ]);
  return withCookie(json({ back: new URL(link).pathname }), CLEAR);
}

/**
 * Null if `token` can change this site's own Worker; otherwise why not, in words. The account is the one whose
 * workers.dev name is this address's (each name belongs to one account), the Worker the one named like it, serving
 * the version answering now (alone); and the token must be able to make that version live again, which needs the
 * right to change Workers (read-only access, or an account member who may only look, is refused).
 */
export async function cantChangeThisSite(token, env, origin, fetcher = fetch) {
  // (On this computer wrangler may not say which version it is, so a test can.)
  const running = env.VERSION?.id || (testingHere(env, origin) && env.TEST_VERSION_ID) || null;
  if (!running) return "This site can't say which version of it is running, so it can't be matched with your Cloudflare account.";
  const { getJSON } = cloudflareReader(token, env, origin, fetcher);
  const [script, name] = new URL(origin).hostname.split(".");
  // (On this computer a test says what the stand-in account's name is.)
  const expected = testingHere(env, origin) && env.TEST_SUBDOMAIN ? env.TEST_SUBDOMAIN : name;
  for (const account of ((await getJSON("/accounts")).result ?? []).slice(0, MOST_ACCOUNTS)) {
    if (typeof account?.id !== "string" || !/^[0-9a-f]{32}$/.test(account.id)) continue;
    const subdomain = (await getJSON(`/accounts/${account.id}/workers/subdomain`).catch(() => ({}))).result?.subdomain;
    if (!expected || subdomain !== expected) continue;
    const at = `/accounts/${account.id}/workers/scripts/${encodeURIComponent(script)}/deployments`;
    const serving = (await getJSON(at).catch(() => ({}))).result?.deployments?.[0]?.versions ?? [];
    if (serving.length !== 1 || serving[0]?.version_id !== running || serving[0]?.percentage !== 100) {
      return "That Cloudflare account isn't serving this version of your site just now. If it's just been updated, try again in a few minutes.";
    }
    useApiBase(testingHere(env, origin) && env.CLOUDFLARE_API_URL ? env.CLOUDFLARE_API_URL : null);
    try {
      await switchTo(token, account.id, script, running);
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        return "That Cloudflare sign-in can look at your site but not change it, so it can't be used to get in. Sign in as the account's owner, or someone who can change its Workers.";
      }
      throw error;
    }
    return null;
  }
  return "The Cloudflare account you allowed isn't the one this site is in. Sign in to Cloudflare as the account your site is in, and try again.";
}

/**
 * While a recovery's device link is waiting (recover.js finish): {link (its hash), at, until}. The older passkeys
 * can't sign in meanwhile (auth.js loginVerify). Null when there isn't one.
 */
export async function recovering(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'recovering'").first();
  const pending = row ? JSON.parse(row.value) : null;
  return pending && pending.until > now() ? pending : null;
}

/**
 * The statements that finish a recovery once its link has made a passkey (auth.js registerVerify, in its batch): the
 * other passkeys go (and with them anything still signed in), and Home says what happened, on that device.
 */
export const recoveryDone = (db, userId, credential) => [
  db.prepare("DELETE FROM credentials WHERE user_id = ? AND id != ?").bind(userId, credential),
  db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  db.prepare("DELETE FROM push_devices"),
  db.prepare("DELETE FROM settings WHERE key = 'recovering'"),
  db.prepare(`INSERT INTO settings (key, value) VALUES ('recovered', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`)
    .bind(JSON.stringify({ at: now(), credential })),
];

/** For Home: when the owner got back in this way, on the device that did it. Null otherwise. */
export async function recoveredHere(db, user) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'recovered'").first();
  const done = row ? JSON.parse(row.value) : null;
  if (!done?.at || now() - done.at > 14 * 86400 || !user.session_credential || done.credential !== user.session_credential) return null;
  return done.at;
}

/** "Done" on Home's notice (only shown on the device that got back in). */
export async function recoveredSeen(env, user) {
  if (await recoveredHere(env.DB, user)) await env.DB.prepare("DELETE FROM settings WHERE key = 'recovered'").run();
}
