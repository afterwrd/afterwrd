// Checks for the security review's fixes. Run against a fresh local database with SETUP_CODE=local-test-setup-code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { sql, setUpSigning } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const CODE = "local-test-setup-code";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const post = (path, body, cookie, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: `__Host-session=${cookie}` } : {}) },
  body: JSON.stringify(body ?? {}) });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
async function person() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("dialog", (d) => d.accept());
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  return page;
}
const session = async (page) => (await page.cookies()).find((c) => c.name === "__Host-session");

// --- setup link ------------------------------------------------------------------
check("setup with a wrong code is refused", (await fetch(`${BASE}/_auth/setup?code=wrong`)).status === 403);
check("setup page shows with the right code", (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).status === 200);
const first = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
const again = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
check("an unfinished setup can be resumed (no passkey yet)", Boolean(first.link && again.link && first.link !== again.link)
  && sql("SELECT COUNT(*) AS n FROM users")[0].n === 1);
check("…and only the newest setup link works", (await fetch(first.link)).status === 404
  && sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 1);
const spareSetup = await (await post("/_auth/setup", { code: CODE, name: "Owner One" })).json();
const setupPage = await (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).text();
check("the setup page takes the code off the address bar", setupPage.includes('history.replaceState(null, "", "/_auth/setup")'));
const ownerInvite = sql("SELECT MAX(expires_at) - strftime('%s','now') AS left FROM device_links")[0].left;
check("the owner's setup link lasts an hour", ownerInvite > 3500 && ownerInvite <= 3600, `${ownerInvite}s`);
// A stray unused link (as an older release could leave) is cancelled by the first passkey.
sql(`INSERT INTO device_links (token_hash, user_id, expires_at) VALUES ('${"a".repeat(64)}', (SELECT id FROM users), strftime('%s','now') + 3600)`);
const owner = await person();
await owner.goto(spareSetup.link);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
check("a site's first passkey goes on to its recovery code (afterwrd 2)", new URL(owner.url()).pathname === "/_admin/keys");
await setUpSigning(owner);
check("owner registers from the resumed link", ["/", "/posts"].includes(new URL(owner.url()).pathname) || (await owner.content()).includes("Nothing has been published"));
check("setup is closed once a passkey exists", (await fetch(`${BASE}/_auth/setup?code=${CODE}`)).status === 409);
check("the first passkey cancels any other setup link", sql("SELECT COUNT(*) AS n FROM device_links WHERE used_at IS NULL")[0].n === 0);

// --- cookies and headers ---------------------------------------------------------------
const cookie = await session(owner);
check("session cookie is __Host-, HttpOnly, Secure", Boolean(cookie && cookie.httpOnly && cookie.secure && cookie.path === "/"));
const csp = (await fetch(`${BASE}/_auth/login`)).headers.get("content-security-policy") ?? "";
check("CSP blocks plugins, <base> and foreign form posts", ["object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].every((d) => csp.includes(d)), csp);
check("CSP lets pages call only this site", csp.includes("connect-src 'self'"), csp);
// Scripts: only from the site's files, or the page's own, carrying the nonce made for that answer (nonce.js).
const nonceOf = (policy) => /^script-src 'self' 'nonce-([\w-]{24})';/.exec(policy ?? "")?.[1];
const inlineScripts = (body) => [...body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]).filter((a) => !/\bsrc=|application\/json/.test(a));
const handlers = (body) => body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").match(/<[a-z][^>]*\son[a-z]+\s*=/gi) ?? [];
for (const [where, path, headers] of [["the sign-in page", "/_auth/login", {}], ["Home", "/", { Cookie: `__Host-session=${cookie.value}` }],
  ["Friends", "/friend", { Cookie: `__Host-session=${cookie.value}` }], ["Your devices", "/_admin", { Cookie: `__Host-session=${cookie.value}` }]]) {
  const res = await fetch(BASE + path, { headers });
  const policy = res.headers.get("content-security-policy");
  const nonce = nonceOf(policy), body = await res.text(), scripts = inlineScripts(body);
  check(`${where}: scripts run only from the site's files or with the answer's nonce`, res.status === 200 && Boolean(nonce)
    && !policy.includes("unsafe"), `${res.status} ${policy}`);
  check(`…every inline script on ${where} carries it`, scripts.length > 0 && scripts.every((a) => a.includes(` nonce="${nonce}"`)),
    scripts.filter((a) => !a.includes(` nonce="${nonce}"`)).join(" | "));
  check(`…and ${where} has no inline handlers (onclick and the like)`, handlers(body).length === 0, handlers(body).join(" | "));
}
// The site's own scripts carry their SHA-256 (integrity), so a browser runs only the release's own, whatever serves them.
{
  const page = await (await fetch(`${BASE}/`, { headers: { Cookie: `__Host-session=${cookie.value}` } })).text();
  const tagged = [...page.matchAll(/<script[^>]* src="([^"]+)" integrity="(sha256-[^"]+)"/g)];
  const map = JSON.parse(/<script type="importmap"[^>]*>([^<]+)<\/script>/.exec(page)?.[1] ?? "{}");
  let right = tagged.length >= 2;
  for (const [, src, value] of tagged) {
    const bytes = Buffer.from(await (await fetch(BASE + src, { headers: { Cookie: `__Host-session=${cookie.value}` } })).arrayBuffer());
    right &&= value === `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
  }
  const mapped = Object.entries(map.integrity ?? {});
  check("Home's scripts carry their SHA-256, and it's right", right, tagged.map((t) => t[1]).join(" "));
  check("…and so do the modules they import (the import map)", mapped.length > 10 && mapped.every(([url, v]) => url.startsWith("/static/") && /^sha256-/.test(v))
    && Object.values(map.imports ?? {}).every((url) => Object.hasOwn(map.integrity, url)));
  const login = await (await fetch(`${BASE}/_auth/login`)).text();
  check("…the sign-in page too, which makes this browser's key", /<script type="importmap"[^>]*>[^<]*"integrity"/.test(login));
}
check("each answer has its own nonce", nonceOf((await fetch(`${BASE}/_auth/login`)).headers.get("content-security-policy"))
  !== nonceOf((await fetch(`${BASE}/_auth/login`)).headers.get("content-security-policy")));
await owner.goto(`${BASE}/`);
const ran = await owner.evaluate(async () => {
  const script = document.createElement("script");
  script.textContent = "window.injected = 1";
  document.body.append(script);
  document.body.insertAdjacentHTML("beforeend", '<img src="/static/not-there.png" onerror="window.handler = 1" alt="">');
  await new Promise((resolve) => setTimeout(resolve, 500));
  // @ts-ignore
  return { injected: window.injected, handler: window.handler, look: document.documentElement.dataset.look };
});
check("in the browser, a script put in a page without its nonce doesn't run, nor an inline handler", !ran.injected && !ran.handler, JSON.stringify(ran));
check("…while the page's own scripts do (its look is set)", ["dark", "light"].includes(ran.look), JSON.stringify(ran));
const version = await fetch(`${BASE}/_version`);
const said = await version.json().catch(() => null);
check("the site says which uploaded version it is, without signing in", version.status === 200 && said && "id" in said, JSON.stringify(said));
const font = await fetch(`${BASE}/static/fonts/nunito.woff2`);
const fontTag = font.headers.get("etag");
check("static files are sent with their release hash as ETag", font.status === 200 && /^"[0-9a-f]{64}"$/.test(fontTag ?? ""), `${font.status} ${fontTag}`);
check("…and a copy the browser already has is confirmed with 304", (await fetch(`${BASE}/static/fonts/nunito.woff2`, { headers: { "If-None-Match": fontTag } })).status === 304);
const css = await fetch(`${BASE}/static/style.css`, { headers: { Cookie: `__Host-session=${cookie.value}` } });
check("the stylesheet is served to the owner", css.status === 200 && (await css.text()).includes("--accent-strong"));
const loginOptions = await (await fetch(`${BASE}/_auth/login/options`, { method: "POST", headers: { Origin: BASE } })).json();
check("signing in asks the device to check it's you", loginOptions.userVerification === "required", loginOptions.userVerification);

// --- open redirect ------------------------------------------------------------------
for (const [next, expected] of [["/%5Cevil.example", "/"], ["/%09/evil.example", "/"], ["https://evil.example/", "/"], ["/posts?page=2", "/posts?page=2"]]) {
  const body = await (await fetch(`${BASE}/_auth/login?next=${next}`)).text();
  const got = JSON.parse(/const next = ("[^"]*")/.exec(body)[1]);
  check(`sign-in redirect ${decodeURIComponent(next)} goes to ${expected}`, got === expected, got);
}

// --- anonymous sign-in requests don't write --------------------------------------------
// (latest_release is the owner's update check, saved in the background after their page loads.)
const count = () => sql(`SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM used_challenges)
  + (SELECT COUNT(*) FROM settings WHERE key != 'latest_release') AS n`)[0].n;
const before = count();
for (let i = 0; i < 15; i++) await post("/_auth/login/options");
check("15 anonymous sign-in requests write nothing", count() === before);

// --- a sign-in can't be replayed ---------------------------------------------------------
await owner.goto(`${BASE}/_auth/logout`);
await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_auth/logout'] button")]);
check("signed out after the sign-out form", !(await session(owner)));
let captured = null;
await owner.setRequestInterception(true);
const capture = (r) => {
  if (r.url().endsWith("/_auth/login/verify")) captured = { body: r.postData(), cookie: r.headers().cookie };
  r.continue();
};
owner.on("request", capture);
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
owner.off("request", capture);
await owner.setRequestInterception(false);
check("owner signs back in", Boolean(await session(owner)));
const replay = await fetch(`${BASE}/_auth/login/verify`, { method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json", Cookie: captured.cookie }, body: captured.body });
check("replaying that exact sign-in is refused", replay.status === 400 && !(replay.headers.get("set-cookie") ?? "").includes("__Host-session=") , `HTTP ${replay.status}`);
check("the sign-in carried this browser's own signature of its delegation (it holds the key)", /"possession":"[\w-]{86}"/.test(captured.body ?? ""));
// A sign-in whose browser doesn't show it holds the key the passkey would let sign is refused, whatever the passkey says.
{
  await owner.goto(`${BASE}/_auth/logout`);
  await Promise.all([owner.waitForNavigation(), owner.click("form[action='/_auth/logout'] button")]);
  await owner.setRequestInterception(true);
  const strip = (r) => {
    if (!r.url().endsWith("/_auth/login/verify")) return r.continue();
    const body = JSON.parse(r.postData());
    delete body.possession;
    r.continue({ postData: JSON.stringify(body) });
  };
  owner.on("request", strip);
  await owner.goto(`${BASE}/_auth/login`);
  await owner.click("#go");
  await owner.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 15000 }).catch(() => {});
  owner.off("request", strip);
  await owner.setRequestInterception(false);
  check("…and without it, the sign-in is refused and nothing signs", !(await session(owner))
    && sql("SELECT COUNT(*) AS n FROM delegations WHERE created_at > strftime('%s','now') - 20")[0].n === 0);
  await owner.goto(`${BASE}/_auth/login`);
  await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
}
const logout = await post("/_auth/logout", null, (await session(owner)).value);
check("signing out asks the browser to clear cached photos, and anything kept for the site", (logout.headers.get("clear-site-data") ?? "").includes('"cache"')
  && (logout.headers.get("clear-site-data") ?? "").includes('"storage"'));
// A service worker the site didn't make (security review 2026-11 M13): its update check gets one that removes itself.
const planted = await fetch(`${BASE}/static/planted-sw.js`, { headers: { "Service-Worker": "script" } });
const own = await fetch(`${BASE}/static/app/push-sw.js`, { headers: { "Service-Worker": "script" } });
check("a service worker the site didn't make is answered with one that removes itself; its own is served as it is",
  planted.status === 200 && (await planted.text()).includes("registration.unregister()") && (await own.text()).includes("navigationPreload"));
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
let ownerCookie = (await session(owner)).value;

// --- Your devices: links, sign-out everywhere, passkeys ------------------------------------
const ownerId = sql("SELECT id FROM users")[0].id;
const deviceLink = (await (await post("/_admin/devices/link", {}, ownerCookie)).json()).link;
const left = sql(`SELECT MAX(expires_at) - strftime('%s','now') AS left FROM device_links WHERE user_id = ${ownerId} AND used_at IS NULL`)[0].left;
check("a device link lasts an hour", left > 3500 && left <= 3600, `${left}s`);
const laptop = await person();
await laptop.goto(deviceLink);
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
check("a second device signs in as the owner", Boolean(await session(laptop)));
const [ownerKey, laptopKey] = sql(`SELECT id FROM credentials WHERE user_id = ${ownerId} ORDER BY created_at, rowid`).map((k) => k.id);
const spare = (await (await post("/_admin/devices/link", {}, ownerCookie)).json()).link;
await post("/_admin/devices/cancel-links", {}, ownerCookie);
check("Cancel unused links removes them", sql(`SELECT COUNT(*) AS n FROM device_links WHERE user_id = ${ownerId} AND used_at IS NULL`)[0].n === 0
  && (await fetch(spare)).status === 404);
await post("/_admin/devices/sign-out", {}, ownerCookie);
await laptop.goto(`${BASE}/posts`);
check("Sign out everywhere ends every session", new URL(laptop.url()).pathname === "/_auth/login"
  && (await fetch(`${BASE}/_admin`, { redirect: "manual", headers: { Cookie: `__Host-session=${ownerCookie}` } })).status === 302);
await owner.goto(`${BASE}/_auth/login`);
await Promise.all([owner.waitForNavigation(), owner.click("#go")]);
ownerCookie = (await session(owner)).value;
await post("/_admin/devices/delete-passkey", { credential: laptopKey }, ownerCookie);
await laptop.click("#go");
await laptop.waitForFunction(() => document.getElementById("error").textContent.length > 0);
check("a removed passkey can't sign in", (await laptop.$eval("#error", (e) => e.textContent)).includes("isn't recognised"));
check("the last passkey can't be removed", (await post("/_admin/devices/delete-passkey", { credential: ownerKey }, ownerCookie)).status === 400);
check("there's no inviting anyone else", (await post("/_admin/invite", { name: "Viewer" }, ownerCookie)).status === 404);

// --- a form sent in place gets its page back (index.js redrawn): only a page here, and never past the checks ---------
const sendInPlace = (redraw, origin = BASE) => fetch(`${BASE}/_admin/notifications/seen`, { method: "POST", redirect: "manual",
  headers: { Origin: origin, "Afterwrd-Redraw": redraw, Cookie: `__Host-session=${ownerCookie}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "back=/" });
const redrawnPage = await sendInPlace("/posts");
check("a form sent in place comes back with the page it's redrawn from",
  redrawnPage.status === 200 && redrawnPage.headers.get("afterwrd-redrawn") === "1" && /<html/i.test(await redrawnPage.text()));
for (const redraw of ["https://elsewhere.example/", "//elsewhere.example/posts", "/_admin/connections", "/_auth/login", "posts"]) {
  const res = await sendInPlace(redraw);
  check(`…but not from ${redraw}`, res.status === 303 && !res.headers.get("afterwrd-redrawn"), `HTTP ${res.status}`);
}
const fromElsewhere = await sendInPlace("/posts", "https://elsewhere.example");
check("…and never for a form sent from another site", fromElsewhere.status === 403 && !fromElsewhere.headers.get("afterwrd-redrawn"));

// --- every signed-in action refuses another site, from one check in index.js: so a new one can't forget -------------
for (const path of ["/_admin/items", "/_admin/events/read", "/_push/on", "/_groups/1/comments", "/_admin/devices/seen", "/_admin/update/auto-later",
  "/_cloudflare/finish", "/_cloudflare/auto-finish", "/_cloudflare/checks-finish", "/_a-handler-not-written-yet"]) {
  const res = await fetch(BASE + path, { method: "POST", redirect: "manual", body: "text=hi",
    headers: { Origin: "https://elsewhere.example", Cookie: `__Host-session=${ownerCookie}`, "Content-Type": "application/x-www-form-urlencoded" } });
  check(`another site can't send ${path}`, res.status === 403, `HTTP ${res.status}`);
}
const noOrigin = await fetch(`${BASE}/_admin/devices/seen`, { method: "POST", redirect: "manual", headers: { Cookie: `__Host-session=${ownerCookie}` } });
check("…nor anything that doesn't say where it's from", noOrigin.status === 403, `HTTP ${noOrigin.status}`);

// --- import validation ------------------------------------------------------------------
await post("/_admin/import/start", {}, ownerCookie);
const media = (over) => ({ table: "media", rows: [{ id: 1, path: "a.jpg", kind: "photo", ...over }] });
check("import refuses markup in a number column", (await post("/_admin/import/rows", media({ width: '1" onerror="alert(1)' }), ownerCookie)).status === 400);
check("import refuses a fake file address", (await post("/_admin/import/rows", media({ hash: "../../etc" }), ownerCookie)).status === 400);
check("import refuses a page as a media type", (await post("/_admin/import/rows", media({ type: "text/html" }), ownerCookie)).status === 400);
check("import accepts a proper row", (await post("/_admin/import/rows", media({ width: 800, height: 600, hash: "a".repeat(64), type: "image/jpeg" }), ownerCookie)).ok);
check("import refuses ids that could reach another row's", (await post("/_admin/import/rows", media({ id: -5 }), ownerCookie)).status === 400
  && (await post("/_admin/import/rows", media({ post_id: 0 }), ownerCookie)).status === 400);
const facebookPost = (key) => ({ table: "posts", rows: [{ id: 1, key, created_at: 1700000000, kind: "status" }] });
check("import refuses a post without a proper address", (await post("/_admin/import/rows", facebookPost("../../x"), ownerCookie)).status === 400
  && (await post("/_admin/import/rows", facebookPost(null), ownerCookie)).status === 400);

// --- media store: re-uploading can't damage a stored file -----------------------------------------
const bytes = Buffer.from("not really a jpeg, but bytes are bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const put = (body) => fetch(`${BASE}/_admin/import/files/${hash}`, { method: "PUT", body,
  headers: { Origin: BASE, "Content-Type": "image/jpeg", Cookie: `__Host-session=${ownerCookie}` } });
await put(bytes);
const second = await (await put(Buffer.from("different bytes that would fail the hash check"))).json();
const served = Buffer.from(await (await fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).arrayBuffer());
check("re-uploading a stored file leaves it intact", second.existing === true && served.equals(bytes));

// --- lookups by name can't reach object internals --------------------------------------------
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '["overview","timeline","posts","photos","comments","likes","friends"]');
     INSERT OR REPLACE INTO facebook_people (id, name, is_me) VALUES (1, 'Me', 1)`);
for (const path of ["/friends?sort=constructor", "/friends?sort=__proto__", "/people/1?tab=__proto__", "/people/1?tab=constructor"]) {
  const res = await fetch(BASE + path, { headers: { Cookie: `__Host-session=${ownerCookie}` } });
  check(`${path} is handled, not a crash`, res.status === 200, `HTTP ${res.status}`);
}

// --- where sign-in sends you ---------------------------------------------------------------------
for (const trick of ["/.//evil.example", "/..//evil.example", "/%2e//evil.example", "/./%5Cevil.example", "https://evil.example/"]) {
  const loginPage = await (await fetch(`${BASE}/_auth/login?next=${encodeURIComponent(trick)}`)).text();
  const next = JSON.parse(/const next = ("[^"]*")/.exec(loginPage)[1]);
  check(`sign-in won't send you off the site (${trick})`, new URL(next, BASE).origin === BASE && !next.startsWith("//"), next);
}

// --- a friend's or group's site still on afterwrd 1 -------------------------------------------
// Told this site has moved (410), never sent to sign in (302) or told it's not connected (401: "they removed you").
const oldKey = { Authorization: `Bearer ${"k".repeat(43)}` };
const oldFeed = await fetch(`${BASE}/_peer/feed`, { headers: oldKey, redirect: "manual" });
check("an afterwrd 1 friend's read is told this site has moved", oldFeed.status === 410
  && (await oldFeed.json()).error?.includes("moved to afterwrd 2"));
const oldComment = await fetch(`${BASE}/_peer/comments`, { method: "POST", headers: { ...oldKey, "Content-Type": "application/json" }, body: "{}" });
check("…and so is a comment it sends", oldComment.status === 410);
const oldGroup = await fetch(`${BASE}/_member/notify`, { method: "POST", headers: { ...oldKey, "Content-Type": "application/json" }, body: "{}" });
check("an afterwrd 1 group's note is told too", oldGroup.status === 410);
check("a call to /_member/ without a key is answered as before", (await fetch(`${BASE}/_member/notify`, { method: "POST", body: "{}" })).status === 401);

// --- update page ------------------------------------------------------------------------------
const updatePage = await (await fetch(`${BASE}/_admin/update`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).text();
check("owner's Update page shows this version", updatePage.includes(`Your site is on afterwrd ${JSON.parse(execFileSync("cat", [`${WORKER}/package.json`], { encoding: "utf8" })).version}`));
const update404 = await fetch(`${BASE}/_admin/update/version`, { redirect: "manual" });
check("Update isn't reachable signed out", update404.status === 302);
check("Update refuses a made-up release name", (await post("/_admin/update/check", { token: "x", tag: "v1;rm" }, ownerCookie)).status === 400);

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
