// afterwrd.app's Connect page (installer/connect.html), the relay between Cloudflare's Allow page and a site, in a
// real browser: afterwrd.app, Cloudflare and the site are all stood in for, so nothing leaves this computer.
// The old way out, kept for sites from before 2.4: mostly the two lasting permissions asked for together (a new site's
// setup: auto.js, friendchecks.js). Then the way back for sites from 2.4 on, which send the browser to Cloudflare
// themselves and name their return address in the state (src/cloudflare.js allowLink).
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
const NEW = "https://afterwrd.cat-example.workers.dev"; // sites this browser hasn't been back to before
const LOOKALIKE = "https://afterwrd.cat-examp1e.workers.dev";
const OLD = "https://dan.example-4.workers.dev"; // one connected the old way
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
let cloudflare = null; // where the relay sent the browser at Cloudflare
let backAt = null; // where it sent the browser back to
/** A tab, everything around afterwrd.app stood in for. (Tabs share what the page keeps in localStorage, not sessionStorage.) */
async function openTab() {
  const tab = await browser.newPage();
  tab.on("pageerror", (e) => errors.push(e.message));
  tab.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
  await tab.setRequestInterception(true);
  tab.on("request", standIn);
  return tab;
}
function standIn(req) {
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
}
let page = await openTab();
const out = (to, extra = {}) => `${RELAY}?${new URLSearchParams({ to, state: "s".repeat(20), challenge: "c".repeat(43), ...extra })}`;
const shown = (id) => page.$eval(id, (e) => !e.hidden).catch(() => false);
const words = (id) => page.$eval(id, (e) => e.textContent.replace(/\s+/g, " ")).catch(() => "");
const toCloudflare = () => page.waitForFunction(() => document.title === "Cloudflare stand-in", { timeout: 10000 }).then(() => true, () => false);
const backHome = () => page.goto(`${RELAY}?${new URLSearchParams({ code: "code-1", state: "s".repeat(20) })}`)
  .then(() => page.waitForFunction(() => document.title === "site stand-in", { timeout: 10000 }));
// The way back from 2.4 on: the state a site gives Cloudflare names where it goes back to (`<random>~<base64url>`).
const stateFor = (to, encoded = Buffer.from(to).toString("base64url")) => `${"r".repeat(32)}~${encoded}`;
const back = async (to, answer = { code: "code-2" }, state = stateFor(to)) => {
  backAt = null;
  // (Handed straight on, the page can be gone before it has finished loading, which Puppeteer counts as goto failing.)
  await page.goto(`${RELAY}?${new URLSearchParams({ ...answer, state })}`).catch((e) => { if (!/ERR_ABORTED|detached|destroyed/i.test(e.message)) throw e; });
};
const handedOver = () => page.waitForFunction(() => document.title === "site stand-in", { timeout: 5000 }).then(() => true, () => false);
// Nothing handed over: still here a moment later, saying why or asking.
const stayed = async () => { await new Promise((r) => setTimeout(r, 700)); return backAt === null && new URL(page.url()).origin === "https://afterwrd.app"; };

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
check("…warning that afterwrd never sends you here from a link", (await page.$eval("#auto-host + .warn", (p) => p.textContent).catch(() => ""))
  .startsWith("afterwrd never sends you here from a link."));
await page.goto(out(`${SITE}/_check/done`));
check("a friend's check link's way out (gone in 2.4) is refused", !(await page.$("#ask-check")) && !(await shown("#ask")) && (await words("#error")).length > 0);
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

// --- the way back, for a site this browser hasn't been back to ---------------------------------------------------------
await back(`${NEW}/_cloudflare/done`);
const sendHost = await page.$eval("#send-host", (p) => ({ text: p.textContent, mark: p.querySelector("mark")?.textContent })).catch(() => ({}));
check("a site this browser hasn't connected before is shown first, nothing handed over", await stayed() && await shown("#send")
  && sendHost.text === new URL(NEW).host, JSON.stringify(sendHost));
check("…its Cloudflare name picked out, where a look-alike would differ", sendHost.mark === "cat-example");
check("…saying it's new to this browser, and that afterwrd never sends you here from a link", await shown("#send-new")
  && (await words("#send")).includes("afterwrd never sends you here from a link") && !(await shown("#ask")) && !(await shown("#ask-checks")));
check("…shown at once (asking isn't passing through)", await page.evaluate(() => !document.body.classList.contains("passing")));
check("neither the code nor the state stays in the address", page.url() === RELAY, page.url());
await Promise.all([handedOver(), page.click("#send-go")]);
check("Carry on hands Cloudflare's answer to the site's return address, in the fragment", backAt?.origin + backAt?.pathname === `${NEW}/_cloudflare/done`
  && backAt.search === "" && new URLSearchParams(backAt.hash.slice(1)).get("code") === "code-2"
  && new URLSearchParams(backAt.hash.slice(1)).get("state") === stateFor(`${NEW}/_cloudflare/done`), backAt?.href);
await back(`${NEW}/_cloudflare/auto-done`, { code: "code-3" });
check("then the same site again goes straight through, whichever of its return paths", await handedOver()
  && backAt?.href.startsWith(`${NEW}/_cloudflare/auto-done#`) && backAt.hash.includes("code=code-3"), backAt?.href);
await page.goto(RELAY);
const known = await page.evaluate(() => JSON.parse(localStorage.getItem("afterwrd-known-sites") ?? "[]")).catch(() => []);
check("…remembered as known in this browser", known.includes(new URL(NEW).host));
check("…once, however many times it's been carried on to (or 20 sites would soon be about 5)", known.length === new Set(known).size, JSON.stringify(known));
await back(`${LOOKALIKE}/_cloudflare/done`);
check("a look-alike of it is asked about, with its own name picked out", await stayed() && await shown("#send")
  && (await page.$eval("#send-host mark", (m) => m.textContent).catch(() => "")) === "cat-examp1e");
await back(`${LOOKALIKE}/_cloudflare/checks-done`, { error: "access_denied" });
check("Cloudflare saying it wasn't allowed goes straight back, as there's nothing to hand over", await handedOver()
  && backAt?.href === `${LOOKALIKE}/_cloudflare/checks-done#error=access_denied`, backAt?.href);
await back(`${LOOKALIKE}/_cloudflare/done`);
check("…and doesn't make the site known", await stayed() && await shown("#send"));

// --- the way back, with a return address that isn't an afterwrd site's -------------------------------------------------
const refused = async (name, state) => {
  await back(null, { code: "code-4" }, state);
  check(name, await stayed() && !(await shown("#send")) && (await words("#error")).length > 0, `${page.url()} ${await words("#error")}`);
};
await refused("a return address that isn't https is refused, and nothing handed over", stateFor(`http://${new URL(NEW).host}/_cloudflare/done`));
await refused("…as is one at a path that isn't a return path", stateFor(`${NEW}/_admin/update`));
await refused("…or a friend's old check link's way back (gone in 2.4)", stateFor(`${NEW}/_check/done`));
await refused("…or one with a query string", stateFor(`${NEW}/_cloudflare/done?next=/elsewhere`));
await refused("…or with a port", stateFor(`${NEW}:8443/_cloudflare/done`));
await refused("…or one that isn't on workers.dev", stateFor("https://afterwrd.example.com/_cloudflare/done"));
await refused("…or under a workers.dev address's own subdomain", stateFor("https://a.b.cat-example.workers.dev/_cloudflare/done"));
await refused("…or that isn't base64 at all", stateFor(null, "a"));
await refused("…or a state with nothing to say where", `${"r".repeat(32)}~`);

// --- the old way marks a site as known, so the new way then goes straight through -------------------------------------
// In a tab of its own, as a person starting afresh would be. (In the same tab, after the pages above, Chrome now and
// then loses what the old way out keeps in sessionStorage on the way to Cloudflare: something about how this test
// drives the browser, as it never happens in the same steps with a person's pauses between.)
await page.close();
page = await openTab();
cloudflare = null;
await page.goto(out(`${OLD}/_cloudflare/done`, { client: NEW_CLIENT }));
await Promise.all([toCloudflare(), page.click("#continue")]);
await backHome();
check("the old way still hands Cloudflare's answer back to the site that asked", backAt?.href.startsWith(`${OLD}/_cloudflare/done#`));
await back(`${OLD}/_cloudflare/auto-done`);
check("…and a site connected that way then goes straight through on the new way back", await handedOver() && backAt?.href.startsWith(`${OLD}/_cloudflare/auto-done#`));

check("afterwrd.app's Connect page comes from the installer's Worker, its script allowed only by the answer's nonce",
  served.length > 0 && served.every((p) => p.path !== "/connect/" || (p.status === 200 && /script-src 'nonce-[\w-]{24}'/.test(p.policy ?? ""))),
  JSON.stringify(served.slice(0, 2)));
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
