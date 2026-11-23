// afterwrd.app's Connect page (installer/connect.html), the relay between a site and Cloudflare's Allow page, in a
// real browser: afterwrd.app, Cloudflare and the site are all stood in for, so nothing leaves this computer.
// Mostly the two lasting permissions asked for together (a new site's setup: auto.js, friendchecks.js).
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The page as afterwrd.app serves it: from the installer's Worker (central/site.js, run by run.sh on 8791), with the
// sign-in apps package.json names.
const { afterwrd: project } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const NEW_CLIENT = project.cloudflareClient;
const OLD_CLIENT = project.cloudflareClientsBefore[0];
const served = []; // what afterwrd.app answered: {path, status, policy}
const RELAY = "https://afterwrd.app/connect/";
const SITE = "https://ann.example-1.workers.dev";
const OTHER = "https://bob.example-2.workers.dev";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
let cloudflare = null; // where the relay sent the browser at Cloudflare
let backAt = null; // where it sent the browser back to
await page.setRequestInterception(true);
page.on("request", (req) => {
  const at = new URL(req.url());
  if (at.pathname === "/favicon.ico") return req.respond({ status: 404, body: "" });
  if (at.origin === "https://afterwrd.app") {
    fetch(`http://localhost:8791${at.pathname}${at.search}`, { headers: { "X-Test-Site": "1" }, redirect: "manual" }).then(async (r) => {
      served.push({ path: at.pathname, status: r.status, policy: r.headers.get("content-security-policy") });
      req.respond({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
    }, () => req.respond({ status: 502, body: "" }));
    return;
  }
  if (at.hostname === "dash.cloudflare.com") {
    cloudflare = at;
    return req.respond({ status: 200, contentType: "text/html", body: "<title>Cloudflare stand-in</title>" });
  }
  if (at.hostname.endsWith(".workers.dev")) {
    backAt = at;
    return req.respond({ status: 200, contentType: "text/html", body: "<title>site stand-in</title>" });
  }
  req.continue();
});
const out = (to, extra = {}) => `${RELAY}?${new URLSearchParams({ to, state: "s".repeat(20), challenge: "c".repeat(43), ...extra })}`;
const shown = (id) => page.$eval(id, (e) => !e.hidden).catch(() => false);
const words = (id) => page.$eval(id, (e) => e.textContent.replace(/\s+/g, " ")).catch(() => "");
const toCloudflare = () => page.waitForFunction(() => document.title === "Cloudflare stand-in", { timeout: 10000 }).then(() => true, () => false);
const backHome = () => page.goto(`${RELAY}?${new URLSearchParams({ code: "code-1", state: "s".repeat(20) })}`)
  .then(() => page.waitForFunction(() => document.title === "site stand-in", { timeout: 10000 }));

// --- both, during a new site's setup ---------------------------------------------------------------------------------
await page.goto(out(`${SITE}/_cloudflare/auto-done`, { both: "1", setup: "1" }));
check("asked for both, it shows both permissions, what each can do and for how long, before the first Allow", await shown("#ask-both")
  && !(await shown("#ask-auto")) && (await words("#ask-both")).includes("Automatic updates") && (await words("#ask-both")).includes("Friends' checks")
  && (await words("#ask-both")).includes("Until you turn it off") && (await words("#ask-both")).includes("Connected Applications"));
check("…with the site's address, to check it's yours", (await words("#both-host")) === new URL(SITE).host);
check("…shown at once (asking isn't passing through), with nothing more underneath",
  await page.evaluate(() => !document.body.classList.contains("passing")) && !(await page.$("#not-now"))
  && !(await words("main")).includes("passes you between"));
await Promise.all([toCloudflare(), page.click("#continue-both")]);
check("Continue asks Cloudflare for automatic updates only", cloudflare?.searchParams.get("scope") === "offline_access workers-scripts.edit");
await backHome();
check("Cloudflare's answer goes back to the site", backAt?.href.startsWith(`${SITE}/_cloudflare/auto-done#`));
cloudflare = null;
await page.goto(out(`${SITE}/_cloudflare/checks-done`, { setup: "1" }));
check("then friends' checks, for the same site, go straight on to Cloudflare, not asked twice", await toCloudflare()
  && cloudflare?.searchParams.get("scope") === "offline_access workers-scripts.content_read");
await backHome();
cloudflare = null;
await page.goto(out(`${SITE}/_cloudflare/checks-done`));
check("…but only once: asked again, it asks first", await shown("#ask-checks") && cloudflare === null);
// Passing through (on the way back from Cloudflare, say), the page shows nothing but its background at first, so a
// page gone in a blink doesn't flash. (Without its script, it's never told it's asking, so it stays passing.)
await page.setJavaScriptEnabled(false);
await page.goto(RELAY);
check("passing through, at first only the background shows", await page.$eval("main", (m) => getComputedStyle(m).visibility) === "hidden");
await page.setJavaScriptEnabled(true);

// --- both, then a different site: asked as usual --------------------------------------------------------------------
await page.goto(out(`${SITE}/_cloudflare/auto-done`, { both: "1" }));
check("asked for both outside setup, it's the same page", await shown("#ask-both"));
await Promise.all([toCloudflare(), page.click("#continue-both")]);
await backHome();
cloudflare = null;
await page.goto(out(`${OTHER}/_cloudflare/checks-done`));
check("friends' checks for another site's address are asked for as usual", await shown("#ask-checks")
  && (await words("#checks-host")) === new URL(OTHER).host && cloudflare === null);

// --- one at a time, as before ----------------------------------------------------------------------------------------
await page.goto(out(`${SITE}/_cloudflare/auto-done`));
check("automatic updates on their own are asked for as before", await shown("#ask-auto") && !(await shown("#ask-both")));
await page.goto(out(`${SITE}/_cloudflare/checks-done`, { both: "1" }));
check("\"both\" means nothing on the way to friends' checks", await shown("#ask-checks") && !(await shown("#ask-both")));
await page.goto(out("https://evil.example/_cloudflare/auto-done", { both: "1", setup: "1" }));
check("an address that isn't an afterwrd site's is refused", !(await shown("#ask-both")) && (await words("#error")).length > 0);

// --- which sign-in app it asks through -------------------------------------------------------------------------------
const askedThrough = async (extra) => {
  cloudflare = null;
  await page.goto(out(`${SITE}/_cloudflare/done`, extra));
  await Promise.all([toCloudflare(), page.click("#continue")]);
  return cloudflare?.searchParams.get("client_id");
};
check("a site that says which sign-in app it uses is asked through that one", (await askedThrough({ client: NEW_CLIENT })) === NEW_CLIENT);
check("…as is one that names an earlier app", (await askedThrough({ client: OLD_CLIENT })) === OLD_CLIENT);
check("a site from before 0.51.0, which doesn't say, is asked through the first app, as it was", (await askedThrough({})) === OLD_CLIENT);
check("an app the page doesn't know is never asked through", (await askedThrough({ client: "evil-client" })) === OLD_CLIENT);

// --- getting back in without a passkey (recover.js) -------------------------------------------------------------------
cloudflare = null;
await page.goto(out(`${SITE}/_auth/recover/done`));
check("getting back in asks first, with the site's address, and that no one else ever needs it", await shown("#ask-recover")
  && (await words("#recover-host")) === new URL(SITE).host && (await words("#ask-recover")).includes("nobody else, friends included, ever needs it"));
await Promise.all([toCloudflare(), page.click("#continue-recover")]);
check("…and asks Cloudflare for an hour's access to change Workers (nothing lasting), never the read-only access a check gets",
  cloudflare?.searchParams.get("scope") === "workers-scripts.edit");
await backHome();
check("…and Cloudflare's answer goes back to the site's recovery page", backAt?.href.startsWith(`${SITE}/_auth/recover/done#`));
await page.goto(out(`${SITE}/_auth/recover/finish`));
check("another path under it is refused", !(await shown("#ask-recover")) && (await words("#error")).length > 0);

check("afterwrd.app's Connect page comes from the installer's Worker, its script allowed only by the answer's nonce",
  served.length > 0 && served.every((p) => p.path !== "/connect/" || (p.status === 200 && /script-src 'nonce-[\w-]{24}'/.test(p.policy ?? ""))),
  JSON.stringify(served.slice(0, 2)));
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
