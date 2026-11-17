// Getting back in without a passkey (src/recover.js), end to end on one local site, with a stand-in on 8799 for
// Cloudflare's token endpoint and API. run.sh starts the site with ALLOW_LOCAL_SITES=1, OAUTH_TOKEN_URL,
// CLOUDFLARE_API_URL, TEST_SUBDOMAIN=ann (the stand-in account's workers.dev name) and TEST_VERSION_ID (in case
// wrangler doesn't say which version is running). The relay page (afterwrd.app/connect/) is stood in for as in
// checks.mjs: the test reads where the site sent the browser, and comes back the way the relay would.
// Which account the stand-in shows depends on the code: "good" (this site's), "elsewhere" (another account), "stale"
// (this site's name, but not serving this version).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { sql } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8787";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

// The version answering here: what wrangler says, or the test's (run.sh TEST_VERSION_ID).
const LIVE = (await (await fetch(`${BASE}/_version`)).json()).id || "22222222-2222-4222-8222-222222222222";

// --- the stand-in for Cloudflare -----------------------------------------------------------------------------------
const exchanges = [];
const deploys = [];
const asked = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8799");
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, data) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
  if (url.pathname === "/token") {
    const params = Object.fromEntries(new URLSearchParams(body));
    exchanges.push(params);
    if (params.code.startsWith("bad.")) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: `tok-${params.code.split(".")[0]}`, token_type: "bearer", expires_in: 3600 });
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const api = url.pathname.replace(/^\/client\/v4/, "");
  asked.push(`${req.method} ${token} ${api}`);
  if (api === "/accounts") {
    return send(200, { success: true, result: token === "tok-elsewhere" ? [{ id: OTHER_ACCOUNT }] : [{ id: OTHER_ACCOUNT }, { id: ACCOUNT }] });
  }
  if (api === `/accounts/${OTHER_ACCOUNT}/workers/subdomain`) return send(200, { success: true, result: { subdomain: "someone-else" } });
  if (api === `/accounts/${ACCOUNT}/workers/subdomain`) return send(200, { success: true, result: { subdomain: "ann" } });
  // Making a version live: only a token that may change Workers can (a check's read-only one, or a member who may
  // only look, is refused).
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/deployments` && req.method === "POST") {
    if (token === "tok-readonly") return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    deploys.push({ token, body: JSON.parse(body) });
    return send(200, { success: true, result: { id: "d2" } });
  }
  if (api === `/accounts/${ACCOUNT}/workers/scripts/localhost/deployments`) {
    const version = token === "tok-stale" ? "33333333-3333-4333-8333-333333333333" : LIVE;
    return send(200, { success: true, result: { deployments: [{ id: "d1", versions: [{ version_id: version, percentage: 100 }] }] } });
  }
  return send(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));

// --- people: the owner's old phone (still signed in), and the new one ------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function device() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  // afterwrd.app's relay page, stood in for: where the site sent the browser is kept.
  page.relay = null;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const at = new URL(req.url());
    if (at.hostname !== "afterwrd.app") return req.continue();
    if (at.pathname === "/connect/") page.relay = at;
    req.respond({ status: 200, contentType: "text/html", body: "<title>relay stand-in</title>" });
  });
  return page;
}
const lost = await device();
const link = execFileSync("node", ["scripts/owner.mjs", "Ann Example", "--local"], { cwd: WORKER, encoding: "utf8" }).match(/http\S+\/_auth\/device\/\S+/)[0];
await lost.goto(link);
await Promise.all([lost.waitForNavigation(), lost.click("#go")]);
const lostCookie = (await lost.cookies()).find((c) => c.name === "__Host-session").value;
const signedIn = async (cookie) => (await fetch(`${BASE}/`, { redirect: "manual", headers: { Cookie: `__Host-session=${cookie}` } })).status === 200;
check("the old phone is signed in", await signedIn(lostCookie));
// Notifications turned on for it, as if it had them (push.js): they should stop.
sql(`INSERT INTO push_devices (endpoint, p256dh, auth, name, created_at, session_hash, credential_id)
  VALUES ('https://push.example/lost', 'k', 'a', 'Lost phone', ${Math.floor(Date.now() / 1000)}, 'x', NULL)`);

const phone = await device();
const words = async (page, selector = "main") => page.$eval(selector, (m) => m.textContent.replace(/\s+/g, " ")).catch(() => "");

// --- from the sign-in page ---------------------------------------------------------------------------------------
await phone.goto(`${BASE}/`);
check("signed out, the sign-in page offers a way back in", Boolean(await phone.$("a[href='/_auth/recover']")));
await Promise.all([phone.waitForNavigation(), phone.click("a[href='/_auth/recover']")]);
const page = await words(phone);
check("…which says what will happen: Cloudflare, nothing kept, every device signed out, the other passkeys replaced",
  page.includes("Cloudflare account your site is in") && page.includes("keeps nothing")
  && page.includes("every device signed in to your site is signed out") && page.includes("replaces the passkeys on all your other devices"));

/** Connect Cloudflare on the new phone, then back from the relay with `code` (and, if given, another state). */
async function connect(code, { state = null } = {}) {
  phone.relay = null;
  await phone.goto(`${BASE}/_auth/recover`);
  await Promise.all([phone.waitForFunction(() => document.title === "relay stand-in"), phone.click("a[href='/_auth/recover/start']")]);
  const relay = phone.relay;
  await phone.goto(`${relay.searchParams.get("to")}#${new URLSearchParams({ code: `${code}.one-time-code`, state: state ?? relay.searchParams.get("state") })}`);
  await phone.waitForFunction(() => location.pathname !== "/_auth/recover/done" || document.getElementById("error")?.textContent, { timeout: 15000 });
  return { relay, error: await words(phone, "#error") };
}

const first = await connect("elsewhere");
check("Connect goes to afterwrd.app's relay page, coming back to the recovery page", first.relay?.searchParams.get("to") === `${BASE}/_auth/recover/done`
  && first.relay.searchParams.get("challenge")?.length === 43 && Boolean(first.relay.searchParams.get("client")));
check("the code is swapped with the PKCE secret, never shown to the relay", exchanges.at(-1)?.code_verifier?.length > 40
  && !first.relay.href.includes(exchanges.at(-1).code_verifier) && exchanges.at(-1).redirect_uri === "https://afterwrd.app/connect/");
check("another Cloudflare account doesn't get anyone in", first.error.includes("isn't the one this site is in") && !(await phone.$("a[href='/_admin']")), first.error);
check("…and nothing was changed: the old phone is still signed in", await signedIn(lostCookie));
const stale = await connect("stale");
check("the right account's name, but a Worker not serving this site now, doesn't either", stale.error.includes("isn't serving this version"), stale.error);
const looking = await connect("readonly");
check("a sign-in that can look at the site but not change it doesn't get in", looking.error.includes("can look at your site but not change it"), looking.error);
const forged = await connect("good", { state: "s".repeat(32) });
check("a code for a connection this browser didn't start is refused", forged.error.includes("isn't the one this page started"), forged.error);
const refused = await connect("bad");
check("Cloudflare refusing the code says so", refused.error.includes("Cloudflare didn't finish connecting"), refused.error);
check("none of those got anyone a device link, or changed anything", sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 0
  && deploys.length === 0 && await signedIn(lostCookie));

// The reviewers' attack: someone starts a recovery themselves (so they hold its PKCE secret, from the cookie), gets the
// owner to allow a friend's check with its challenge, and brings the code back. A check's access only reads.
const theirs = await fetch(`${BASE}/_auth/recover/start`, { redirect: "manual" });
const [stateS, verifierV] = decodeURIComponent(theirs.headers.get("set-cookie").match(/__Host-recover=([^;]+)/)[1]).split(".");
const taken = await fetch(`${BASE}/_auth/recover/finish`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json",
  Cookie: `__Host-recover=${stateS}.${verifierV}` }, body: JSON.stringify({ code: "readonly.from-a-check", state: stateS }) });
check("a code someone was given for a friend's check can't be turned into a way in", taken.status === 403
  && (await taken.json()).error.includes("not change it") && exchanges.at(-1)?.code_verifier === verifierV && deploys.length === 0);

// From somewhere else: another site linking to it, or posting the last step without this browser's cookie.
const start = await fetch(`${BASE}/_auth/recover/start`, { redirect: "manual", headers: { "Sec-Fetch-Site": "cross-site" } });
check("another site can't start it", start.status === 403);
const noCookie = await fetch(`${BASE}/_auth/recover/finish`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" },
  body: JSON.stringify({ code: "good.one-time-code", state: "s".repeat(32) }) });
check("the last step without the browser that started it is refused", noCookie.status === 400 && (await noCookie.json()).error.includes("expired"));
const fromElsewhere = await fetch(`${BASE}/_auth/recover/finish`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
check("…as is one sent from another site", fromElsewhere.status === 403);

// --- the right account --------------------------------------------------------------------------------------------
sql(`UPDATE settings SET value = json_set(value, '$.early', json('true')) WHERE key = 'auto_update'`);
sql(`INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_update', '{"on":false,"early":true}')`);
const before = asked.length;
const good = await connect("good");
check("this site's own account gets a link to add the phone", phone.url().startsWith(`${BASE}/_auth/device/`) && !good.error, `${phone.url()} ${good.error}`);
const writes = asked.slice(before).filter((a) => !a.startsWith("GET "));
check("…its one change in Cloudflare making the running version live again, as it was", writes.length === 1 && deploys.length === 1
  && JSON.stringify(deploys[0].body.versions) === JSON.stringify([{ version_id: LIVE, percentage: 100 }]), writes.join(", "));
check("every device was signed out, the lost phone too", !(await signedIn(lostCookie)) && sql("SELECT COUNT(*) AS n FROM sessions")[0].n === 0);
check("…and its notifications turned off, and \"Get updates first\" too", sql("SELECT COUNT(*) AS n FROM push_devices")[0].n === 0
  && !sql("SELECT value FROM settings WHERE key = 'auto_update'")[0].value.includes("early"));
check("Cloudflare's token was kept nowhere", !JSON.stringify(sql("SELECT * FROM settings")).includes("tok-good"));

// Meanwhile, the lost phone (with its passkey) can't get back in to cancel the link.
await lost.goto(`${BASE}/`);
await lost.click("#go");
await lost.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 10000 }).catch(() => {});
check("while the link waits, the older passkeys can't sign in", (await words(lost, "#error")).includes("getting back into your site without a passkey")
  && lost.url().includes("/_auth/login"), await words(lost, "#error"));

// A sign-in that began just before the recovery and slipped through (as if): it can't make a way in of its own,
// cancel the recovery's link, or turn "Get updates first" back on.
const oldKey = sql("SELECT id FROM credentials ORDER BY created_at LIMIT 1")[0].id;
sql(`INSERT INTO sessions (token_hash, user_id, expires_at, credential_id) VALUES ('${createHash("sha256").update("slipped-in").digest("hex")}', 1,
  ${Math.floor(Date.now() / 1000) + 3600}, '${oldKey}')`);
const asSlipped = (path) => fetch(`${BASE}${path}`, { method: "POST", redirect: "manual",
  headers: { Cookie: "__Host-session=slipped-in", Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
check("a session from before can't make a device link, cancel the recovery's, or turn early updates on",
  (await asSlipped("/_admin/devices/link")).status === 409 && (await asSlipped("/_admin/devices/cancel-links")).status === 409
  && (await asSlipped("/_admin/update/early-on")).status === 409 && sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 1);

await Promise.all([phone.waitForNavigation(), phone.click("#go")]);
check("making a passkey signs the new phone in, and it replaces the others", phone.url() === `${BASE}/`
  && sql("SELECT COUNT(*) AS n FROM credentials")[0].n === 1 && sql("SELECT COUNT(*) AS n FROM sessions")[0].n === 1);
const notice = await words(phone, "#recovered");
check("Home says how it got back in, that the other passkeys went, and where to add devices again", notice.includes("without a passkey")
  && notice.includes("passkey removed") && Boolean(await phone.$("#recovered a[href='/_admin']")), notice);
check("…and doesn't also call the new phone a new device", !(await phone.$("form[action='/_admin/devices/seen']")));
await phone.goto(`${BASE}/_auth/recover`);
check("signed in, the recovery page just goes Home", phone.url() === `${BASE}/`);

// The lost phone, if it turned up: its passkey is gone.
await lost.goto(`${BASE}/`);
await lost.click("#go");
await lost.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 10000 }).catch(() => {});
check("the lost phone's passkey no longer signs in", (await words(lost, "#error")).includes("isn't recognised"), await words(lost, "#error"));

await phone.goto(`${BASE}/`);
await phone.click("#recovered button"); // in place (ui.js data-inplace)
await phone.waitForFunction(() => !document.getElementById("recovered"), { timeout: 10000 }).catch(() => {});
check("Done puts the notice away", !(await phone.$("#recovered")) && sql("SELECT COUNT(*) AS n FROM settings WHERE key = 'recovered'")[0].n === 0);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
