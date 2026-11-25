// Daily limits (docs/signed-conversations.md, step 8): src/allowances.js, limits.js, hosted.js overDailyRecords,
// notes.js keepNotice. Three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and Ann's group's (G, 8790). Ann
// Bob and Cat are all friends, and all three are in the group. Small limits stand in for the real ones (run.sh):
//   Bob's site: 40 calls a caller a day, and a day of 90 seconds (TEST_LIMITS, TEST_DAY_SECONDS)
//   Cat's site: 3 records a writer a day, 2 notices from one writer a day, 1 of them to the phone
//   the group's site: 3 records a member a day
// A stand-in push service on 8796 counts what reaches Cat's "phone".
//   node limits.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { count as n, letInto, settled, siteCall, siteSql as sql, setUpSigning, signedGroupPost, signedGroupRecord, startSignedGroup } from "./helpers.mjs";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const PUSH = "http://localhost:8796";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const B_DAY = 90; // run.sh: TEST_DAY_SECONDS on Bob's site
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await test()) return true;
  return false;
};

// --- people, friends, a group, Cat's phone ----------------------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(`${site}: ${m.text()}`); }); // blocked by the page's policy
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
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
async function compose(page, site, words) {
  await page.goto(`${site}/posts`);
  await page.type("#composer textarea", words);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
/** Home opened until a friend's card has `words`, as its copy of their posts catches up. */
async function friendCard(page, site, words) {
  let id = null;
  await waitFor(async () => {
    await page.goto(`${site}/`);
    id = await page.$$eval("article.from-friend", (l, w) => l.find((a) => a.innerText.includes(w))?.id ?? null, words);
    return Boolean(id);
  });
  return id && `#${id}`;
}
const pushes = [];
const pushService = createServer((req, res) => {
  req.resume();
  req.on("end", () => { pushes.push(req.url); res.writeHead(201).end(); });
}).listen(8796);
const toPhone = (who) => pushes.filter((p) => p === `/push/${who}`).length;
async function phone(page, site, who) {
  await page.goto(`${site}/events`);
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  return post(page, "/_push/devices", { endpoint: `${PUSH}/push/${who}`, name: `Phone (${who})`, preview: true,
    keys: { p256dh: keys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
await befriend(bob, B, cat, C);
check("Ann, Bob and Cat are all friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2 && n(stateB, "connections WHERE approved_at IS NOT NULL") === 2);
check("Cat's phone says yes to notifications", (await phone(cat, C, "cat")).on === true);
const annGroup = await startSignedGroup(ann, { origin: G, setup: GROUP_KEY, name: "Walkers" });
const bobGroup = await letInto(ann, A, annGroup, bob, B, stateB);
const catGroup = await letInto(ann, A, annGroup, cat, C, stateC);
check("the group has three members", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const person = (state) => sql(state, "SELECT person FROM own_identity")[0].person;
const annPerson = person(stateA), bobPerson = person(stateB), catPerson = person(stateC), groupPerson = person(stateG);
const point = (id) => { const r = sql(stateG, `SELECT n, head FROM lists WHERE id = '${id}'`)[0]; return { n: r.n, h: r.head }; };
const lastSent = (state, item) => sql(state, `SELECT fp FROM sent WHERE item = '${item}' ORDER BY created_at DESC, rowid DESC LIMIT 1`)[0]?.fp ?? null;
/** A comment on the group's post `item`, signed in `page`'s browser, mentioning `people` ([{name, person}]). */
const groupComment = (page, groupId, state, item, words, people = []) => signedGroupRecord(page, groupId, { kind: "comment", host: groupPerson, item,
  seen: point(item), prev: lastSent(state, item), ...(people.length && { mentions: people.map((p) => p.person) }) }, { text: words, ...(people.length && { mentions: people }) });

// --- 8c: sizes, refused before anything is read ------------------------------------------------------------------------

const big = { pad: "x".repeat(70 * 1024) };
check("a call bigger than 64 KB is refused, on a friend's site", (await siteCall(stateA, A, `${B}/_p/records`, big)).status === 413);
check("…and on a group's", (await siteCall(stateA, A, `${G}/_p/items`, big)).status === 413);
check("…and with notes", (await siteCall(stateA, A, `${C}/_p/notes`, big)).status === 413);
const points = Array.from({ length: 201 }, (_, i) => ({ fp: String(i).padStart(43, "a"), list: "b".repeat(43) }));
const tooMany = await siteCall(stateA, A, `${C}/_p/records/check`, { points });
check("a check asking about more than 200 is refused, not cut short", tooMany.status === 413, String(tooMany.status));
check("…while 200 are answered", (await siteCall(stateA, A, `${C}/_p/records/check`, { points: points.slice(0, 200) })).status === 200);

// --- 8b: mentions capped by the writer, wherever they wrote ------------------------------------------------------------

const mentionsOnC = (who) => n(stateC, `notices WHERE kind = 'mention' AND author = '${who}'`);
const signPost = (page, words, mentions) => page.evaluate(async (words, mentions) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const made = await makeRecord({ kind: "item", author: key.person, host: key.person, mentions: mentions.map((m) => m.person) },
    { type: "post", text: words, photos: [], mentions }, key);
  const res = await fetch("/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: made.sent, photos: [] }) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, words, mentions);
const catAs = [{ name: "Cat Example", person: catPerson }];
check("Ann mentions Cat in a post on her own site", (await signPost(ann, "Lunch, @Cat Example?", catAs)).status === 200);
check("…and Cat's site keeps it, as Ann's", await waitFor(() => mentionsOnC(annPerson) === 1));
check("…and it reaches Cat's phone", await waitFor(() => toPhone("cat") === 1), String(toPhone("cat")));
const walk = await signedGroupPost(ann, annGroup, groupPerson, { type: "post", text: "Walk on Sunday" });
check("Ann posts in the group", walk.status === 200, JSON.stringify(walk));
const walkId = sql(stateG, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC LIMIT 1")[0].id;
check("Ann mentions Cat again, in the group: a different site", (await groupComment(ann, annGroup, stateA, walkId, "@Cat Example, coming?", catAs)) !== 400);
check("…kept: Ann's second today", await waitFor(() => mentionsOnC(annPerson) === 2));
await sleep(2000);
check("…but not on Cat's phone: one a day from one writer here", toPhone("cat") === 1, String(toPhone("cat")));
check("Ann mentions Cat a third time, in the group", (await groupComment(ann, annGroup, stateA, walkId, "@Cat Example, bring boots", catAs)) !== 400
  && await waitFor(() => n(stateG, `authored WHERE author = '${annPerson}' AND list != '${groupPerson}'`) === 3)); // her post, and two comments
await sleep(3000);
check("…not kept: past Ann's two a day, though the group's own allowance has room", mentionsOnC(annPerson) === 2, String(mentionsOnC(annPerson)));
check("Bob mentions Cat in the group", (await groupComment(bob, bobGroup, stateB, walkId, "@Cat Example, I'll drive", catAs)) !== 400);
check("…kept: it's per writer, not per site", await waitFor(() => mentionsOnC(bobPerson) === 1));
check("…and on her phone: his first", await waitFor(() => toPhone("cat") === 2), String(toPhone("cat")));

// --- 8b: records capped per writer a day, across posts (on Cat's site and the group's: 3) -------------------------------

await compose(cat, C, "New allotment");
await compose(cat, C, "Seeds for swapping");
const allotment = await friendCard(ann, A, "New allotment");
const seeds = await friendCard(ann, A, "Seeds for swapping");
check("Cat's posts reach Ann's Home", Boolean(allotment && seeds));
const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};
const annOnC = () => n(stateC, `authored WHERE author = '${annPerson}'`);
async function annComments(card, words) {
  await ann.goto(`${A}/`);
  await openThread(ann, card);
  await ann.type(`${card} .say textarea`, words);
  await Promise.all([settled(ann), ann.click(`${card} .say button`)]);
}
await annComments(allotment, "Lovely");
await annComments(allotment, "Which plot?");
await annComments(seeds, "I've got beans");
check("Ann leaves three comments on Cat's posts", await waitFor(() => annOnC() === 3), String(annOnC()));
await annComments(seeds, "And peas");
await sleep(2000);
check("…a fourth that day, on either post, isn't taken", annOnC() === 3, String(annOnC()));
// Deleting what's hers is never held back.
const seedsId = sql(stateC, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC LIMIT 1")[0].id;
const beans = sql(stateC, `SELECT fp FROM authored WHERE author = '${annPerson}' AND list = '${seedsId}'`)[0].fp;
const relay = `/_admin/friend/${sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id}/items/${seedsId}/records`;
await ann.goto(`${A}/friend/${sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id}/posts/${seedsId}`);
const deleted = await ann.evaluate(async (url, about) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const d = document.querySelector("form.say").dataset;
  const key = await savedKey();
  const made = await makeRecord({ kind: "delete", about, author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null }, undefined, key);
  return (await fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ sent: JSON.stringify(made.sent), back: "/" }) })).status;
}, relay, beans);
check("…while a delete still is", await waitFor(() => n(stateC, `authored WHERE fp = '${beans}' AND author IS NULL`) === 1), String(deleted));

// In the group: Ann has written three records there today (a post counts too), so no more; but an admin's removal always.
await groupComment(cat, catGroup, stateC, walkId, "Is it muddy?");
check("Cat comments in the group", await waitFor(() => n(stateG, `authored WHERE author = '${catPerson}' AND list != '${groupPerson}'`) === 1));
const fourth = await groupComment(ann, annGroup, stateA, walkId, "Very muddy");
await sleep(1500);
check("Ann's fourth record in the group today isn't taken", n(stateG, `authored WHERE author = '${annPerson}' AND list != '${groupPerson}'`) === 3, String(fourth));
const another = await signedGroupPost(ann, annGroup, groupPerson, { type: "post", text: "Another walk" });
check("…nor a new post (it's a record too)", another.status !== 200 && n(stateG, `authored WHERE author = '${annPerson}' AND list != '${groupPerson}'`) === 3, JSON.stringify(another));
const catsFp = sql(stateG, `SELECT fp FROM authored WHERE author = '${catPerson}' AND list != '${groupPerson}'`)[0].fp;
const removed = await ann.evaluate(async (g, f) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const role = { role_at: (await (await fetch(`/_groups/${g}/point`, { method: "POST" })).json()).role_at };
  const made = await makeRecord({ author: key.person, ...f, ...role }, undefined, key);
  const body = new FormData();
  body.set("sent", JSON.stringify(made.sent));
  body.set("back", "/");
  return (await fetch(`/_groups/${g}/items/${f.item}/records`, { method: "POST", body, redirect: "manual" })).status;
}, annGroup, { kind: "remove", host: groupPerson, item: walkId, seen: point(walkId), prev: lastSent(stateA, walkId), about: catsFp });
check("…but as the group's owner she can still remove Cat's comment", await waitFor(() => n(stateG, `authored WHERE fp = '${catsFp}' AND author IS NULL`) === 1), String(removed));

// --- 8a: each caller's allowance on a site (Bob's: 40 calls a day, a day of 90 seconds) --------------------------------

await compose(bob, B, "Ferry times");
const ferry = await friendCard(ann, A, "Ferry times");
check("Bob's post reaches Ann's Home", Boolean(ferry));
const ferryId = sql(stateB, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC LIMIT 1")[0].id;
const bobConn = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
// From the start of a fresh day on Bob's site, so the day doesn't end part way.
const seconds = () => Date.now() / 1000;
await sleep(((Math.floor(seconds() / B_DAY) + 1) * B_DAY - seconds() + 0.5) * 1000);
let refusedAt = 0, answer = null;
for (let i = 1; i <= 60 && !refusedAt; i++) {
  const r = await siteCall(stateA, A, `${B}/_p/items?since=0`);
  if (r.status === 429) { refusedAt = i; answer = await r.json(); }
}
// Up to 40 (fewer if Ann's site called Bob's itself meanwhile, as it may in the background).
check("Ann's site gets 40 calls on Bob's in a day, then is refused", refusedAt > 30 && refusedAt <= 41, String(refusedAt));
check("…told when the day ends there", Number.isSafeInteger(answer?.retry) && answer.retry % B_DAY === 0 && answer.retry > seconds(), JSON.stringify(answer));
check("…and Bob's site keeps her count, as she's past a quarter", n(stateB, `allowances WHERE person = '${annPerson}' AND calls >= 10`) === 1);
check("Cat's site, also calling Bob's, isn't held back by Ann's count", (await siteCall(stateC, C, `${B}/_p/items?since=0`)).status === 200);
await ann.goto(`${A}/friend/${bobConn}/posts/${ferryId}`);
check("opening Bob's post, Ann is told why it won't open", (await text(ann)).includes("Bob Example's site has had a lot of requests from you today. Try tomorrow."),
  (await text(ann)).slice(0, 200).replace(/\s+/g, " "));
sql(stateA, `UPDATE connections SET items_checked_at = 0 WHERE origin = '${B}'`);
await ann.goto(`${A}/`);
check("Ann's Home asks Bob's site again: busy, never \"not answering\"", await waitFor(() => Number(sql(stateA, `SELECT items_checked_at FROM connections WHERE origin = '${B}'`)[0].items_checked_at) > 0)
  && sql(stateA, `SELECT missing_since FROM connections WHERE origin = '${B}'`)[0].missing_since === null);
await sleep((answer.retry - seconds() + 0.5) * 1000);
check("the next day there, Ann's site is answered again", (await siteCall(stateA, A, `${B}/_p/items?since=0`)).status === 200);

// --- 8d: the busy-account warning, adding up Ann's site and her group's ------------------------------------------------

await ann.goto(`${A}/`);
check("no busy-account box on a quiet week", !(await ann.$("#busy-account")));
const today = Math.floor(seconds() / 86400);
const fill = (state, requests) => sql(state, `INSERT INTO usage (day, site, requests, rows_read, rows_written) VALUES
  ${[0, 1, 2].map((d) => `(${today - d}, '', ${requests}, 0, 0)`).join(", ")}
  ON CONFLICT (day, site) DO UPDATE SET requests = excluded.requests`);
fill(stateA, 20_000);
await ann.goto(`${A}/`);
check("Ann's own site at 20% on three days: still nothing", !(await ann.$("#busy-account")));
fill(stateG, 40_000);
await ann.goto(`${A}/groups/${annGroup}`);
check("the group's site reports its own week to its owner's", await waitFor(() => n(stateA, `usage WHERE site = 'group:${annGroup}' AND requests >= 40000`) === 3));
check("…to its owner only", n(stateC, "usage WHERE site LIKE 'group:%'") === 0);
await ann.goto(`${A}/`);
const busy = await text(ann, "#busy-account");
check("together they're over half on three days: Home says so, calmly", busy.includes("over half of its free daily allowance on 3 days this week"), busy);
check("…with each one's share", /Walkers 6\d%/.test(busy) && /your own site 3\d%/.test(busy), busy);
check("…and what helps", busy.includes("Closing a group you no longer need frees it up."), busy);

check("no script errors", errors.length === 0, errors.join("; "));
pushService.close();
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
