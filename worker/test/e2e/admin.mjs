// End-to-end for Your devices: only the owner signs in. The owner adds a second device from the page, removes a
// passkey (never the last), cancels unused links and signs out everywhere; there's no inviting anyone else.
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled, sql, browserKeyOf, setUpSigning } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/owner.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// Each suite starts on a new site (run.sh), and makes its owner from the terminal: the link to add their first device.
const newOwner = (name) => cli(name).match(/http\S+\/_auth\/device\/\S+/)[0];
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
// The main menu, then what's behind the person's picture.
const navLabels = (page) => page.$$eval("header.site nav.main a, header.site .menu > a", (a) => a.map((x) => x.querySelector("span").textContent.trim()).join(","));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });

async function device() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  return page;
}
async function register(page, link) {
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
}
// Each passkey, and whether it can be removed (the only one has no Remove).
const passkeys = (page) => page.$$eval(".devices li[data-credential]", (l) => l.map((li) => ({
  id: li.dataset.credential, disabled: !li.querySelector("button[data-action=delete-passkey]") })));

// The owner joins via the terminal, as on a brand-new site.
const ownerName = `Owner ${Date.now()}`;
const newRecoveryCodeLike = () => Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("")).join("-");
const phone = await device();
await register(phone, newOwner(ownerName));
check("a site's first passkey goes on to its recovery code", new URL(phone.url()).pathname === "/_admin/keys");
const recoveryCode = await setUpSigning(phone);
// afterwrd 2's keys (keys.js): the owner's identity, this browser's key, the site's hosting key; never the code.
const identity = sql("SELECT person, chain FROM own_identity")[0];
const firstDoc = identity && JSON.parse(Buffer.from(JSON.parse(identity.chain)[0].bytes, "base64url").toString());
check("signing is set up: an identity listing the owner's passkey, this site and a recovery key",
  firstDoc?.seq === 0 && firstDoc.passkeys.length === 1 && firstDoc.passkeys[0].id === sql("SELECT id FROM credentials")[0].id
  && firstDoc.origin === BASE && /^[\w-]{43}$/.test(firstDoc.recovery), JSON.stringify(firstDoc));
check("…and the site's hosting key, kept with its other keys", sql("SELECT COUNT(*) AS n FROM settings WHERE key = 'hosting_key'")[0].n === 1
  && /^[\w-]{43}$/.test(firstDoc?.hosting ?? ""));
const allowed = sql("SELECT key, session_hash, expires_at - strftime('%s','now') AS left FROM delegations");
const phoneBrowserKey = await browserKeyOf(phone);
check("this browser's key may sign for the owner for 30 days, with its session", allowed.length === 1 && allowed[0].key === phoneBrowserKey?.publicKey
  && Boolean(allowed[0].session_hash) && Math.abs(allowed[0].left - 30 * 86400) < 300, JSON.stringify(allowed));
check("…kept where not even the page can copy it out", phoneBrowserKey?.extractable === false && phoneBrowserKey.person === identity.person);
const everything = JSON.stringify(["own_identity", "identity_seen", "delegations", "settings", "credentials", "sessions"].map((t) => sql(`SELECT * FROM ${t}`)));
check("the recovery code is kept nowhere on the site", /^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/.test(recoveryCode)
  && !everything.includes(recoveryCode) && !everything.includes(recoveryCode.replace(/-/g, "")));
check("the signing code is public, so the sign-in page can use it", (await fetch(`${BASE}/static/signed.js`)).status === 200
  && (await fetch(`${BASE}/static/browserkey.js`)).status === 200 && (await fetch(`${BASE}/static/ui/main.js`, { redirect: "manual" })).status === 302);
// A browser still signed in from before afterwrd 2 has no key (it's made at sign-in). Home offers to let it sign, with
// one prompt, without signing out (ui/letsign.js, keys.js browser/start and browser/finish).
await phone.goto(`${BASE}/`);
check("a browser that can sign isn't offered to", await phone.$eval("[data-browser-sign]", (b) => b.hidden));
await phone.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("afterwrd-keys", 1); r.onsuccess = () => {
  const t = r.result.transaction("keys", "readwrite"); t.objectStore("keys").delete("browser"); t.oncomplete = () => { r.result.close(); resolve(null); }; }; }));
await phone.reload();
await phone.waitForSelector("[data-browser-sign]:not([hidden])", { timeout: 10_000 }).catch(() => null);
check("without a key, Home says this browser can't sign yet, and offers to let it",
  await phone.$eval("[data-browser-sign]", (b) => !b.hidden && b.querySelector("button").textContent === "Let this browser sign"));
await phone.click("[data-browser-sign] button");
await phone.waitForFunction(() => document.querySelector("[data-browser-sign]").textContent.includes("Done"), { timeout: 15_000 }).catch(() => null);
const letKey = await browserKeyOf(phone);
check("…one prompt later, it has a key that signs for the owner, kept with this session",
  letKey?.person === identity.person && /^[\w-]+$/.test(letKey.publicKey) && sql(`SELECT COUNT(*) AS n FROM delegations WHERE key = '${letKey.publicKey}' AND session_hash IS NOT NULL`)[0]?.n === 1,
  JSON.stringify(sql("SELECT key FROM delegations")));
await phone.reload();
check("…and Home stops offering", await phone.$eval("[data-browser-sign]", (b) => b.hidden));
// The phone's browser keys allowed so far (its first, and the one just made), for counting new devices' below.
const phoneDelegations = sql("SELECT COUNT(*) AS n FROM delegations")[0].n;
await phone.goto(`${BASE}/_admin/keys`);
check("setting up signing again just goes on", new URL(phone.url()).pathname === "/");
const startAgain = await phone.evaluate(async () => (await fetch("/_admin/keys/start", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ recovery: "a".repeat(43), browserKey: "b".repeat(43) }) })).status);
check("…and can't be started again", startAgain === 409);
let second = "";
try { cli(`Second ${Date.now()}`); } catch (e) { second = String(e.stderr); }
check("the terminal won't make a second owner", second.includes("already has an owner"), second.trim());
check("the menu has Your devices", (await navLabels(phone)) === "Home,Photos,Friends,Groups,Events,Notifications,Your profile,Your devices,Add to home screen,Import,Download everything,Update,Help", await navLabels(phone));
// The look: dark unless chosen, picked behind the picture, kept in this browser (also for the sign-in page), and Auto
// as the device is set.
const look = (page) => page.evaluate(() => `${document.documentElement.dataset.look}/${document.querySelector('input[name="look"]:checked')?.value}`);
check("the look starts dark", (await look(phone)) === "dark/dark", await look(phone));
await phone.click("details.me summary");
await phone.click('input[name="look"][value="light"]');
check("choosing Light changes the page at once", (await phone.evaluate(() => document.documentElement.dataset.look)) === "light");
await phone.goto(`${BASE}/posts`);
check("…and it's remembered on the next page", (await look(phone)) === "light/light", await look(phone));
check("…and on the sign-in page", await (async () => {
  const other = await phone.browserContext().newPage();
  await other.goto(`${BASE}/_auth/login`);
  const it = await other.evaluate(() => document.documentElement.dataset.look);
  await other.close();
  return it === "light";
})());
await phone.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await phone.click("details.me summary");
await phone.click('input[name="look"][value="auto"]');
check("Auto follows a dark device", (await look(phone)) === "dark/auto", await look(phone));
await phone.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await phone.reload();
check("…and a light one", (await look(phone)) === "light/auto", await look(phone));
await phone.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "" }]);
await phone.evaluate(() => localStorage.removeItem("afterwrd-look"));

await phone.goto(`${BASE}/_admin`);
check("Your devices lists one passkey, with no Remove (it's the only one)", (await phone.$eval("h1", (h) => h.textContent)) === "Your devices"
  && JSON.stringify((await passkeys(phone)).map((k) => k.disabled)) === "[true]");
check("no inviting other people", !(await phone.$("#invite")) && !(await phone.$("button[data-action=revoke]")));

const alerts = async (page) => { await page.goto(`${BASE}/`); return page.$$eval(".notice.alert", (n) => n.map((x) => x.textContent.replace(/\s+/g, " ").trim())); };
check("the first passkey isn't a new device", (await alerts(phone)).length === 0);
// One added in the very same second is still a new device: told apart by the order it was stored.
const firstAt = sql("SELECT created_at FROM credentials")[0].created_at;
sql(`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES ('same-second', (SELECT id FROM users), 'x', 0, '[]', ${firstAt})`);
check("a passkey added in the same second as the first is still a new device", (await alerts(phone)).some((t) => t.startsWith("A new device was added")),
  (await alerts(phone)).join(" | "));
sql("DELETE FROM credentials WHERE id = 'same-second'");
// Add a laptop from the page.
await phone.goto(`${BASE}/_admin`);
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
const link = await phone.$eval("#link-url", (i) => i.value);
check("Add a device shows a one-time link", /\/_auth\/device\/[\w-]{40,}$/.test(link), link.slice(0, 60) + "…");
// On a device that signs, the page waits for the new device's passkey, then offers to let it sign (keys.js).
check("…and, on a device that signs, says it'll show the new device here", (await phone.$eval("#link-note", (p) => p.textContent))
  .startsWith("Once it has its passkey, it shows here"), await phone.$eval("#link-note", (p) => p.textContent));
const laptop = await device();
await laptop.goto(link);
check("the link says it's adding a device", (await laptop.title()).startsWith("Add this device") && (await laptop.$eval("main, body", (m) => m.textContent)).includes("Add this phone or computer"));
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
check("after its passkey, the laptop waits to be let sign for the owner", new URL(laptop.url()).pathname === "/_admin/keys/join"
  && !(await laptop.$eval("#waiting", (p) => p.hidden)) && (await laptop.$eval("#ready", (d) => d.hidden)));
await phone.waitForSelector("#let-sign:not([hidden])", { timeout: 15_000 });
check("the phone sees the new device and offers to let it sign", (await phone.$eval("#let-sign button", (b) => b.textContent)) === "Let it sign for you");
await Promise.all([phone.waitForNavigation({ timeout: 30_000 }), phone.click("#let-sign button")]);
await laptop.waitForSelector("#ready:not([hidden])", { timeout: 15_000 });
await Promise.all([laptop.waitForNavigation({ timeout: 30_000 }), laptop.click("#go")]);
check("the laptop is signed in as the owner", (await navLabels(laptop)).includes("Your devices"), await navLabels(laptop));
const docs = () => JSON.parse(sql("SELECT chain FROM own_identity")[0].chain).map((d) => JSON.parse(Buffer.from(d.bytes, "base64url").toString()));
const laptopBrowserKey = await browserKeyOf(laptop);
check("…and signs for them: its passkey added to the identity, its browser allowed", docs().length === 2 && docs()[1].passkeys.length === 2
  && sql("SELECT COUNT(*) AS n FROM delegations")[0].n === phoneDelegations + 1 && laptopBrowserKey?.person === identity.person && laptopBrowserKey.extractable === false,
  JSON.stringify(docs().map((d) => d.passkeys.length)));
const reuse = await (await device()).goto(link);
check("the link only works once", reuse.status() === 404);

// The phone hears that a device was added; the laptop (the new device) doesn't, and can't hide it.
check("Home on the phone says a new device was added", (await alerts(phone)).some((t) => t.startsWith("A new device was added")), (await alerts(phone)).join(" | "));
check("…but not on the new device itself", (await alerts(laptop)).length === 0);
const laptopCookie = (await laptop.cookies()).find((c) => c.name === "__Host-session").value;
const fromLaptop = (path) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${laptopCookie}`, Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
check("the new device can't say it was them", (await fromLaptop("/_admin/devices/seen")).status === 403 && (await alerts(phone)).length === 1);
// An intruder's trick: add a second passkey from the new device, then confirm from the first. Neither can.
const spare = await device();
await register(spare, (await (await fromLaptop("/_admin/devices/link")).json()).link);
const onLaptop = await alerts(laptop);
check("the new device hears of the next one, but can't confirm it", onLaptop.length === 1 && onLaptop[0].includes("say so from one of your older devices")
  && (await laptop.$$(".notice.alert button")).length === 0, onLaptop.join(" | "));
check("…even by asking directly", (await fromLaptop("/_admin/devices/seen")).status === 403);
const onPhone = await alerts(phone);
check("the phone lists both new devices", onPhone.length === 1 && onPhone[0].startsWith("2 new devices were added"), onPhone.join(" | "));
await Promise.all([settled(phone), phone.click(".notice.alert button")]);
check("\"They were all me\" on the phone clears it", new URL(phone.url()).pathname === "/" && (await alerts(phone)).length === 0);
// Put things back as they were: the spare passkey goes (the laptop's stays for the checks below).
const spareKey = sql("SELECT id FROM credentials ORDER BY rowid DESC LIMIT 1")[0].id;
const phoneCookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
await fetch(`${BASE}/_admin/devices/delete-passkey`, { method: "POST", headers: { Cookie: `__Host-session=${phoneCookie}`, Origin: BASE,
  "Content-Type": "application/json" }, body: JSON.stringify({ credential: spareKey }) });
check("the laptop, no longer new, has nothing to hear", (await alerts(laptop)).length === 0);

// Changing the owner's identity from Your devices (keys.js). A device added with a link made by API signs in, and waits
// to be let sign; "Let it sign for you" on a device that signs adds it, at once, even from a page loaded afterwards.
const desk = await device();
await register(desk, (await (await fromLaptop("/_admin/devices/link")).json()).link);
check("a device added without a signing device's say-so signs in, but can't sign", new URL(desk.url()).pathname === "/_admin/keys/join"
  && docs().length === 2 && sql("SELECT COUNT(*) AS n FROM delegations")[0].n === phoneDelegations + 1);
const deskKey = sql("SELECT id FROM credentials ORDER BY rowid DESC LIMIT 1")[0].id;
const statusOf = async (page, id) => { await page.goto(`${BASE}/_admin`); return page.$eval(`li[data-credential="${id}"] .meta`, (m) => m.textContent).catch(() => ""); };
check("Your devices says so", (await statusOf(phone, deskKey)).includes("can't sign for you yet"), await statusOf(phone, deskKey));
const reloaded = (page) => page.waitForNavigation({ timeout: 30_000 });
await Promise.all([reloaded(phone), phone.click("button[data-sign=allow]")]);
check("…and \"Let it sign for you\" adds it, at once", docs().length === 3 && docs()[2].passkeys.some((p) => p.id === deskKey)
  && (await statusOf(phone, deskKey)).includes("signs for you"));
// Removing a passkey that signs: it stops signing in at once, and stops signing after 7 days, which Home says.
await Promise.all([reloaded(phone), phone.click(`button[data-action=delete-passkey][data-credential="${deskKey}"]`)]);
await phone.goto(`${BASE}/_admin`);
const waitingCard = async (page) => page.$eval("#identity-change", (c) => c.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
check("removing a passkey that signs waits 7 days, and says so", docs().length === 4 && /Waiting until .* 1 passkey will stop signing for you/.test(await waitingCard(phone))
  && sql("SELECT COUNT(*) AS n FROM credentials WHERE id = '" + deskKey + "'")[0].n === 0, await waitingCard(phone));
check("…and so does Home, on every device", (await alerts(laptop)).some((t) => t.startsWith("Your identity is changing: 1 passkey will stop signing for you")),
  (await alerts(laptop)).join(" | "));
await phone.goto(`${BASE}/_admin`);
await Promise.all([reloaded(phone), phone.click("button[data-sign=cancel]")]);
check("a device that signs can cancel it", docs().length === 5 && docs()[4].cancels && !(await waitingCard(phone)) && (await alerts(phone)).every((t) => !t.startsWith("Your identity")));
// Lost every device that signs: the recovery code makes the passkeys here the ones that sign, after 7 days; only the
// code can cancel that. (Here the desk's passkey, gone from the site, drops out.)
const useCode = async (page, code, waitFor = () => reloaded(page)) => {
  await page.goto(`${BASE}/_admin`);
  await page.click("#recovery summary");
  await page.type("#recovery-code", code);
  await Promise.all([waitFor(), page.click("button[data-recovery]")]);
};
await useCode(laptop, newRecoveryCodeLike(), () => laptop.waitForFunction(() => document.getElementById("error").textContent.trim(), { timeout: 15_000 }));
check("a recovery code that isn't the owner's is refused", (await laptop.$eval("#error", (e) => e.textContent)).includes("isn't your recovery code") && docs().length === 5,
  await laptop.$eval("#error", (e) => e.textContent));
await useCode(laptop, recoveryCode.toLowerCase().replace(/-/g, " "));
check("the owner's recovery code (however it's typed) makes the passkeys here the ones that sign, after 7 days",
  docs().length === 6 && docs()[5].passkeys.length === 2 && /1 passkey will stop signing for you \(asked with your recovery code\)/.test(await waitingCard(laptop)),
  await waitingCard(laptop));
const changeApi = (page) => page.evaluate(async () => (await fetch("/_admin/keys/change/start", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: "cancel" }) })).status);
check("…which a passkey can't cancel", !(await phone.$("button[data-sign=cancel]")) && (await changeApi(phone)) === 403);
await useCode(phone, recoveryCode);
check("…but the recovery code can", docs().length === 7 && !(await waitingCard(phone)));
// A new recovery code: shown once, kept, then the change waits 7 days (cancelled here, to put things back).
await phone.goto(`${BASE}/_admin`);
await phone.click("#recovery summary");
await phone.click("button[data-sign=new-code]");
const newCode = await phone.$eval("#new-code-text", (c) => c.textContent);
await Promise.all([reloaded(phone), phone.click("button[data-sign=new-code-kept]")]);
check("a new recovery code waits 7 days too", /^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/.test(newCode) && docs().length === 8
  && docs()[7].recovery !== docs()[6].recovery && /your recovery code will change/.test(await waitingCard(phone)), await waitingCard(phone));
await phone.goto(`${BASE}/_admin`);
await Promise.all([reloaded(phone), phone.click("button[data-sign=cancel]")]);
check("…and can be cancelled", docs().length === 9 && !(await waitingCard(phone)));

// A release that fixes a security problem: Home says so, and so does the Update page. (A made-up release, saved as
// if the owner's site had just checked GitHub.)
const nowSeconds = Math.floor(Date.now() / 1000);
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${JSON.stringify({ version: "99.0.1", checked: nowSeconds,
  latest: { tag: "v99.0.1", version: "99.0.1", notes: "Made up.", page: "https://example.com/", securityFix: "99.0.0" } })}')`);
check("Home says an update fixes a security problem", (await alerts(phone)).some((t) => t.includes("99.0.0 fixes a security problem")), (await alerts(phone)).join(" | "));
await phone.goto(`${BASE}/_admin/update`);
check("…and so does the Update page", (await phone.$eval("main", (m) => m.textContent)).includes("It fixes a security problem"));
// An ordinary update: no line on Home (only security fixes get one), just the red dot on the picture and
// "Update available" behind it, on every page, even one that was already open.
sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_release', '${JSON.stringify({ version: "99.0.2", checked: nowSeconds,
  latest: { tag: "v99.0.2", version: "99.0.2", notes: "Made up.", page: "https://example.com/" } })}')`);
const homeLines = async () => { await phone.goto(`${BASE}/`); return phone.$$eval(".stream > .notice", (n) => n.map((x) => x.textContent.replace(/\s+/g, " ").trim())); };
check("Home doesn't mention an ordinary update", !(await homeLines()).some((t) => t.includes("99.0.2")), (await homeLines()).join(" | "));
check("…but the picture has the dot", (await phone.$$("details.me summary .dot")).length === 1);
const ownerCookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
const live = await (await fetch(`${BASE}/_live?since=0`, { headers: { Cookie: `__Host-session=${ownerCookie}` } })).json();
check("the live check reports it", live.update === "99.0.2", JSON.stringify(live));
await phone.goto(`${BASE}/_admin`);
await phone.waitForFunction(() => document.querySelector('.menu a[href="/_admin/update"]')?.textContent.includes("Update available"), { timeout: 10000 })
  .catch(() => {});
check("an owner page gains the mark by itself, dot included", (await phone.$eval('.menu a[href="/_admin/update"]', (a) => a.textContent)).includes("Update available")
  && (await phone.$$("details.me summary .dot")).length === 1);
sql("DELETE FROM settings WHERE key = 'latest_release'");

await phone.goto(`${BASE}/_admin`);
let keys = await passkeys(phone);
check("two passkeys now, both removable", keys.length === 2 && keys.every((k) => !k.disabled));

// Unused links can be cancelled.
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
const unused = await phone.$eval("#link-url", (i) => i.value);
await phone.goto(`${BASE}/_admin`);
await Promise.all([phone.waitForNavigation(), phone.click("button[data-action=cancel-links]")]);
check("cancelled links stop working", (await (await device()).goto(unused)).status() === 404);

// The API refuses another site, other people's passkeys and the last passkey.
const cookie = (await phone.cookies()).find((c) => c.name === "__Host-session").value;
const api = (path, body, origin = BASE) => fetch(BASE + path, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
check("another site can't make a device link", (await api("/_admin/devices/link", {}, "https://evil.example")).status === 403);
check("the old People actions are gone", (await api("/_admin/invite", { name: "Sneaky" })).status === 404
  && (await api("/_admin/people/1/revoke")).status === 404);
check("a made-up passkey can't be removed", (await api("/_admin/devices/delete-passkey", { credential: "not-a-passkey" })).status === 404);

// Remove the laptop's passkey: the laptop is signed out, the phone isn't; then the phone's is the last and stays.
// Which is which, in the order they were made.
const [phoneKey, laptopKey] = sql(`SELECT c.id FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.name = '${ownerName}' ORDER BY c.rowid`).map((k) => k.id);
check("removing a passkey works", (await api("/_admin/devices/delete-passkey", { credential: laptopKey })).status === 200);
await laptop.goto(`${BASE}/posts`);
await phone.goto(`${BASE}/posts`);
check("…and signs that device out, only that one", new URL(laptop.url()).pathname === "/_auth/login" && new URL(phone.url()).pathname === "/posts");
check("the last passkey can't be removed", (await api("/_admin/devices/delete-passkey", { credential: phoneKey })).status === 400);

// Sign out everywhere.
const tablet = await device();
await phone.goto(`${BASE}/_admin`);
await phone.click("#new-link");
await phone.waitForSelector("#link:not([hidden])");
await phone.waitForFunction(() => document.getElementById("link-note").textContent.trim(), { timeout: 15_000 });
await register(tablet, await phone.$eval("#link-url", (i) => i.value));
await phone.goto(`${BASE}/_admin`);
await Promise.all([phone.waitForNavigation(), phone.click("button[data-action=sign-out]")]);
await tablet.goto(`${BASE}/posts`);
check("sign out everywhere signs out every device", new URL(phone.url()).pathname === "/_auth/login"
  && new URL(tablet.url()).pathname === "/_auth/login");
check("…and no browser may sign for the owner any more", sql("SELECT COUNT(*) AS n FROM delegations")[0].n === 0);
check("…and the sign-in page forgets this browser's key", await (async () => { await new Promise((r) => setTimeout(r, 500)); return (await browserKeyOf(phone)) === null; })());

const signedOutAdmin = await fetch(`${BASE}/_admin`, { redirect: "manual" });
check("signed-out /_admin redirects to sign-in", signedOutAdmin.status === 302);

await phone.setViewport({ width: 375, height: 800, isMobile: true });
await phone.goto(`${BASE}/_auth/login`);
await Promise.all([phone.waitForNavigation(), phone.click("#go")]).catch(() => {});
const again = sql("SELECT key, session_hash FROM delegations");
const newKey = await browserKeyOf(phone);
check("signing in again makes a new browser key, allowed in the same prompt", again.length === 1 && again[0].key === newKey?.publicKey
  && newKey.publicKey !== phoneBrowserKey.publicKey && newKey.person === identity.person && newKey.expires > Date.now() / 1000 + 29 * 86400, JSON.stringify(again));
await phone.goto(`${BASE}/_admin`);
await phone.screenshot({ path: `${OUT}/devices-phone.png`, fullPage: true });

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
