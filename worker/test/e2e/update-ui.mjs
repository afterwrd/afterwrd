// The Update page's three states, against a fresh local site with SETUP_CODE=local-test-setup-code:
//   node update-ui.mjs behind     (package.json version older than the latest release; the site started with
//                                  ALLOW_LOCAL_SITES=1 and OAUTH_TOKEN_URL=http://127.0.0.1:8799/token, a stand-in for
//                                  Cloudflare's token endpoint that this test runs)
//   node update-ui.mjs remembered (older, and UPDATE_TOKEN set: a token a version before 0.20.0 kept)
//   node update-ui.mjs current    (up to date)
// Local sites aren't on workers.dev, so the actual update stops at "Updating works from the site's workers.dev address".
// Connecting Cloudflare is run end to end with Cloudflare's Allow page stood in for (helpers.mjs): the test answers for
// it, reads what the site asked for from the address it sent the browser to, and comes back the way afterwrd.app's
// relay page would.
import { allowAsks, backThroughRelay, continueToCloudflare, isAllowPage, setUpSigning } from "./helpers.mjs";
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const mode = process.argv[2];
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  [${mode}] ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

// The signed list of releases (src/signing.js) for the "behind" site (run.sh gives it the test key): GitHub's real
// latest release, signed with the test key, so the Update page offers it as a signed release.
const TEST_KEY = createPrivateKey({ key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIAwWlXoAziEK+W2opIfh92LiKpJBYhziPl8FbhGjYWvi", "base64"), format: "der", type: "pkcs8" });
let signedIndex = null;
if (mode === "behind") {
  const bytes = Buffer.from(await (await fetch("https://github.com/afterwrd/afterwrd/releases/latest/download/manifest.json")).arrayBuffer());
  const releases = [{ version: JSON.parse(bytes.toString()).version, manifest_sha256: createHash("sha256").update(bytes).digest("hex"), signed_at: "2026-01-01T00:00:00Z" }];
  const list = { seq: 50, releases };
  const text = `afterwrd releases\n${list.seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at}\n`).join("")}`;
  const text2 = `afterwrd releases 2\n${list.seq}\n${releases.map((r) => `${r.version} ${r.manifest_sha256} ${r.signed_at} -\n`).join("")}`;
  signedIndex = JSON.stringify({ ...list, signature: sign(null, Buffer.from(text), TEST_KEY).toString("base64"), signature2: sign(null, Buffer.from(text2), TEST_KEY).toString("base64") });
}

// A stand-in for Cloudflare's token endpoint: records what the site sends, answers with an hour's token.
const exchanges = [];
const tokenServer = createServer(async (req, res) => {
  if (req.url === "/signatures/index.json" && signedIndex) { res.setHeader("Content-Type", "application/json"); res.end(signedIndex); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  exchanges.push({ url: req.url, params: Object.fromEntries(new URLSearchParams(body)) });
  res.setHeader("Content-Type", "application/json");
  if (exchanges.at(-1).params.code === "bad-code") { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
  res.end(JSON.stringify({ access_token: "stand-in-access-token", token_type: "bearer", expires_in: 3600 }));
});
await new Promise((r) => tokenServer.listen(8799, "127.0.0.1", r));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
const page = await browser.newPage();
// These check the site's own answers (a 400, the "being updated" page), which the test browser can't always see when
// the service worker (public/static/app/push-sw.js) passes a page on; it's tested in comments.mjs.
await page.setBypassServiceWorker(true);
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
// afterwrd asks in its own box (ui.js): say yes, as a person would.
await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
  .observe(document, { childList: true, subtree: true }));
const cdp = await page.createCDPSession();
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
await page.type("#name", "Owner");
await Promise.all([page.waitForNavigation(), page.click("#go")]);
await Promise.all([page.waitForNavigation(), page.click("#go")]);
await setUpSigning(page);

// The mark on the Update button (the first page load fetches the latest version in the background).
await page.goto(`${BASE}/posts`);
await new Promise((r) => setTimeout(r, 2500));
await page.goto(`${BASE}/posts`);
const update = await page.$eval('header.site a[href="/_admin/update"]', (a) => ({ label: a.querySelector("span").textContent, dot: Boolean(a.querySelector(".dot")) }));
const behind = mode !== "current";
check(behind ? "Update button marked when a release is waiting" : "no mark when up to date",
  update.dot === behind && update.label === (behind ? "Update available" : "Update"), JSON.stringify(update));

// Cloudflare's Allow page, stood in for: the address the site sent the browser to is kept. (Nothing goes to afterwrd.app
// on the way out now; if anything did, it's noted.)
let allow = null;
await page.setRequestInterception(true);
page.on("request", (req) => {
  const at = new URL(req.url());
  if (at.hostname !== "dash.cloudflare.com" && at.hostname !== "afterwrd.app") return req.continue();
  if (isAllowPage(at)) allow = at;
  else if (at.pathname !== "/favicon.ico") errors.push(`went to ${at.href}`);
  req.respond({ status: 200, contentType: "text/html", body: "<title>Cloudflare stand-in</title>" });
});
const post = (path, body) => page.evaluate((path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body) }).then((r) => r.json()), path, body);

await page.goto(`${BASE}/_admin/update`);
const text = await page.$eval("main", (m) => m.innerText);
if (mode === "behind") {
  check("offers the update with Connect Cloudflare, and no Remember", /is available/.test(text) && Boolean(await page.$("#connect")) && !(await page.$("#remember")));
  check("Connect is the only way: no box to paste a token into", !(await page.$("#token")));
  check("no Forget (nothing remembered)", !(await page.$("#forget")));
  check("Update without connecting says so", await page.evaluate(() => { document.getElementById("go").click(); return document.getElementById("error").textContent; }) === "Connect Cloudflare first.");

  // Connect: the site's own page, saying what's asked for, then off to Cloudflare with the state and challenge, and a
  // cookie holding the PKCE secret.
  let before = "";
  await continueToCloudflare(page, async () => {
    await page.click("#connect");
    await page.waitForFunction(() => document.title === "Connecting to Cloudflare · afterwrd", { timeout: 15_000 });
    before = await page.$eval("main", (m) => m.innerText);
  });
  check("Connect shows the site's own page first, saying what Cloudflare will ask and the site's address", /Connect your site to Cloudflare\?/.test(before)
    && /one hour/.test(before) && before.includes("localhost:8787"), before.replace(/\s+/g, " "));
  const askedFor = allowAsks(allow, { scope: "workers-scripts.admin d1.write account-settings.read", to: `${BASE}/_cloudflare/done` });
  check("Continue sends the browser straight to Cloudflare, asking for an hour's access to install and update, coming back here through the relay",
    askedFor === "", askedFor);
  check("with a state and a PKCE challenge", /^[\w-]{32}~[\w-]+$/.test(allow?.searchParams.get("state") ?? ""), allow?.href);
  check("a back path on another site is refused", (await page.goto(`${BASE}/_cloudflare/start?back=//evil.example/`)).status() === 400);
  const session = (await page.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  const crossSite = await fetch(`${BASE}/_cloudflare/start?back=/_admin/update?go=update`, { redirect: "manual",
    headers: { Cookie: session, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
  check("a link on another site can't start a connection", crossSite.status === 403, String(crossSite.status));
  await page.goto(`${BASE}/_cloudflare/done#error=access_denied`);
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
  check("not allowing it is explained, and nothing is exchanged", /didn't allow it/.test(await page.$eval("#error", (e) => e.textContent)) && exchanges.length === 0);

  // Back from Cloudflare the way the relay would send us, with the wrong state first. (A fresh page load: a change
  // of fragment alone wouldn't be one.)
  await page.goto(`${BASE}/_admin/update`);
  await page.goto(`${BASE}/_cloudflare/done#code=the-code&state=not-the-state`);
  await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
  check("a code with the wrong state is refused, and nothing is exchanged", /isn't the connection/.test(await page.$eval("#error", (e) => e.textContent)) && exchanges.length === 0);
  // Refusing clears the started connection, so a fresh one is needed.
  await page.goto(`${BASE}/_admin/update`);
  await continueToCloudflare(page, () => page.click("#connect"));
  const challenge2 = allow.searchParams.get("code_challenge");
  await page.goto(backThroughRelay(allow, "the-code"));
  await page.waitForFunction(() => location.pathname === "/_admin/update", { timeout: 15_000 });
  const sent = exchanges.at(-1);
  check("the code goes to the token endpoint with the PKCE secret, the client id and the relay as redirect", exchanges.length === 1 && sent.params.grant_type === "authorization_code"
    && sent.params.code === "the-code" && sent.params.redirect_uri === "https://afterwrd.app/connect/" && /^[0-9a-f]{32}$/.test(sent.params.client_id)
    && /^[\w-]{43,128}$/.test(sent.params.code_verifier), JSON.stringify(sent));
  const verifierHash = await page.evaluate(async (v) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }, sent.params.code_verifier);
  check("the secret matches the challenge sent out", verifierHash === challenge2);
  const cookies = await page.cookies(BASE);
  const tokenCookie = cookies.find((c) => c.name === "cf_token");
  check("the hour's token is kept in an HttpOnly cookie, and the start cookie is gone", tokenCookie?.httpOnly === true && tokenCookie.value === "stand-in-access-token"
    && tokenCookie.expires - Date.now() / 1000 < 3600 && !cookies.some((c) => c.name === "cf_connect"), JSON.stringify(cookies.map((c) => c.name)));
  await page.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 30_000 }).catch(async () => {
    console.log("DIAG url", page.url(), "\nDIAG text", await page.$eval("body", (b) => b.innerText.slice(0, 1500)), "\nDIAG cookies", JSON.stringify((await page.cookies(BASE)).map((c) => c.name)));
    await page.screenshot({ path: `${OUT}/update-diag.png`, fullPage: true });
  });
  check("back on the Update page, connected, and the update runs by itself (stops off workers.dev)",
    /Connected to Cloudflare/.test(await page.$eval("main", (m) => m.innerText)) && /workers\.dev/.test(await page.$eval("#error", (e) => e.textContent)));
  check("the token endpoint being refused is reported", /didn't finish connecting/.test((await (async () => {
    await page.goto(`${BASE}/_admin/update`);
    await post("/_cloudflare/disconnect", {});
    await page.goto(`${BASE}/_admin/update`);
    await continueToCloudflare(page, () => page.click("#connect"));
    await page.goto(backThroughRelay(allow, "bad-code"));
    await page.waitForFunction(() => document.getElementById("error").textContent, { timeout: 10_000 });
    return page.$eval("#error", (e) => e.textContent);
  })())));
  check("Disconnect dropped the token", !(await page.cookies(BASE)).some((c) => c.name === "cf_token"));

} else if (mode === "remembered") {
  check("an old remembered token is pointed out, with Forget", /earlier version kept/.test(text) && Boolean(await page.$("#forget")));
  check("updating still goes through Connect", Boolean(await page.$("#connect")));
  check("Update without connecting says so, old token or not", await page.evaluate(() => { document.getElementById("go").click(); return document.getElementById("error").textContent; }) === "Connect Cloudflare first.");
  const forgot = await post("/_admin/update/forget", {});
  check("Forget runs (and stops off workers.dev)", /workers\.dev/.test(forgot.error ?? ""), forgot.error);
} else {
  check("says it's up to date, with nothing to remember", /latest version/.test(text) && !(await page.$("#save")) && !(await page.$("#forget")));
  const downgrade = await post("/_admin/update/check", { tag: "v0.1.0", token: "x" });
  check("won't update to an older version", /isn't newer/.test(downgrade.error ?? ""), downgrade.error);
  const unstarted = await post("/_cloudflare/finish", { code: "the-code", state: "x" });
  check("a code arriving without a connection started here is refused", /expired\. Start again/.test(unstarted.error ?? ""), unstarted.error);
  const settings = await page.evaluate(() => fetch("/_admin/export/rows?table=settings").then((r) => r.json()));
  check("Download everything only takes the published sections from settings", settings.rows.every((r) => ["sections", "friends_see"].includes(r.key)),
    settings.rows.map((r) => r.key).join());
}
await page.screenshot({ path: `${OUT}/update-${mode}.png`, fullPage: true });
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
tokenServer.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
