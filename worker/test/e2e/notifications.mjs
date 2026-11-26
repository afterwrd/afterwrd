// Notifications on the owner's own devices (src/push.js), and Add to home screen. Ann (A, 8787) and Sam (B, 8788) are
// friends; Sam makes signed events and posts on his site, whose notes reach Ann's (src/notes.js). Run here too: a stand-in push service (8795)
// that decrypts what it's sent, as a phone would. Turning notifications on (only from the owner's own pages, only to a
// push service), the Home notice, Your devices; a notification for an invitation, a change and calling off, with or
// without the details, and none for posts, comments, an event Ann said no to, or one taken back; trying a push service
// again when it fails; forgetting a device that's gone; a device's new address; signing out; the download; and the
// messages that used to be here, gone.
//   node notifications.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { count as n, settled, siteCall, siteSql as sql, setUpSigning } from "./helpers.mjs";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const PUSH = "http://localhost:8795";
const CODE = "local-test-setup-code";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await test()) return true;
  return false;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(`${site}: ${m.text()}`); }); // blocked by the page's policy
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${site}/_auth/setup?code=${CODE}`);
  await page.type("#name", name);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await setUpSigning(page);
  return page;
}
// A call from the owner's own signed-in page, as the pages' scripts make them.
const call = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, b === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}, path, body);
const mainText = (page) => page.$eval("main", (m) => m.textContent);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = () => randomBytes(32).toString("base64url");

/** `inviter` makes a friend link, `friend` pastes it into their own site and confirms, `inviter` approves. */
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
const ahead = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
/** Sam makes an event on his site, inviting Ann (signed in his browser, sent by his site). Returns its id. */
async function samInvites(title, days, place = "The park") {
  await sam.goto(`${B}/events`);
  await sam.$eval("#make", (d) => { d.open = true; });
  await sam.$eval("#make input[name=title]", (i, v) => { i.value = v; }, title);
  await sam.$eval("#make input[name=start_date]", (i, v) => { i.value = v; }, ahead(days));
  await sam.$eval("#make input[name=start_time]", (i) => { i.value = "13:00"; });
  await sam.$eval("#make input[name=place]", (i, v) => { i.value = v; }, place);
  await sam.$$eval("#make .guest-options label", (labels) => labels.find((l) => l.textContent.trim() === "Ann Example")?.querySelector("input").click());
  await Promise.all([sam.waitForNavigation({ timeout: 30_000 }), sam.click("#make button.primary")]);
  return new URL(sam.url()).pathname.split("/").pop();
}
/** Sam changes where his event is (a signed change). */
async function samMoves(id, place) {
  await sam.goto(`${B}/posts/${id}/event`);
  await sam.$eval("input[name=place]", (i, v) => { i.value = v; }, place);
  await Promise.all([sam.waitForNavigation({ timeout: 30_000 }), sam.click(".event-form button.primary")]);
}

const ann = await owner(A, "Ann Example");
const sam = await owner(B, "Sam Taylor");
await befriend(sam, B, ann, A);
const [samHere] = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`);
// A signed call from Sam's site to Ann's, as it makes them.
const fromSam = (path, body) => siteCall(stateB, B, `${A}${path}`, body);

// --- the messages that were here are gone --------------------------------------------------------------------------------

await ann.goto(`${A}/`);
check("the menu has no Messages", (await ann.$('header.site a[href="/messages"]')) === null);
check("…and Messages isn't there", (await ann.goto(`${A}/messages`)).status() === 404);
await ann.goto(`${A}/friend/${samHere.id}/posts`);
check("a friend's page has no Message button", (await ann.$(`a[href="/friend/${samHere.id}/message"]`)) === null);
const oldMessage = await fromSam("/_peer/message", { type: "Create", object: { type: "Note", id: `${B}/messages/${"a".repeat(16)}`, content: "Hi" } });
check("there's nowhere for a friend's site to send a message", ![200, 202].includes(oldMessage.status), String(oldMessage.status));
check("…and the site's own chat calls are gone too", [404, 405].includes((await call(ann, "/_messages/1/send", { text: "Hi" })).status));
check("the tables went with them", n(stateA, "sqlite_master WHERE name IN ('chats', 'messages', 'group_chat')") === 0);

// --- turning notifications on ---------------------------------------------------------------------------------------------

// A stand-in push service, and a "phone" whose keys only this test has: what reaches it is decrypted as a phone would,
// and the site's signature checked. /push/flaky fails once ("try later"), then works; /push/gone says it's gone.
const pushes = [];
let flaky = 0;
const pushService = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    if (req.url === "/push/gone") { res.writeHead(410).end(); return; }
    if (req.url === "/push/flaky" && (flaky += 1) === 1) { res.writeHead(503).end(); return; }
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(201).end();
  });
}).listen(8795);
const phone = createECDH("prime256v1");
phone.generateKeys();
const phoneAuth = randomBytes(16);
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const ikm = Buffer.from(hkdfSync("sha256", phone.computeSecret(asPublic), phoneAuth, Buffer.concat([Buffer.from("WebPush: info\0"), phone.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const sealed = body.subarray(21 + body[20]);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end -= 1; // padding
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}
function signedBySite(push, siteKey) {
  const [, token, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(push.headers.authorization ?? "") ?? [];
  if (!token || k !== siteKey) return false;
  const [h, c, s] = token.split(".");
  const raw = Buffer.from(k, "base64url");
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  return JSON.parse(Buffer.from(c, "base64url")).aud === PUSH && verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
}
const toPhone = () => pushes.filter((p) => p.path === "/push/phone");

await ann.goto(`${A}/events`);
check("Events doesn't have the notifications switch any more", !(await ann.$("#notify")));
await ann.goto(`${A}/_admin`);
const siteKey = await ann.$eval("#notify", (s) => s.dataset.key);
check("Your devices has it, for this device", /^[\w-]{87}$/.test(siteKey) && (await ann.$eval("#notify h3", (h) => h.textContent)) === "This device");
check("…which says they're only about events and mentions", (await mainText(ann)).includes("never for other posts, comments or anything else")
  && (await mainText(ann)).includes("someone mentions you"));
check("…and it checks this device", await waitFor(async () => /off for this device|can't show/.test(await ann.$eval("#notify-status", (p) => p.textContent))),
  await ann.$eval("#notify-status", (p) => p.textContent));
// Home's one offer, in the home-screen app only (notifications.js offerOnce): not in the browser; in the app, until
// "Not now" on that device.
await ann.goto(`${A}/`);
await sleep(1500);
check("in the browser, Home doesn't offer notifications", await ann.$eval("#notify", (b) => b.hidden).catch(() => true));
const inApp = await ann.browserContext().newPage();
await inApp.evaluateOnNewDocument(() => Object.defineProperty(navigator, "standalone", { value: true }));
await inApp.goto(`${A}/`);
const offered = await waitFor(() => inApp.$eval("#notify[data-offer]", (b) => !b.hidden).catch(() => false));
check("opened from the home screen, Home offers them once", offered && (await inApp.$eval("#notify", (b) => b.textContent)).includes("invites you to an event"));
await inApp.click('#notify [data-do="later"]');
await inApp.reload();
await sleep(1500);
check("…and \"Not now\" puts it away on that device for good", await inApp.$eval("#notify", (b) => b.hidden).catch(() => true));
await inApp.close();
const device = { endpoint: `${PUSH}/push/phone`, keys: { p256dh: phone.getPublicKey().toString("base64url"), auth: phoneAuth.toString("base64url") } };
let r = await call(ann, "/_push/devices", { ...device, endpoint: "https://evil.example/push", name: "Phone" });
check("a device at something that isn't a push service is refused", r.status === 400, r.text);
r = await call(ann, "/_push/devices", { ...device, keys: { p256dh: "AAAA", auth: device.keys.auth } });
check("…and one with bad keys", r.status === 400, r.text);
r = await call(ann, "/_push/devices", { ...device, name: "Android (home screen)", preview: true });
check("a device can say yes", r.json?.on === true && (await call(ann, "/_push/devices/state", { endpoint: device.endpoint })).json?.on === true, r.text);
const cookies = (await ann.browserContext().cookies(A)).map((c) => `${c.name}=${c.value}`).join("; ");
const crossPush = await fetch(`${A}/_push/devices`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookies, "Content-Type": "application/json" },
  body: JSON.stringify({ ...device, endpoint: `${PUSH}/push/evil` }) });
check("…but another site can't add one", crossPush.status === 403, String(crossPush.status));
check("…nor can a friend's site", (await fromSam("/_push/devices", { ...device, endpoint: `${PUSH}/push/evil` })).status === 401);
await ann.goto(`${A}/_admin`);
check("Your devices lists it, without its address", (await ann.$eval("#notifying", (l) => l.textContent)).includes("Android (home screen)")
  && (await mainText(ann)).includes("Devices they're on for") && !(await ann.content()).includes(device.endpoint));
await ann.goto(`${A}/`);
check("Home says a new device has notifications on", (await mainText(ann)).includes("Notifications about events and mentions were turned on for a new device (Android (home screen))"));
await Promise.all([settled(ann), ann.$eval('form[action="/_admin/notifications/seen"] button', (b) => b.click())]);
check("…until Ann says that was her", !(await mainText(ann)).includes("were turned on for a new device"));

// --- what notifies, and what doesn't ---------------------------------------------------------------------------------------

const picnic = await samInvites("Picnic", 10);
check("Sam invites Ann to his picnic", n(stateB, `item_guests WHERE item = '${picnic}'`) === 1);
check("…which notifies Ann's device", await waitFor(() => toPhone().length === 1), String(toPhone().length));
let shown = toPhone()[0] && decrypt(toPhone()[0].body);
check("…encrypted for that device, saying who from, and what and when", shown?.title === "Sam Taylor" && shown.body.startsWith("Invited you: Picnic · ")
  && shown.body.includes("The park") && shown.url === `/friend/${samHere.id}/posts/${picnic}` && shown.tag === `event-${samHere.id}-${picnic}`, JSON.stringify(shown));
check("…with no number for the app's icon, nor anything about chats", shown && !("badge" in shown) && !("quiet" in shown));
check("…signed by Ann's site, urgent, and kept a day at most", signedBySite(toPhone()[0], siteKey) && toPhone()[0].headers.urgency === "high"
  && Number(toPhone()[0].headers.ttl) <= 86400 && toPhone()[0].headers["content-encoding"] === "aes128gcm");

// Nothing for posts or comments.
await sam.goto(`${B}/posts`);
await sam.type("#composer textarea", "A new post");
await Promise.all([sam.waitForNavigation({ timeout: 60_000 }), sam.click("#composer button.post")]);
await waitFor(() => n(stateA, "notices WHERE kind = 'post'") === 1);
await sleep(3000);
check("a friend's new post doesn't notify", toPhone().length === 1 && n(stateA, "notices WHERE kind = 'post'") === 1,
  `${toPhone().length} pushes, ${n(stateA, "notices WHERE kind = 'post'")} notices`);

// A change, then the lock screen without the details.
await samMoves(picnic, "The other park");
check("Sam changing the picnic notifies Ann", await waitFor(() => toPhone().length === 2));
shown = decrypt(toPhone()[1].body);
check("…saying it's changed, with the same tag (so it takes the invitation's place)", shown.body.startsWith("Changed: Picnic") && shown.body.includes("The other park")
  && shown.tag === `event-${samHere.id}-${picnic}`, JSON.stringify(shown));
r = await call(ann, "/_push/devices/preview", { endpoint: device.endpoint, preview: false });
await sam.goto(`${B}/posts/${picnic}`);
await Promise.all([settled(sam), sam.click('.event form[data-sign="event-cancel"] button')]);
check("with the preview off, the lock screen says only who it's from, and what kind of thing", await waitFor(() => toPhone().length === 3)
  && decrypt(toPhone()[2].body).title === "Sam Taylor" && decrypt(toPhone()[2].body).body === "Called off an event you were invited to"
  && !JSON.stringify(decrypt(toPhone()[2].body)).includes("Picnic"), r.text);
check("every notification is the same size, whatever it says", new Set(toPhone().map((p) => p.body.length)).size === 1, toPhone().map((p) => p.body.length).join());
await call(ann, "/_push/devices/preview", { endpoint: device.endpoint, preview: true });

// An event Ann said no to, and one taken back: nothing.
const quiz = await samInvites("Quiz", 12);
await waitFor(() => toPhone().length === 4);
await ann.goto(`${A}/events`);
await Promise.all([ann.waitForNavigation(), ann.click('.invitation button[value="no"]')]);
await samMoves(quiz, "The pub");
await sam.goto(`${B}/posts/${quiz}`);
await sam.$eval(".guests", (d) => { d.open = true; });
await Promise.all([settled(sam), sam.$$eval(".guest-list li", (lis) => lis.find((li) => li.textContent.includes("Ann Example")).querySelector("button").click())]);
await sleep(3000);
check("a change to an event Ann said no to doesn't notify, nor does an invitation taken back", toPhone().length === 4
  && await waitFor(() => n(stateA, `copies WHERE id = '${quiz}'`) === 0), String(toPhone().length));
// A made-up note is refused, and tells no one.
r = await fromSam("/_p/notes", { v: 2, kind: "item", item: { id: "x".repeat(43), sent: { record: "x" }, taken: 1, content: { type: "event" } } });
await sleep(2000);
check("a forged invitation is refused, and notifies nothing", r.status === 400 && toPhone().length === 4, String(r.status));

// --- push services that fail, devices that go, and new addresses ---------------------------------------------------------

await call(ann, "/_push/devices", { ...device, endpoint: `${PUSH}/push/flaky`, name: "Flaky phone" });
await call(ann, "/_push/devices", { ...device, endpoint: `${PUSH}/push/gone`, name: "Old phone" });
await samInvites("Walk", 14);
check("a push service that says \"try later\" is asked again, and gets it", await waitFor(() => pushes.some((p) => p.path === "/push/flaky")) && flaky === 2,
  `${flaky} tries`);
check("…while one that says the device is gone has it forgotten", await waitFor(() => n(stateA, "push_devices WHERE endpoint LIKE '%/push/gone'") === 0)
  && toPhone().length === 5);
r = await call(ann, "/_push/devices/renew", { old: `${PUSH}/push/flaky`, endpoint: `${PUSH}/push/flaky2`, keys: device.keys });
const renewed = sql(stateA, "SELECT endpoint, name, preview FROM push_devices WHERE name = 'Flaky phone'");
check("a device given a new address by its push service carries on there, as it was", r.json?.on === true && renewed.length === 1
  && renewed[0].endpoint === `${PUSH}/push/flaky2` && renewed[0].preview === 1, JSON.stringify(renewed));
r = await call(ann, "/_push/devices/renew", { old: `${PUSH}/push/nobody`, endpoint: `${PUSH}/push/flaky3`, keys: device.keys });
check("…but only one that's on here", r.status === 404 && n(stateA, "push_devices WHERE endpoint LIKE '%/push/flaky3'") === 0, r.text);
r = await call(ann, "/_push/devices/renew", { old: `${PUSH}/push/flaky2`, endpoint: "https://evil.example/push", keys: device.keys });
check("…and only to a push service", r.status === 400, r.text);

// --- mentions (mentions.js) ---------------------------------------------------------------------------------------------------

// A mention buzzes the phone, titled with the friend as Ann knows them, a few at most from one friend.
/** Sam posts, mentioning Ann (picked from the @ list, so it's signed into the post). */
async function samMentions(words) {
  await sam.goto(`${B}/posts`);
  await sam.type("#composer textarea", `${words} @Ann`);
  await sam.waitForSelector("#mention-list:not([hidden]) li", { timeout: 5000 });
  await sam.keyboard.press("Enter");
  await Promise.all([sam.waitForNavigation({ timeout: 60_000 }), sam.click("#composer button.post")]);
}
const base = toPhone().length;
await samMentions("Coming to the walk,");
check("a mention notifies Ann", await waitFor(() => toPhone().length === base + 1));
shown = decrypt(toPhone()[base].body);
check("…titled with the friend's name as Ann knows it", shown.title === "Sam Taylor" && shown.body.startsWith("Mentioned you: Coming to the walk")
  && shown.tag.startsWith(`mention-${samHere.id}-`), JSON.stringify(shown));
await call(ann, "/_push/devices/preview", { endpoint: device.endpoint, preview: false });
await samMentions("Still coming?");
check("…and with the preview off, nothing it said", await waitFor(() => toPhone().length === base + 2)
  && decrypt(toPhone()[base + 1].body).title === "Sam Taylor" && decrypt(toPhone()[base + 1].body).body === "Mentioned you in a post",
  JSON.stringify(decrypt(toPhone()[base + 1].body)));
await call(ann, "/_push/devices/preview", { endpoint: device.endpoint, preview: true });
for (let i = 0; i < 4; i++) await samMentions(`ping ${i}`);
await sleep(4000);
check("…five in ten minutes at most from one friend: the rest wait quietly on Notifications", toPhone().length === base + 5
  && n(stateA, "notices WHERE kind = 'mention'") === 6, `${toPhone().length - base} pushes`);

// --- turning them off --------------------------------------------------------------------------------------------------------

await ann.goto(`${A}/_admin`);
await Promise.all([ann.waitForNavigation(), ann.$eval('#notifying form[action$="/forget"] button', (b) => b.click())]);
check("a device can be turned off from Your devices", n(stateA, "push_devices") === 1);
// Ann on a second device: it turns notifications on, then signs out there, which turns them off.
const linkToken = key();
sql(stateA, `INSERT INTO device_links (token_hash, user_id, expires_at) VALUES ('${hash(linkToken)}', 1, ${Math.floor(Date.now() / 1000) + 600})`);
const laptop = await (await browser.createBrowserContext()).newPage();
const laptopCdp = await laptop.createCDPSession();
await laptopCdp.send("WebAuthn.enable");
await laptopCdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
  hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await laptop.goto(`${A}/_auth/device/${linkToken}`);
await Promise.all([laptop.waitForNavigation(), laptop.click("#go")]);
await call(laptop, "/_push/devices", { ...device, endpoint: `${PUSH}/push/laptop`, name: "Mac (browser)" });
const before = n(stateA, "push_devices WHERE endpoint LIKE '%/push/laptop'");
await laptop.evaluate(() => fetch("/_auth/logout", { method: "POST" }));
check("signing out on a device turns its notifications off", before === 1 && n(stateA, "push_devices WHERE endpoint LIKE '%/push/laptop'") === 0, String(before));
const left = sql(stateA, "SELECT endpoint FROM push_devices")[0]?.endpoint;
r = await call(ann, "/_push/devices/forget", { endpoint: left });
check("…and a device can say no itself", r.json?.on === false && n(stateA, "push_devices") === 0);
pushService.close();

// --- Download everything ---------------------------------------------------------------------------------------------------

r = await call(ann, "/_admin/export/rows?table=settings");
check("Download everything leaves out the site's notification key", r.status === 200 && !/push_vapid|privateJwk/.test(r.text));
check("…and anything about devices", (await call(ann, "/_admin/export/rows?table=push_devices")).status === 400);
check("…and has no chats or messages to give", (await call(ann, "/_admin/export/rows?table=messages")).status === 400
  && (await call(ann, "/_admin/export/rows?table=chats")).status === 400);

// --- Add to home screen: a note on Home until it's installed or put off, the menu, and how to ---------------------------------

await sam.goto(`${B}/`);
check("every page links the app's manifest", (await sam.$eval('link[rel="manifest"]', (l) => l.href)) === `${B}/static/app/manifest.webmanifest`);
check("Home suggests adding afterwrd to the home screen", await waitFor(() => sam.$eval("#install-note", (n) => !n.hidden)));
check("…saying what it's for", (await sam.$eval("#install-note", (n) => n.textContent)).includes("invites you to an event"));
check("…as does the menu", (await sam.$('header.site .menu a[href="/app"]')) !== null);
check("…and the service worker is ready for it", await waitFor(() => sam.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration("/")))));
await sam.$eval("#install-note [data-install-later]", (b) => b.click());
await sam.reload();
check("\"Not now\" puts it away for good on this device", await sam.$eval("#install-note", (n) => n.hidden));
await sam.goto(`${B}/app`);
check("the Add to home screen page says how, for Android and iPhone", /Install app/.test(await mainText(sam)) && /Add to Home Screen/.test(await mainText(sam)));
check("…and points to Your devices for notifications", (await sam.$('main a[href="/_admin#notifications"]')) !== null && !(await mainText(sam)).includes("message"));
// What shows depends on the device: only its own steps, with the rest a tap away.
const visible = (page) => page.$eval("main", (m) => m.innerText);
let steps = await visible(sam);
check("…a computer sees only a computer's steps", /right-hand end of the address bar/.test(steps) && !/Install app/.test(steps) && !/Add to Home Screen/.test(steps));
await sam.$eval("[data-show-devices]", (b) => b.click());
steps = await visible(sam);
check("…and the others when asked", /Install app/.test(steps) && /Add to Home Screen/.test(steps) && !/open this page in Safari first/.test(steps));
const desktop = await browser.userAgent();
await sam.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1");
await sam.goto(`${B}/app`);
steps = await visible(sam);
check("an iPhone in Safari sees Safari's steps: ⋯, Share, Add to Home Screen", /⋯/.test(steps) && /Add to Home Screen/.test(steps)
  && /Open as Web App/.test(steps) && !/Install app/.test(steps) && !/open this page in Safari first/.test(steps));
await sam.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1");
await sam.goto(`${B}/app`);
steps = await visible(sam);
check("an iPhone in Chrome is told to open the page in Safari first", /open this page in Safari first/.test(steps) && /Add to Home Screen/.test(steps));
await sam.setUserAgent(desktop);
const manifest = await (await fetch(`${B}/static/app/manifest.webmanifest`)).json();
check("the app opens on Home, full screen", manifest.start_url === "/" && manifest.display === "standalone");

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
