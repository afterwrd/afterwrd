// Personal events (src/events.js, docs/events-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and
// a group's Worker (G, 8790). Ann is friends with Bob and with Cat. Ann makes an event and invites Bob: only Bob sees
// it, by any route, until she invites Cat too. They answer from their own sites, see who's going, and hear about changes
// unless they said no. Ann takes an invitation back, calls it off, deletes it. Everyone's Events page shows a month's
// calendar of their own, friends' and groups' events. Bob has notifications on (a stand-in push service on 8795, which
// only counts: notifications.mjs looks inside them): his phone hears of each invitation and change, and nothing else.
//   node events.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count as n, letInto, settled, siteSql as sql, setUpSigning, startSignedGroup } from "./helpers.mjs";
import { signCall } from "../../src/signedcalls.js";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateTimezone("Europe/London");
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (m.text().includes("Content Security Policy")) errors.push(`${site}: ${m.text()}`); }); // blocked by the page's policy
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
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
const text = (page, selector = "main") => page.$eval(selector, (m) => m.innerText).catch(() => "");
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });

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

/** Fills in an event form (the one inside `form`): a title, a day (YYYY-MM-DD), and optionally a time, place and words. */
async function fill(page, form, { title, day, time = "", place = "", words = "" }) {
  await page.$eval(`${form} input[name=title]`, (i, v) => { i.value = v; }, title);
  await page.$eval(`${form} input[name=start_date]`, (i, v) => { i.value = v; }, day);
  await page.$eval(`${form} input[name=start_time]`, (i, v) => { i.value = v; }, time);
  await page.$eval(`${form} input[name=place]`, (i, v) => { i.value = v; }, place);
  await page.$eval(`${form} textarea[name=text]`, (i, v) => { i.value = v; }, words);
}
/** Ticks the friends named in the guest picker inside `form`. */
async function tick(page, form, names) {
  for (const name of names) {
    await page.$$eval(`${form} .guest-options label`, (labels, who) => labels.find((l) => l.textContent.trim() === who)?.querySelector("input").click(), name);
  }
}
/** What an event block on the page says: its title, its lines, and the names in its lists. */
const eventIn = (page, scope = "main") => page.$eval(`${scope} .event`, (e) => ({
  title: e.querySelector(".event-title")?.textContent, meta: [...e.querySelectorAll(".event-what .meta")].map((m) => m.textContent).join(" | "),
  answered: e.querySelector(".answered")?.innerText ?? "", pressed: e.querySelector(".answers [aria-pressed=true]")?.value ?? null,
  answers: e.querySelectorAll(".answers button").length, off: e.classList.contains("cancelled"),
})).catch(() => null);

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2);
const bobId = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
const catId = sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id;
const annOnBob = sql(stateB, "SELECT id FROM connections")[0].id;
const annOnCat = sql(stateC, "SELECT id FROM connections")[0].id;
const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};

// Bob's phone, with notifications on. What reaches it is counted.
const bobPhone = [];
const pushService = createServer((req, res) => { req.resume(); req.on("end", () => { bobPhone.push(req.url); res.writeHead(201).end(); }); }).listen(8795);
const phoneKeys = createECDH("prime256v1");
phoneKeys.generateKeys();
const bobDevice = await post(bob, "/_push/devices", { endpoint: "http://localhost:8795/push/bob", name: "Android (home screen)",
  keys: { p256dh: phoneKeys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
check("Bob turns on notifications on his phone", bobDevice.on === true, JSON.stringify(bobDevice));
/** Whether Bob's phone was told one thing more than `before`, by now (and nothing more, after a moment). */
async function phoneTold(before) {
  if (!(await waitFor(() => bobPhone.length > before))) return false;
  await new Promise((r) => setTimeout(r, 1000));
  return bobPhone.length === before + 1;
}

// An ordinary post first, which everyone sees, so the lists below aren't empty.
await ann.goto(`${A}/posts`);
await ann.type("#composer textarea", "Hello, everyone.");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);

// Signed calls as a friend's own site would make them (its hosting key), to see what Ann's site gives each.
const personOf = (state) => sql(state, "SELECT person FROM own_identity")[0].person;
const hostingOf = async (state) => crypto.subtle.importKey("pkcs8", Buffer.from(sql(state, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
  { name: "Ed25519" }, false, ["sign"]);
const asSite = async (state, from, to, path, body = null) => {
  const url = to + path;
  const text = body === null ? null : JSON.stringify(body);
  const headers = await signCall({ method: text === null ? "GET" : "POST", url, body: text, person: personOf(state), from, privateKey: await hostingOf(state) });
  const res = await fetch(url, { method: text === null ? "GET" : "POST", headers: { ...headers, ...(text !== null && { "Content-Type": "application/json" }) }, body: text });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const asCat = (path, body) => asSite(stateC, C, A, path, body);
const asBob = (path, body) => asSite(stateB, B, A, path, body);
const tallyOf = (id) => JSON.parse(sql(stateA, `SELECT tally FROM items WHERE id = '${id}'`)[0]?.tally ?? "null");
const answerOf = (id, state) => tallyOf(id)?.answers?.[personOf(state)]?.answer ?? null;
const copyOf = (state, id) => sql(state, `SELECT content, tally FROM copies WHERE id = '${id}'`)[0];

// --- making one -------------------------------------------------------------------------------------------------------

const ahead = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const picnicDay = ahead(10);
const picnicMonth = picnicDay.slice(0, 7);
await ann.goto(`${A}/events`);
check("Events is in the menu", Boolean(await ann.$('nav.main a[href="/events"][aria-current="page"]')));
check("…with a calendar of the month and a form to make an event", Boolean(await ann.$(".calendar .cal-grid")) && Boolean(await ann.$("#make form")));
check("the form lists friends to invite", (await ann.$$eval("#make .guest-options label", (l) => l.map((x) => x.textContent.trim()))).join() === "Bob Example,Cat Example");
await ann.$eval("#make", (d) => { d.open = true; });
// On a phone: each tick box is small and just left of its name; a field's name and "(optional)" share a line.
await ann.setViewport({ width: 390, height: 844 });
const layout = await ann.evaluate(() => {
  const label = document.querySelector("#make .guest-options label");
  const [box, name] = [label.querySelector("input").getBoundingClientRect(), label.querySelector("span").getBoundingClientRect()];
  const field = [...document.querySelectorAll("#make .event-form label .field")].find((f) => f.textContent.startsWith("Where"));
  const meta = field.querySelector(".meta").getBoundingClientRect();
  return { boxWidth: box.width, gap: name.left - box.right, leftOfLabel: box.left - label.getBoundingClientRect().left,
    sameLine: Math.abs(meta.top - field.getBoundingClientRect().top) < 4, textarea: document.querySelector("#make textarea").getBoundingClientRect().height };
});
check("the form lines up on a phone", layout.boxWidth < 30 && layout.gap >= 0 && layout.gap < 20 && layout.leftOfLabel < 4 && layout.sameLine
  && layout.textarea > 70, JSON.stringify(layout));
await ann.$eval("#make .event-form input[name=place]", (i) => i.scrollIntoView());
await ann.screenshot({ path: `${OUT}/events-form-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 800 });
await fill(ann, "#make", { title: "Picnic", day: picnicDay, time: "13:00", place: "The park", words: "Bring a blanket." });
await tick(ann, "#make", ["Bob Example"]);
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#make button.primary")]);
const key = new URL(ann.url()).pathname.split("/").pop();
check("making it opens its page", /^[A-Za-z0-9_-]{43}$/.test(key), ann.url());
check("…a signed item for those invited only, with who's invited", sql(stateA, `SELECT audience FROM items WHERE id = '${key}'`)[0]?.audience === "invited"
  && sql(stateA, `SELECT connection_id FROM item_guests WHERE item = '${key}'`).map((r) => r.connection_id).join() === String(bobId)
  && !sql(stateA, `SELECT entries FROM list_pages WHERE list = '${key}'`)[0].entries.includes(personOf(stateB)));
let annEvent = await eventIn(ann);
check("Ann's page shows her event, as hers, with no answer buttons", annEvent?.title === "Picnic" && annEvent.meta.includes("The park")
  && annEvent.meta.includes("1 invited") && annEvent.meta.includes("Only the people you invite") && annEvent.answers === 0, JSON.stringify(annEvent));
check("…and who's invited, not answered yet", (await text(ann, ".guests")).includes("Bob Example") && (await text(ann, ".guests")).includes("Not answered yet"));
check("…and the words about it", (await text(ann, "article.own .text")).includes("Bring a blanket."));
check("its words change with the event, not the 15-minute edit", !(await ann.$('article.own header a[href^="#edit-i-"]')));

// --- Bob is invited -----------------------------------------------------------------------------------------------------

check("Bob's site is told he's invited", await waitFor(() => n(stateB, "notices WHERE kind = 'invite'") === 1));
check("…and so is his phone (and nothing before: not Ann's post)", await phoneTold(0), String(bobPhone.length));
check("…and Ann's site notes that the invitation got there", await waitFor(() =>
  sql(stateA, `SELECT delivery FROM item_guests WHERE connection_id = ${bobId}`)[0]?.delivery === "delivered"));
check("…and keeps a copy for his calendar, not answered yet", JSON.parse(copyOf(stateB, key)?.content ?? "{}").event?.title === "Picnic"
  && !JSON.parse(copyOf(stateB, key).tally ?? "{}").answers?.[personOf(stateB)]);
await bob.goto(`${B}/activity`);
check("Bob's Notifications say Ann invited him", (await text(bob)).includes("Ann Example invited you to an event")
  && Boolean(await bob.$(`main a[href="/friend/${annOnBob}/posts/${key}"]`)));
await bob.goto(`${B}/events`);
check("Bob's Events page lists the invitation", (await text(bob, ".invitations")).includes("Picnic") && (await text(bob, ".invitations")).includes("Ann Example invited you"));

// --- Cat isn't: nothing reaches her, by any route -----------------------------------------------------------------------

const forCat = await asCat("/_p/items?since=0");
check("what Ann's site sends Cat's leaves the event out", forCat.status === 200 && !JSON.stringify(forCat.data).includes(key)
  && !JSON.stringify(forCat.data).includes("Picnic") && forCat.data.items.length === 1, JSON.stringify(forCat.data).slice(0, 200));
check("…and asking for it by its id", (await asCat(`/_p/items/${key}`)).status === 404);
check("…or passing on a comment on it", (await asCat("/_p/records", { sent: { record: "x" } })).status === 400
  && (await asBob(`/_p/items/${key}`)).status === 200);
check("Cat's site was told nothing", await waitFor(() => n(stateC, "copies") === 1) && n(stateC, "notices WHERE kind != 'post'") === 0,
  JSON.stringify(sql(stateC, "SELECT kind FROM notices")));
await cat.goto(`${C}/`);
check("…and her Home doesn't show it", !(await text(cat)).includes("Picnic") && (await text(cat)).includes("Hello, everyone."));
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
check("…nor its address on her site", !(await text(cat)).includes("Picnic"));
check("Bob's copy has it, with the event", (await asBob("/_p/items?since=0")).data.items.some((i) => i.id === key && i.content.event.title === "Picnic"));

// --- Bob answers ----------------------------------------------------------------------------------------------------------

await bob.goto(`${B}/events`);
await Promise.all([bob.waitForNavigation(), bob.click('.invitation button[value="going"]')]);
check("Bob says he's going, from Events, in a signed answer", answerOf(key, stateB) === "going");
check("…his copy says so, and the invitation's answered", JSON.parse(copyOf(stateB, key).tally).answers[personOf(stateB)].answer === "going" && !(await bob.$(".invitations")));
await bob.goto(`${B}/events?month=${picnicMonth}`);
const cell = await bob.$$eval(".cal-day", (cells) => cells.filter((c) => c.querySelector(".cal-event")).map((c) => ({
  day: c.querySelector(".cal-num").textContent.trim(), events: [...c.querySelectorAll(".cal-event")].map((e) => e.className + ":" + e.textContent.trim()) })));
check("…and it's on his calendar, on its day, as a friend's", cell.length === 1 && cell[0].day === String(Number(picnicDay.slice(8)))
  && /cal-friend/.test(cell[0].events[0]) && cell[0].events[0].includes("13:00") && cell[0].events[0].includes("Picnic"), JSON.stringify(cell));
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
let bobEvent = await eventIn(bob);
check("Bob's page for it shows his answer, who's going, and who can see it", bobEvent?.pressed === "going" && /Going\s+You/.test(bobEvent.answered)
  && bobEvent.meta.includes("Only the people Ann Example invited"), JSON.stringify(bobEvent));
await Promise.all([settled(bob), bob.click('.event .answers button[value="maybe"]')]);
check("…he can change his mind there, in place", answerOf(key, stateB) === "maybe" && (await eventIn(bob))?.pressed === "maybe");
await openThread(bob, `#fi${annOnBob}-${key}`);
await bob.type(`#fi${annOnBob}-${key} form.say textarea`, "Can't wait!");
await Promise.all([settled(bob), bob.click(`#fi${annOnBob}-${key} form.say button`)]);
check("Bob comments on it; Ann's site keeps it", sql(stateA, `SELECT comments FROM items WHERE id = '${key}'`)[0].comments === 1);
const ics = await bob.evaluate((p) => fetch(p).then(async (r) => [r.headers.get("content-type"), await r.text()]), `/friend/${annOnBob}/posts/${key}/event.ics`);
check("…and can add it to his own calendar", ics[0]?.startsWith("text/calendar") && ics[1].includes("SUMMARY:Picnic") && ics[1].includes("LOCATION:The park"));
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
await Promise.all([settled(bob), bob.click('.event .answers button[value="going"]')]);

await ann.goto(`${A}/posts/${key}`);
annEvent = await eventIn(ann);
check("Ann sees Bob's going", /Going\s+Bob Example/.test(annEvent?.answered ?? ""), JSON.stringify(annEvent));

// A friend whose site can't take signed invitations refuses it: Ann sees why.
sql(stateA, "INSERT INTO connections (id, origin, name, created_at, connected_at, approved_at) VALUES (999, 'https://old.example', 'Old Friend', 1, 1, 1)");
sql(stateA, `INSERT INTO item_guests (item, connection_id, person, added_at, delivery) VALUES ('${key}', 999, '${"o".repeat(43)}', 1, 'refused')`);
await ann.goto(`${A}/posts/${key}`);
check("an invitation a site didn't take says so on Ann's guest list", (await text(ann, ".guests")).includes("Their site didn't take the invitation: it may need updating"));
sql(stateA, "DELETE FROM item_guests WHERE connection_id = 999");
sql(stateA, "DELETE FROM connections WHERE id = 999");

// --- inviting Cat too ------------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}`);
check("only Cat's left to invite", (await ann.$$eval(".invite-more .guest-options label", (l) => l.map((x) => x.textContent.trim()))).join() === "Cat Example");
await tick(ann, ".invite-more", ["Cat Example"]);
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click(".invite-more button.primary")]);
check("Ann invites Cat too, in a signed change", n(stateA, `item_guests WHERE item = '${key}'`) === 2);
check("Cat's site is told", await waitFor(() => n(stateC, "notices WHERE kind = 'invite'") === 1));
check("…and Bob's isn't told again", n(stateB, "notices WHERE kind = 'invite'") === 1);
check("now Cat can read it", (await asCat(`/_p/items/${key}`)).status === 200);
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
await Promise.all([settled(cat), cat.click('.event .answers button[value="maybe"]')]);
check("Cat might go", answerOf(key, stateC) === "maybe");
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
bobEvent = await eventIn(bob);
check("everyone invited sees who's going and who might, by name", /Going\s+You/.test(bobEvent.answered) && /Maybe\s+Cat Example/.test(bobEvent.answered)
  && bobEvent.meta.includes("2 invited"), JSON.stringify(bobEvent));
await cat.goto(`${C}/friend/${annOnCat}/posts/${key}`);
await Promise.all([settled(cat), cat.click('.event .answers button[value="no"]')]);
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
bobEvent = await eventIn(bob);
check("…and who can't go (decision 15)", /Can't go\s+Cat Example/.test(bobEvent.answered), JSON.stringify(bobEvent));
await ann.goto(`${A}/posts/${key}`);
check("…as Ann does", /Can't go\s+Cat Example/.test((await eventIn(ann)).answered));
await cat.goto(`${C}/events?month=${picnicMonth}`);
check("an event Cat can't go to isn't on her calendar", !(await text(cat, ".calendar")).includes("Picnic"));

// --- changing it -----------------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}/event`);
check("Ann's change form is filled in", (await ann.$eval("input[name=title]", (i) => i.value)) === "Picnic" && (await ann.$eval("input[name=start_time]", (i) => i.value)) === "13:00");
await ann.$eval("input[name=start_time]", (i) => { i.value = "14:00"; });
let phoneBefore = bobPhone.length;
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click(".event-form button.primary")]);
check("Ann moves it an hour later, in a signed change", (await eventIn(ann))?.meta.includes("14:00"));
check("Bob, going, is told", await waitFor(() => n(stateB, "notices WHERE kind = 'changed'") === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…and his copy moves with it", JSON.parse(copyOf(stateB, key).content).event.starts_at
  === JSON.parse(sql(stateA, `SELECT content FROM items WHERE id = '${key}'`)[0].content).event.starts_at);
check("Cat, who said no, isn't", n(stateC, "notices WHERE kind = 'changed'") === 0);
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
check("Bob's going was said before it moved, and says so", /Going\s+You \(said before it changed\)/.test((await eventIn(bob)).answered), (await eventIn(bob)).answered);
await Promise.all([settled(bob), bob.click('.event .answers button[value="going"]')]);
check("…until he says it again", answerOf(key, stateB) === "going" && !/You \(said before/.test((await eventIn(bob)).answered));
await ann.goto(`${A}/posts/${key}/event`);
await ann.$eval("input[name=place]", (i) => { i.value = "The other park"; });
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click(".event-form button.primary")]);
check("another change straight away is refused", (await text(ann)).includes("You've just changed this event"));
await ann.goto(`${A}/posts/${key}/event`);
await ann.$eval("textarea[name=text]", (i) => { i.value = "Bring a blanket, and a flask."; });
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click(".event-form button.primary")]);
check("…but changing only its words is fine, and tells no one", (await text(ann, "article.own .text")).includes("a flask")
  && n(stateB, "notices WHERE kind = 'changed'") === 1 && bobPhone.length === phoneBefore + 1);
check("…while Bob's copy has the new words", await waitFor(() => JSON.parse(copyOf(stateB, key).content).text.includes("a flask")));

// --- forged notes and answers ------------------------------------------------------------------------------------------------

const toBob = (body) => asSite(stateA, A, B, "/_p/notes", body);
const bobSent = sql(stateB, "SELECT record FROM sent WHERE kind = 'answer' LIMIT 1")[0];
check("a note passing off someone else's record as Ann's post is refused", (await toBob({ v: 2, kind: "item",
  item: { id: "x".repeat(43), sent: JSON.parse(bobSent.record), taken: 1, content: { type: "event" } } })).status === 400);
const annEntry = JSON.parse(sql(stateA, `SELECT entries FROM list_pages WHERE list = '${key}' ORDER BY page DESC LIMIT 1`)[0].entries).at(-1);
check("…as is a change whose receipt doesn't check", (await toBob({ v: 2, kind: "change", item: key,
  entry: { n: annEntry.n, fp: annEntry.fp, taken: annEntry.taken, prev: "", sent: annEntry.sent }, receipt: { bytes: "e30", sig: "x" } })).status === 400);
// What Cat's browser could sign: Ann's site refuses answers that aren't one of the three, to old versions, or past
// her allowance on one item (20 entries each: lists.js PER_AUTHOR).
const signAnswer = (page, path, answer, { version = null } = {}) => page.evaluate(async (path, answer, version) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const doc = new DOMParser().parseFromString(await (await fetch(path)).text(), "text/html");
  // Once it's off there are no answer buttons: the comment box says where its list is up to instead.
  const form = doc.querySelector("form.answers") ?? doc.querySelector("form.say");
  const d = form.dataset;
  const key = await savedKey();
  const made = await makeRecord({ kind: "answer", author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null, version: version ?? d.signVersion ?? d.signItem }, { answer }, key);
  const res = await fetch(form.getAttribute("action"), { method: "POST", body: new URLSearchParams({ sent: JSON.stringify(made.sent), back: path }), redirect: "manual" });
  return res.type === "opaqueredirect" ? 303 : res.status;
}, path, answer, version);
const catsPage = `/friend/${annOnCat}/posts/${key}`;
check("Cat's answers must be one of the three", (await signAnswer(cat, catsPage, "perhaps")) === 400);
check("…and to the event as it is now", (await signAnswer(cat, catsPage, "going", { version: key })) === 400);
const flips = [];
for (let i = 0; i < 24 && !flips.includes(400); i++) flips.push(await signAnswer(cat, catsPage, i % 2 ? "no" : "maybe"));
const keptAnswer = answerOf(key, stateC);
check("answering again and again runs out (20 entries each)", flips.includes(400) && flips.indexOf(400) <= 20, flips.join(","));
check("…and an answer over the limit changes nothing", keptAnswer === (flips.indexOf(400) % 2 ? "maybe" : "no"), keptAnswer);

// --- taking an invitation back --------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}`);
await ann.$eval(".guests", (d) => { d.open = true; });
await Promise.all([settled(ann), ann.$$eval(".guest-list li", (lis) => lis.find((li) => li.textContent.includes("Cat Example")).querySelector("button").click())]);
check("Ann takes back Cat's invitation", n(stateA, `item_guests WHERE connection_id = ${catId}`) === 0 && answerOf(key, stateC) === null);
check("Cat's site forgets it, and its notification, quietly", await waitFor(() => n(stateC, `copies WHERE id = '${key}'`) === 0 && n(stateC, "notices WHERE kind = 'invite'") === 0));
check("…and Cat can't read it any more", (await asCat(`/_p/items/${key}`)).status === 404);
check("…and is told, when next her site asks, that she may no longer see it", (await asCat("/_p/items?since=0")).data.gone.includes(key)
  && !(await asBob("/_p/items?since=0")).data.gone.includes(key));

// --- a group's events on the calendar too (signed: docs/signed-conversations.md, step 6) -------------------------------------------

const annGroup = await startSignedGroup(ann, { origin: G, setup: GROUP_KEY, name: "Walkers" });
const groupPerson = sql(stateG, "SELECT person FROM own_identity")[0].person;
const groupItem = (title) => sql(stateG, "SELECT id, content, tally FROM items WHERE type = 'post'").find((r) => JSON.parse(r.content).event?.title === title);
await ann.goto(`${A}/groups/${annGroup}/calendar?month=${picnicMonth}`);
check("a group's calendar is a month grid too", Boolean(await ann.$(".calendar .cal-grid")));
await ann.$eval("details.add-event", (d) => { d.open = true; });
await fill(ann, "details.add-event", { title: "Hill walk", day: ahead(12), time: "09:30" });
await Promise.all([ann.waitForNavigation(), ann.click("details.add-event button.primary")]);
check("…and adding one there signs it, for the group to host", Boolean(groupItem("Hill walk")));
await ann.goto(`${A}/groups/${annGroup}/calendar?month=${ahead(12).slice(0, 7)}`);
check("…with the group's event on its day", (await text(ann, ".calendar")).includes("Hill walk"));
await ann.goto(`${A}/events?month=${picnicMonth}`);
const annCal = await ann.$$eval(".cal-event", (es) => es.map((e) => e.className + ":" + e.textContent.trim()));
const sameMonth = ahead(12).slice(0, 7) === picnicMonth;
check("Ann's Events calendar has her own event and her group's", annCal.some((e) => /cal-own/.test(e) && e.includes("Picnic"))
  && (!sameMonth || annCal.some((e) => /cal-group/.test(e) && e.includes("Hill walk"))), JSON.stringify(annCal));
await ann.goto(`${A}/events?month=${picnicMonth}&day=${picnicDay}`);
check("choosing a day lists that day's events", (await text(ann, ".cal-list")).includes("Picnic") && !(await text(ann, ".cal-list")).includes("Hill walk")
  && Boolean(await ann.$(".cal-day.chosen")));
await ann.goto(`${A}/groups`);
check("Groups points to Events instead of its own Coming up", !(await ann.$(".coming-up")) && Boolean(await ann.$('main a[href="/events"]')));
// Week and list views.
await ann.goto(`${A}/events?view=week&week=${picnicDay}`);
check("the Week view shows that week, day by day", (await text(ann, ".cal-week")).includes("Picnic")
  && (await ann.$$(".cal-week-day")).length === 7 && Boolean(await ann.$('.cal-views a[aria-current="page"][href="/events?view=week"]')));
await ann.goto(`${A}/events?view=list`);
check("the List view shows everything coming up", (await text(ann, ".cal-upcoming")).includes("Picnic") && (await text(ann, ".cal-upcoming")).includes("Hill walk"));

// --- repeating events, in a group (step 6d: a list per date) --------------------------------------------------------------------------

const bobGroup = await letInto(ann, A, annGroup, bob, B, stateB);
check("Bob joins Ann's group", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 2);

const clubDays = [14, 21, 28, 35].map(ahead);
await ann.goto(`${A}/groups/${annGroup}/calendar`);
await ann.$eval("details.add-event", (d) => { d.open = true; });
await fill(ann, "details.add-event", { title: "Book club", day: clubDays[0], time: "19:00", place: "The library" });
await ann.$eval("details.add-event input[name=start_date]", (i) => i.dispatchEvent(new Event("change")));
const choices = await ann.$$eval("details.add-event select[name=repeat] option:not([hidden])", (o) => o.map((x) => x.textContent));
check("the form offers ways to repeat, naming the day", choices[0] === "Doesn't repeat" && /^Every week on \w+day$/.test(choices[1]) && choices.length >= 4, JSON.stringify(choices));
await ann.select("details.add-event select[name=repeat]", "weekly");
await ann.$eval("details.add-event input[name=repeat_until]", (i, v) => { i.value = v; }, clubDays[3]);
const invalid = await ann.$eval("details.add-event form", (f) => [...f.elements].filter((el) => el.willValidate && !el.checkValidity())
  .map((el) => `${el.name}: ${el.validationMessage}`).join("; "));
check("the repeating event's form is complete", !invalid, invalid);
// Sent as its button would (a click can land on the sticky header when the long form scrolls under it).
await Promise.all([ann.waitForNavigation(), ann.$eval("details.add-event form", (f) => f.requestSubmit(f.querySelector("button.primary")))]);
const club = groupItem("Book club");
const clubEvent = () => JSON.parse(groupItem("Book club").content).event;
const clubTally = () => JSON.parse(groupItem("Book club").tally ?? "{}");
check("Ann adds a weekly event, its rule signed into her post", clubEvent()?.rrule === `FREQ=WEEKLY;UNTIL=${clubDays[3].replace(/-/g, "")}`, JSON.stringify(club));

await bob.goto(`${B}/groups/${bobGroup}/posts/${club.id}`);
check("Bob sees how it repeats, and every date", (await text(bob, ".event")).includes("Every week on") && (await bob.$$(".event-dates li")).length === 4);
await Promise.all([settled(bob), bob.click(`#d-${clubDays[1]} .answers button[value="going"]`)]);
check("Bob says he's going to the second date only", clubTally().dates?.[clubDays[1]]?.answers && Object.keys(clubTally().dates).join() === clubDays[1]);
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.id}?date=${clubDays[1]}`);
check("…and its guest list names him there, and not on the others", /Going\s+You/.test(await text(bob, `#d-${clubDays[1]}`))
  && !(await text(bob, `#d-${clubDays[2]}`)).includes("You"));
const ics2 = await bob.evaluate((p) => fetch(p).then((r) => r.text()), `/groups/${bobGroup}/posts/${club.id}/event.ics`);
// Each later date's moment (RDATE): a rule from a start in UTC would drift by an hour when the clocks change.
const rdates = (ics) => (/^RDATE:(.*)$/m.exec(ics.replace(/\r\n /g, ""))?.[1] ?? "").split(",").filter(Boolean);
check("its calendar file lists every date", rdates(ics2).length === 3 && !/RRULE/.test(ics2), ics2.slice(0, 400));
await bob.goto(`${B}/events?view=list`);
const listed = await bob.$$eval(".cal-upcoming .plan-list li", (l) => l.map((x) => x.innerText.replace(/\s+/g, " ")).filter((t) => t.includes("Book club")));
check("Bob's List shows each date, marked going or not", listed.length === 4 && listed.filter((t) => t.includes("You're going")).length === 1, JSON.stringify(listed));

// Calling off one date.
phoneBefore = bobPhone.length;
check("nothing since reached Bob's phone: not forged notes, answers, comments, or a group's new event", phoneBefore === 2, String(phoneBefore));
await ann.goto(`${A}/groups/${annGroup}/posts/${club.id}`);
await Promise.all([settled(ann), ann.click(`#d-${clubDays[1]} .call-off-date button`)]);
check("Ann calls off the second date", clubTally().dates?.[clubDays[1]]?.off && !clubEvent().cancelled);
check("Bob, going that day, is told", await waitFor(() => n(stateB, `notices WHERE kind = 'cancelled' AND target LIKE '%?date=${clubDays[1]}'`) === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…his copy of the event has that date off", JSON.parse(sql(stateB, `SELECT content FROM copies WHERE id = '${club.id}'`)[0].content).event.skipped?.includes(clubDays[1]));
await bob.goto(`${B}/activity`);
check("…and Notifications say one date's off", (await text(bob)).includes("called off one date of an event you're going to"));
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.id}`);
check("the other dates go on, and the one that's off takes no answers", (await bob.$$(".event-dates li.off")).length === 1
  && Boolean(await bob.$(`#d-${clubDays[2]} .answers`)) && !(await bob.$(`#d-${clubDays[1]} .answers`)));
const icsOff = await bob.evaluate((p) => fetch(p).then((r) => r.text()), `/groups/${bobGroup}/posts/${club.id}/event.ics`);
check("…and the calendar file leaves it out", rdates(icsOff).join() === rdates(ics2).slice(1).join(), icsOff.slice(0, 400));

// Changing the time moves every date, and Bob's copy with it.
await Promise.all([settled(bob), bob.click(`#d-${clubDays[2]} .answers button[value="maybe"]`)]);
await ann.goto(`${A}/groups/${annGroup}/posts/${club.id}/edit`);
check("the change form keeps how it repeats", (await ann.$eval("select[name=repeat]", (el) => el.value)) === "weekly"
  && (await ann.$eval("input[name=repeat_until]", (i) => i.value)) === clubDays[3]);
await ann.$eval("input[name=start_time]", (i) => { i.value = "19:30"; });
phoneBefore = bobPhone.length;
await Promise.all([ann.waitForNavigation(), ann.click(".event-form button.primary")]);
check("Bob, who might go, is told it changed", await waitFor(() => n(stateB, "notices WHERE kind = 'changed' AND group_id IS NOT NULL") >= 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
const londonTime = (t) => new Date(t * 1000).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
check("…and his copy moves to 19:30", londonTime(JSON.parse(sql(stateB, `SELECT content FROM copies WHERE id = '${club.id}'`)[0].content).event.starts_at) === "19:30");
// Calling off one date at a time is limited to a few a day per event (each tells everyone going that day).
const real = groupItem("Book club").tally;
const busy = JSON.parse(real);
const nowS = Math.floor(Date.now() / 1000);
for (let i = 1; i <= 9; i++) busy.dates[`2000-01-0${i}`] = { answers: {}, off: { by: groupPerson, at: nowS }, list: null };
sql(stateG, `UPDATE items SET tally = '${JSON.stringify(busy).replace(/'/g, "''")}' WHERE id = '${club.id}'`);
await ann.goto(`${A}/groups/${annGroup}/posts/${club.id}`);
await Promise.all([settled(ann), ann.click(`#d-${clubDays[3]} .call-off-date button`)]);
check("calling off an eleventh date in a day is refused", !JSON.parse(groupItem("Book club").tally).dates?.[clubDays[3]]?.off);
sql(stateG, `UPDATE items SET tally = '${real.replace(/'/g, "''")}' WHERE id = '${club.id}'`);
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/groups/${bobGroup}/posts/${club.id}`);
await bob.screenshot({ path: `${OUT}/events-repeating-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });

await ann.setViewport({ width: 1280, height: 900 });
await ann.goto(`${A}/events?month=${picnicMonth}`);
await ann.screenshot({ path: `${OUT}/events-calendar.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/events?month=${picnicMonth}`);
check("on a phone, days show dots instead of titles", await bob.$eval(".cal-day .cal-dots", (d) => getComputedStyle(d).display !== "none")
  && await bob.$eval(".cal-events", (d) => getComputedStyle(d).display === "none"));
check("…and the page doesn't scroll sideways", await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await bob.screenshot({ path: `${OUT}/events-calendar-phone.png`, fullPage: true });
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
await bob.screenshot({ path: `${OUT}/events-invited-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });

// --- calling it off, and deleting ------------------------------------------------------------------------------------------------

await ann.goto(`${A}/posts/${key}`);
phoneBefore = bobPhone.length;
await Promise.all([settled(ann), ann.click('.event form[data-sign="event-cancel"] button')]);
check("Ann calls it off, in a signed change", JSON.parse(sql(stateA, `SELECT content FROM items WHERE id = '${key}'`)[0].content).event.cancelled === true
  && (await eventIn(ann))?.off);
check("Bob is told", await waitFor(() => n(stateB, "notices WHERE kind = 'cancelled' AND connection_id IS NOT NULL") === 1));
check("…on his phone too", await phoneTold(phoneBefore), String(bobPhone.length));
check("…his copy says so", JSON.parse(copyOf(stateB, key).content).event.cancelled === true);
await bob.goto(`${B}/friend/${annOnBob}/posts/${key}`);
check("…and answers aren't offered, or taken, any more", !(await bob.$(".event .answers"))
  && (await signAnswer(bob, `/friend/${annOnBob}/posts/${key}`, "no", { version: JSON.parse(copyOf(stateB, key).content).version })) === 400);
await bob.goto(`${B}/activity`);
check("Bob's Notifications say it's off", (await text(bob)).includes("Ann Example called off an event you were invited to"));

// Another, deleted while still to come: those invited are told it's off.
await ann.goto(`${A}/events`);
await ann.$eval("#make", (d) => { d.open = true; });
await fill(ann, "#make", { title: "Quiz night", day: ahead(20), time: "19:30" });
await tick(ann, "#make", ["Bob Example"]);
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#make button.primary")]);
const quiz = new URL(ann.url()).pathname.split("/").pop();
check("Bob's invited to the quiz", await waitFor(() => n(stateB, `copies WHERE id = '${quiz}'`) === 1));
const exported = await ann.evaluate(() => Promise.all(["items", "item_guests"].map((t) => fetch(`/_admin/export/rows?table=${t}`).then((r) => r.json()))));
check("Download everything includes events, answers and who they're for", exported[0].rows?.some((r) => r.content.includes('"event"') && r.tally?.includes("answers"))
  && exported[1].rows?.length > 0, JSON.stringify(exported).slice(0, 200));
await ann.click("article.own header details.more summary");
await Promise.all([settled(ann), ann.click("article.own header .delete")]);
check("deleting it takes its event and who it was for", n(stateA, `items WHERE id = '${quiz}'`) === 0 && n(stateA, `item_guests WHERE item = '${quiz}'`) === 0);
check("…and tells Bob it's off", await waitFor(() => n(stateB, "notices WHERE kind = 'cancelled' AND connection_id IS NOT NULL") === 2 && n(stateB, `copies WHERE id = '${quiz}'`) === 0));

// Removing a friend forgets what they were invited to, on both sides.
await ann.goto(`${A}/friend/${bobId}/posts`);
await ann.$eval('form[action$="/disconnect"]', (f) => f.requestSubmit());
await waitFor(() => n(stateA, `connections WHERE id = ${bobId}`) === 0);
check("removing Bob forgets his invitations and answers", n(stateA, `item_guests WHERE connection_id = ${bobId}`) === 0 && answerOf(key, stateB) === null);
check("…and his site forgets Ann's events (not the group's)", await waitFor(() => n(stateB, "copies WHERE connection_id IS NOT NULL") === 0)
  && n(stateB, "copies WHERE group_id IS NOT NULL") > 0);

check("no script errors", errors.length === 0, errors.join("; "));
pushService.close();
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
