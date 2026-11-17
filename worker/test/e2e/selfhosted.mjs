// A self-hosted site (hosting.js; HOSTING=self): Ann's on 8787, self-hosted; Bob's on 8788 stands for a site on
// Cloudflare (TEST_SELF_HOSTED tells it Ann's is self-hosted); a group's site on 8790. Ann's site has none of what
// works through Cloudflare: its Update page says how to update the server, its sign-in page how to get back in from
// there, and Connect, automatic updates and checks aren't there at all. Bob's site never offers to check Ann's, or to
// have hers check his. Ann starts a group from an address and a setup code, as a command on her server gives them.
//   node selfhosted.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import puppeteer from "puppeteer-core";
import { count as n } from "./helpers.mjs";

const [, , stateA, , , stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const G = "http://localhost:8790";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return page;
}
async function owner(site, name) {
  const page = await person();
  await page.goto(`${site}/_auth/setup?code=${CODE}`);
  await page.type("#name", name);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  return page;
}
const text = (page) => page.$eval("main", (m) => m.innerText).catch(() => "");
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);
const status = (page, path, method = "GET") => page.evaluate(async (p, m) => (await fetch(p, { method: m, redirect: "manual" })).status, path, method);
async function befriend(inviter, site, friend, friendSite) {
  await inviter.goto(`${site}/_admin/connections`);
  await inviter.click("#make");
  await inviter.waitForSelector("#link:not([hidden])");
  const link = await inviter.$eval("#link-url", (i) => i.value);
  await friend.goto(`${friendSite}/_admin/connections`);
  await friend.type("#paste input[name=link]", link);
  await Promise.all([friend.waitForNavigation(), friend.click("#paste button:not([type=button])")]);
  await Promise.all([friend.waitForNavigation({ timeout: 30_000 }), friend.click("#go")]);
  await inviter.goto(`${site}/`);
  await Promise.all([inviter.waitForNavigation(), inviter.click('.notice.asking button[formaction*="/approve"]')]);
}

// --- signing in -------------------------------------------------------------------------------------------------
const stranger = await person();
await stranger.goto(`${A}/_auth/login`);
const signIn = await stranger.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
check("sign-in says how to get back in from the server", signIn.includes("docker compose exec afterwrd recover")
  && !(await stranger.$('a[href="/_auth/recover"]')), signIn.slice(0, 200));
check("…and getting back in through Cloudflare isn't there", (await fetch(`${A}/_auth/recover`, { redirect: "manual" })).status === 404
  && (await fetch(`${A}/_auth/recover/start`, { redirect: "manual" })).status === 404);
await stranger.goto(`${B}/_auth/login`);
check("a site on Cloudflare still has Lost your device?", Boolean(await stranger.$('a[href="/_auth/recover"]')));

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");

// --- updating ---------------------------------------------------------------------------------------------------
await ann.goto(`${A}/_admin/update`);
const update = await text(ann);
check("the Update page says it's on her own server", update.includes("on your own server"), update.slice(0, 200));
check("…with no Connect, automatic updates or check offers", !update.includes("Connect Cloudflare") && !update.includes("automatic updates")
  && !(await ann.$("#auto, #checks-off, #ask-check, button[data-ask]")));
check("…and says friends' sites can't check it", update.includes("friends' sites can't check it"));
check("updating through Cloudflare isn't there", (await post(ann, "/_admin/update/check", { tag: "v9.9.9" })).status === 404
  && (await post(ann, "/_admin/update/install-now")).status === 404 && (await post(ann, "/_admin/update/auto-off")).status === 404);
check("…but the version still answers", /^\d+\.\d+\.\d+$/.test((await ann.evaluate(() => fetch("/_admin/update/version").then((r) => r.json()))).version ?? ""));

// --- what's only on Cloudflare ----------------------------------------------------------------------------------
const gone = {
  "GET /_cloudflare/auto-start": await status(ann, "/_cloudflare/auto-start"),
  "GET /_cloudflare/checks-start": await status(ann, "/_cloudflare/checks-start"),
  "GET /_cloudflare/connect": await status(ann, "/_cloudflare/connect?back=/"),
  "POST /_auto/step": (await fetch(`${A}/_auto/step`, { method: "POST", body: "{}" })).status,
  "GET /_check/x": (await fetch(`${A}/_check/${"x".repeat(43)}`)).status,
  "POST /_admin/checks/new": (await post(ann, "/_admin/checks/new", {})).status,
  "POST /_admin/checks/myself": await status(ann, "/_admin/checks/myself", "POST"),
  "POST /_peer/check-token": (await fetch(`${A}/_peer/check-token`, { method: "POST", body: "{}" })).status,
  "POST /_peer/check-request": (await fetch(`${A}/_peer/check-request`, { method: "POST", body: "{}" })).status,
  "POST /_groups/create/check": (await post(ann, "/_groups/create/check", { name: "x" })).status,
};
const open = Object.entries(gone).filter(([, s]) => s !== 404);
check("Connect, automatic updates, checks and making Workers aren't there", open.length === 0, JSON.stringify(open));

// --- friends: Bob's site, on Cloudflare, can't check Ann's or ask hers for a check ------------------------------
await befriend(ann, A, bob, B);
check("a self-hosted site and one on Cloudflare can be friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 1);
const annOnBob = await bob.evaluate(() => fetch("/friend").then((r) => r.text()));
const annId = Number(/href="\/friend\/(\d+)\/posts"/.exec(annOnBob)?.[1]);
await bob.goto(`${B}/friend/${annId}/posts`);
check("Bob's site says Ann's is self-hosted and can't be checked", (await bob.$eval(".meta", (m) => m.textContent).catch(() => "")).includes("self-hosted, can't be checked"));
await bob.goto(`${B}/_admin/update`);
check("Bob's Update page doesn't offer to ask Ann for a check", !(await bob.$(`button[data-ask="${annId}"]`)));
const asked = await post(bob, "/_admin/checks/ask", { connection: annId });
check("…and asking her anyway is refused", asked.status === 409 && /self-hosted/.test(asked.error ?? ""), JSON.stringify(asked));
const link = await post(bob, "/_admin/checks/new", { site: A });
check("a check link for Ann's site is refused", link.status === 400 && /isn't on Cloudflare/.test(link.error ?? ""), JSON.stringify(link));
const pasted = await post(bob, "/_admin/checks/new", { site: "walkers.example.com" });
check("…as is one for any address not on Cloudflare", pasted.status === 400 && /isn't on Cloudflare/.test(pasted.error ?? ""), JSON.stringify(pasted));

// --- a group, made on the server, claimed here ------------------------------------------------------------------
await ann.goto(`${A}/groups/new`);
const startPage = await text(ann);
check("Start a group says to run the command on the server", startPage.includes("docker compose exec afterwrd new-group")
  && !startPage.includes("Cloudflare"), startPage.slice(0, 300));
const fill = async (code) => {
  await ann.goto(`${A}/groups/new`);
  await ann.type("#start input[name=name]", "Walkers");
  await ann.type("#start input[name=origin]", G);
  await ann.type("#start input[name=setup]", code);
};
await fill("not-the-code");
await ann.click("#go");
await ann.waitForFunction(() => document.getElementById("error").textContent.length > 0, { timeout: 30_000 });
check("a wrong setup code is refused", (await ann.$eval("#error", (e) => e.textContent)).includes("key"));
check("…and leaves nothing behind", n(stateA, "groups") === 0);
await fill(GROUP_KEY);
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#go")]);
check("with the right code, Ann's site claims the group", /\/groups\/\d+\/members$/.test(new URL(ann.url()).pathname)
  && n(stateG, "group_members WHERE role = 'owner'") === 1, ann.url());
check("its page says how to remove its site from the server", (await ann.$eval("#delete-command", (p) => p.textContent).catch(() => ""))
  .includes("docker compose exec afterwrd delete-group localhost:8790"));
check("…and asks for no Cloudflare connection to delete it", !(await ann.$("#delete a.connect")));
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#delete-go")]);
check("deleting it empties the group's site, and Ann's forgets it", n(stateG, "group_members") === 0 && n(stateA, "groups") === 0);

// --- Home -------------------------------------------------------------------------------------------------------
await ann.goto(`${A}/`);
check("Home has nothing about checks or automatic updates", !(await ann.$(".check-request, #check-failure, .friend-check")));

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
