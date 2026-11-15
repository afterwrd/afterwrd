// afterwrd.app's Connect page (installer/connect.html), the relay between a site and Cloudflare's Allow page, in a
// real browser: afterwrd.app, Cloudflare and the site are all stood in for, so nothing leaves this computer.
// Mostly the two lasting permissions asked for together (a new site's setup: auto.js, friendchecks.js).
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = readFileSync(new URL("../../installer/connect.html", import.meta.url), "utf8").replaceAll("__OAUTH_CLIENT__", "test-client");
const RELAY = "https://afterwrd.app/connect/";
const SITE = "https://ann.example-1.workers.dev";
const OTHER = "https://bob.example-2.workers.dev";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
let cloudflare = null; // where the relay sent the browser at Cloudflare
let backAt = null; // where it sent the browser back to
await page.setRequestInterception(true);
page.on("request", (req) => {
  const at = new URL(req.url());
  if (at.pathname === "/favicon.ico") return req.respond({ status: 404, body: "" });
  if (at.origin === "https://afterwrd.app") return req.respond({ status: 200, contentType: "text/html", body: PAGE });
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
check("…and, during setup, a Not now that carries on with the site's setup", await shown("#not-now")
  && (await page.$eval("#not-now-link", (a) => a.href)) === `${SITE}/_admin/setup/done`);
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

// --- both, then a different site: asked as usual --------------------------------------------------------------------
await page.goto(out(`${SITE}/_cloudflare/auto-done`, { both: "1" }));
check("asked for both outside setup, there's no Not now", await shown("#ask-both") && !(await shown("#not-now")));
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

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
