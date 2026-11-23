// Mentions (src/mentions.js, docs/mentions-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a
// group's Worker (G, 8790). Ann is friends with Bob and with Cat, who aren't friends with each other. Typing @ offers
// people to mention; a post or comment that mentions someone tells them (Notifications, and their phone if it takes
// mentions), but only if they can see it, as the site holding the post decides. Names typed by hand mention nobody.
// In a group: members only, and @here (everyone) for its owner and admins, or anyone if they allow it, a few a day.
// A stand-in push service on 8796 counts what reaches each "phone".
//   node mentions.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { count as n, letInto, settled, siteCall, siteSql as sql, setUpSigning, signedGroupPost, signedGroupRecord, startSignedGroup } from "./helpers.mjs";
import { signCall } from "../../src/signedcalls.js";
import { signHead } from "../../src/lists.js";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, , stateA, stateB, stateC, stateG] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const G = "http://localhost:8790";
const PUSH = "http://localhost:8796";
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

// --- people, friends, phones ------------------------------------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(`${site}: ${m.text()}`); }); // blocked by the page's policy
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
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
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

// A stand-in push service: what reaches each phone is counted (notifications.mjs checks what's in them).
const pushes = [];
const pushService = createServer((req, res) => {
  req.resume();
  req.on("end", () => { pushes.push(req.url); res.writeHead(201).end(); });
}).listen(8796);
const toPhone = (who) => pushes.filter((p) => p === `/push/${who}`).length;
/** Turns on notifications for `page`'s owner, at /push/<who>, as their phone would. */
async function phone(page, site, who) {
  await page.goto(`${site}/events`);
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  return post(page, "/_push/devices", { endpoint: `${PUSH}/push/${who}`, name: `Phone (${who})`, preview: true,
    keys: { p256dh: keys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
}

/** Types into `box` and picks the first person the @ list offers; returns what it offered. */
async function mention(page, box, typed) {
  await page.type(box, typed);
  await page.waitForSelector("#mention-list:not([hidden]) li", { timeout: 5000 }).catch(() => {});
  const offered = await page.$$eval("#mention-list:not([hidden]) li", (l) => l.map((li) => li.firstChild.textContent));
  if (offered.length) await page.keyboard.press("Enter");
  return offered;
}
const mentionsField = (page, form) => page.$eval(`${form} input[name=mentions]`, (i) => JSON.parse(i.value)).catch(() => []);
/** Home opened until a friend's card has `words`, as its copy of their posts catches up (feed.js). */
async function friendCard(page, site, words) {
  let id = null;
  await waitFor(async () => {
    await page.goto(`${site}/`);
    id = await page.$$eval("article.from-friend", (l, w) => l.find((a) => a.innerText.includes(w))?.id ?? null, words);
    return Boolean(id);
  });
  return id && `#${id}`;
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat, who aren't friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2
  && n(stateB, `connections WHERE origin = '${C}'`) === 0);
check("Bob's and Cat's phones say yes to notifications", (await phone(bob, B, "bob")).on === true && (await phone(cat, C, "cat")).on === true);
check("…and to mentions, unless they say otherwise", (await post(cat, "/_push/devices/state", { endpoint: `${PUSH}/push/cat` })).mentions === true);

// --- a post that mentions a friend (signed: step 4c, docs/signed-conversations.md) -------------------------------------------

const personOf = (state, origin) => sql(state, `SELECT identity FROM connections WHERE origin = '${origin}'`)[0]?.identity;
const ownPerson = (state) => sql(state, "SELECT person FROM own_identity")[0].person;
const notices = (state, kind) => n(state, `notices WHERE kind = '${kind}'`);
check("making friends tied each to the other's identity", personOf(stateA, B) === ownPerson(stateB) && personOf(stateA, C) === ownPerson(stateC)
  && personOf(stateB, A) === ownPerson(stateA));

await ann.goto(`${A}/posts`);
const offered = await mention(ann, "#composer textarea", "Walk on Saturday, @Bo");
check("typing @ offers friends, narrowing as you type", offered.join() === "@Bob Example", offered.join());
check("…and picking one writes their whole name", (await ann.$eval("#composer textarea", (t) => t.value)) === "Walk on Saturday, @Bob Example ");
check("…noting who that is, by their identity", JSON.stringify(await mentionsField(ann, "#composer"))
  === JSON.stringify([{ name: "Bob Example", origin: B, person: ownPerson(stateB) }]));
await ann.type("#composer textarea", "who's in?");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("Ann's post shows the mention", (await ann.$eval("article.own .text strong.mention", (s) => s.textContent).catch(() => "")) === "@Bob Example");
check("…and its signed record names Bob by his identity", sql(stateA, "SELECT content FROM items WHERE type = 'post'")
  .some((r) => JSON.parse(r.content).mentions?.[0]?.person === ownPerson(stateB)));
check("Bob's site is told he's mentioned", await waitFor(() => notices(stateB, "mention") === 1));
check("…and his phone", await waitFor(() => toPhone("bob") === 1), String(toPhone("bob")));
check("…but not Cat, who isn't mentioned", notices(stateC, "mention") === 0 && toPhone("cat") === 0);
await bob.goto(`${B}/activity`);
check("Bob's Notifications says Ann mentioned him", (await text(bob)).includes("Ann Example mentioned you on their post"));
const walkOnBob = await friendCard(bob, B, "Walk on Saturday");
check("…and his Home shows her post with the mention", (await bob.$eval(`${walkOnBob} .text strong.mention`, (s) => s.textContent).catch(() => "")) === "@Bob Example");

// Names typed by hand, or not in the words, mention nobody; and Ann's site takes mentions only of those who can see it.
await ann.goto(`${A}/posts`);
await ann.$eval("#composer textarea", (t) => { t.value = "Hi @Cat Example, typed by hand"; });
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("a name typed by hand isn't a mention", !(await ann.$eval("article.own", (a) => Boolean(a.querySelector("strong.mention")))));
/** Signs a post in `page`'s browser mentioning `mentions` ([{name, person}]) and sends it as the composer does. */
const signPost = (page, words, mentions) => page.evaluate(async (words, mentions) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const made = await makeRecord({ kind: "item", author: key.person, host: key.person, mentions: mentions.map((m) => m.person) },
    { type: "post", text: words, photos: [], mentions }, key);
  const res = await fetch("/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: made.sent, photos: [] }) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, words, mentions);
const notSaid = await signPost(ann, "Hello", [{ name: "Cat Example", person: ownPerson(stateC) }]);
check("…the site refuses a mention its words don't say", notSaid.status === 400 && /its words don't/.test(notSaid.error ?? ""), JSON.stringify(notSaid));
const stranger = await signPost(ann, "Hello @Zed Stranger", [{ name: "Zed Stranger", person: "z".repeat(43) }]);
check("…or of someone who can't see it", stranger.status === 400 && /can see this/.test(stranger.error ?? ""), JSON.stringify(stranger));
await new Promise((r) => setTimeout(r, 3000));
check("…and neither tells anyone", notices(stateC, "mention") === 0);

// --- comments: on a friend's post, and passed on by the site that holds the post --------------------------------------------

const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};
await bob.goto(`${B}/posts`);
await bob.type("#composer textarea", "Anyone for tennis?");
await Promise.all([bob.waitForNavigation({ timeout: 60_000 }), bob.click("#composer button.post")]);
const tennis = await friendCard(ann, A, "Anyone for tennis?");
check("Bob posts, and it reaches Ann's Home", Boolean(tennis));
await openThread(ann, tennis);
const notThere = await mention(ann, `${tennis} .say textarea`, "@Ca");
check("on a friend's post, the @ list doesn't offer your other friends", notThere.length === 0, notThere.join());
await ann.$eval(`${tennis} .say textarea`, (t) => { t.value = ""; });
const asked = await mention(ann, `${tennis} .say textarea`, "@Bo");
check("…only its writer and those already in its thread", asked.join() === "@Bob Example", asked.join());
await ann.type(`${tennis} .say textarea`, "count me in");
await Promise.all([settled(ann), ann.click(`${tennis} .say button`)]);
check("Ann's comment on Bob's post mentions him, and his site tells him", await waitFor(() => sql(stateB, "SELECT own, actor FROM notices WHERE kind = 'mention'")
  .some((r) => r.own === 1 && r.actor === "Ann Example")));
check("…and his phone, as its owner", await waitFor(() => toPhone("bob") === 2), String(toPhone("bob")));
check("…and shows as a mention under his post, on Ann's Home", await ann.$eval(`${tennis} .comment strong.mention`, (s) => s.textContent).catch(() => "") === "@Bob Example");

// Cat comments on Ann's post; Bob, who can see it but isn't Cat's friend, mentions her there. Ann's site holds the
// post, and Cat can see it, so Ann's site tells her.
const walkCat = await friendCard(cat, C, "Walk on Saturday");
await openThread(cat, walkCat);
await cat.type(`${walkCat} .say textarea`, "Count me in");
await Promise.all([settled(cat), cat.click(`${walkCat} .say button`)]);
const catComments = notices(stateC, "comment");
const walkBob = await friendCard(bob, B, "Walk on Saturday");
await openThread(bob, walkBob);
const fromThread = await mention(bob, `${walkBob} .say textarea`, "@Ca");
check("the @ list has people already on the post, friends or not", fromThread.join() === "@Cat Example", fromThread.join());
await bob.type(`${walkBob} .say textarea`, "see you there");
await Promise.all([settled(bob), bob.click(`${walkBob} .say button`)]);
check("Ann's site tells Cat, who can see the post", await waitFor(() => notices(stateC, "mention") === 1));
check("…and her phone", await waitFor(() => toPhone("cat") === 1), String(toPhone("cat")));
check("…once: not a comment note as well", notices(stateC, "comment") === catComments);
check("…and Ann hears Bob commented on her post", await waitFor(() => sql(stateA, "SELECT own, actor FROM notices WHERE kind = 'comment'")
  .some((r) => r.own === 1 && r.actor === "Bob Example")));
await cat.goto(`${C}/activity`);
check("Cat's Notifications says who mentioned her, and where", (await text(cat)).includes("Bob Example mentioned you on Ann Example's post"));

// On someone else's post, its site only takes mentions of its writer and of those already in the thread, whatever's signed.
const typedPost = sql(stateA, "SELECT id FROM items WHERE type = 'post' AND content LIKE '%typed by hand%'")[0].id;
const annForBob = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
const signComment = (page, path, words, mentions) => page.evaluate(async (path, words, mentions) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const doc = new DOMParser().parseFromString(await (await fetch(path)).text(), "text/html");
  const form = doc.querySelector("form.say");
  const d = form.dataset;
  const key = await savedKey();
  const made = await makeRecord({ kind: "comment", author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null, mentions: mentions.map((m) => m.person) }, { text: words, mentions }, key);
  const body = new URLSearchParams({ sent: JSON.stringify(made.sent), back: path });
  return (await fetch(form.getAttribute("action"), { method: "POST", body, redirect: "manual" })).status;
}, path, words, mentions);
const sneaked = await signComment(bob, `/friend/${annForBob}/posts/${typedPost}`, "@Cat Example look at this", [{ name: "Cat Example", person: ownPerson(stateC) }]);
await new Promise((r) => setTimeout(r, 3000));
check("…so mentioning someone who isn't there is refused, and tells no one", sneaked === 400 && notices(stateC, "mention") === 1, String(sneaked));

// Cat says no to mentions on her phone: she's still told, but her phone isn't.
check("a phone can turn mentions off", (await post(cat, "/_push/devices/mentions", { endpoint: `${PUSH}/push/cat`, mentions: false })).ok === true
  && (await post(cat, "/_push/devices/state", { endpoint: `${PUSH}/push/cat` })).mentions === false);
const again = await friendCard(bob, B, "Walk on Saturday");
await openThread(bob, again);
await mention(bob, `${again} .say textarea`, "@Ca");
await bob.type(`${again} .say textarea`, "bring a flask");
await Promise.all([settled(bob), bob.click(`${again} .say button`)]);
check("…then she's told on her site", await waitFor(() => notices(stateC, "mention") === 2));
await new Promise((r) => setTimeout(r, 2000));
check("…but her phone isn't", toPhone("cat") === 1, String(toPhone("cat")));

// Mention receipts (step 5, decision 18): Bob's own site also sends Cat Ann's site's receipt for each comment of his that
// mentions her, and her site checks Ann's shows her that comment just where the receipt says.
check("Bob's site sends Cat the receipts, and Ann's site shows her both comments where they say", await waitFor(() =>
  n(stateC, "mention_receipts WHERE state = 'ok'") === 2), JSON.stringify(sql(stateC, "SELECT state FROM mention_receipts")));
check("…still one mention each", notices(stateC, "mention") === 2);
const firstReceipt = sql(stateC, "SELECT fp FROM mention_receipts ORDER BY created_at, rowid LIMIT 1")[0].fp;
const receiptBody = (fp, changes = {}) => {
  const row = sql(stateB, `SELECT host, item, record, receipt FROM sent WHERE fp = '${fp}'`)[0];
  const sent = JSON.parse(row.record);
  const key = JSON.parse(Buffer.from(sent.record, "base64url")).key;
  const d = sql(stateB, `SELECT bytes, proof FROM known_delegations WHERE key = '${key}'`)[0];
  const own = sql(stateB, "SELECT person, chain, profile FROM own_identity")[0];
  return { v: 2, kind: "receipt", host: row.host, item: row.item, sent, receipt: JSON.parse(row.receipt), delegation: { bytes: d.bytes, proof: JSON.parse(d.proof) },
    people: { [own.person]: { chain: JSON.parse(own.chain), ...(own.profile && { profile: JSON.parse(own.profile) }) } }, ...changes };
};
const forgetAtCat = (fp) => sql(stateC, `DELETE FROM notices WHERE fp = '${fp}'; DELETE FROM mention_receipts WHERE fp = '${fp}'`);
// Had Ann's site never told her, Bob's alone would have.
forgetAtCat(firstReceipt);
const resent = await siteCall(stateB, B, `${C}/_p/mention`, receiptBody(firstReceipt));
check("from Bob's site alone, Cat is told she's mentioned, and it checks", resent.status === 202 && await waitFor(() => notices(stateC, "mention") === 2
  && n(stateC, `mention_receipts WHERE fp = '${firstReceipt}' AND state = 'ok'`) === 1));
// Ann's site signing one thing for Bob and showing Cat another at that point: Cat's site says so, plainly.
forgetAtCat(firstReceipt);
const real = JSON.parse(Buffer.from(receiptBody(firstReceipt).receipt.bytes, "base64url").toString());
const annHosting = await crypto.subtle.importKey("pkcs8", Buffer.from(sql(stateA, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
  { name: "Ed25519" }, false, ["sign"]);
const otherVersion = await signHead(annHosting, { host: real.host, list: real.list, n: real.n, head: "x".repeat(43) });
await siteCall(stateB, B, `${C}/_p/mention`, receiptBody(firstReceipt, { receipt: otherVersion }));
check("a receipt for a conversation Ann's site doesn't show Cat: her site says so", await waitFor(() => notices(stateC, "hidden") === 1
  && n(stateC, `mention_receipts WHERE fp = '${firstReceipt}' AND state = 'hidden'`) === 1));
await cat.goto(`${C}/activity`);
check("…on her Notifications", (await text(cat)).includes("Ann Example's site isn't showing you a comment by Bob Example that mentions you"), (await text(cat)).slice(0, 300));
// One about a post on a site Cat isn't friends with (Bob's own), or not signed by its writer's site: quietly nothing.
forgetAtCat(firstReceipt);
const kept = n(stateC, "mention_receipts");
const notFriends = await siteCall(stateB, B, `${C}/_p/mention`, receiptBody(firstReceipt, { host: ownPerson(stateB) }));
const unsigned = await fetch(`${C}/_p/mention`, { method: "POST", headers: { "Content-Type": "application/json", "Afterwrd-From": B }, body: JSON.stringify(receiptBody(firstReceipt)) });
check("receipts about a stranger's post, or unsigned, are quietly ignored", notFriends.status === 202 && unsigned.status === 202 && n(stateC, "mention_receipts") === kept
  && n(stateC, `notices WHERE fp = '${firstReceipt}'`) === 0);

// A friend's site can only send notes about its own posts, and only comments its receipts vouch for. Bob's site, signing
// as itself (its hosting key), tries both on Ann's.
const bobHosting = await crypto.subtle.importKey("pkcs8", Buffer.from(sql(stateB, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
  { name: "Ed25519" }, false, ["sign"]);
const asBob = async (body) => {
  const url = `${A}/_p/notes`;
  const text = JSON.stringify(body);
  const headers = await signCall({ method: "POST", url, body: text, person: ownPerson(stateB), from: B, privateKey: bobHosting });
  return (await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: text })).status;
};
const annsPost = sql(stateB, "SELECT id, record, created_at FROM copies LIMIT 1")[0]; // Bob's copy of one of Ann's
const mentionsBefore = notices(stateA, "mention");
check("a new-post note about someone else's post is refused", (await asBob({ v: 2, kind: "item",
  item: { id: annsPost.id, sent: JSON.parse(annsPost.record), taken: annsPost.created_at, content: { text: "forged" } } })) === 400);
const realEntry = sql(stateB, "SELECT entries FROM list_pages ORDER BY rowid DESC LIMIT 1")[0];
const lastEntry = JSON.parse(realEntry.entries).at(-1);
check("a comment note whose receipt doesn't check is refused", (await asBob({ v: 2, kind: "comment", item: JSON.parse(Buffer.from(lastEntry.sent.record, "base64url")).item,
  entry: { n: lastEntry.n, fp: lastEntry.fp, taken: lastEntry.taken, prev: "", sent: lastEntry.sent },
  receipt: { bytes: Buffer.from(JSON.stringify({ v: 2, kind: "head", n: lastEntry.n })).toString("base64url"), sig: "x" } })) === 400);
check("…and nothing's kept", notices(stateA, "mention") === mentionsBefore);
check("an unsigned note is refused", (await fetch(`${A}/_p/notes`, { method: "POST", headers: { "Afterwrd-From": B }, body: "{}" })).status === 401);

// --- in a group (signed: docs/signed-conversations.md, step 6) ----------------------------------------------------------

const annGroup = await startSignedGroup(ann, { origin: G, setup: GROUP_KEY, name: "Walkers" });
const bobGroup = await letInto(ann, A, annGroup, bob, B, stateB);
const catGroup = await letInto(ann, A, annGroup, cat, C, stateC);
check("the group has three members", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const groupPerson = sql(stateG, "SELECT person FROM own_identity")[0].person;
const groupNotices = (state, kind) => n(state, `notices WHERE group_id IS NOT NULL AND kind = '${kind}'`);
const here = (words) => ({ type: "post", text: words, here: true });

await cat.goto(`${C}/groups/${catGroup}`);
const catOffered = await mention(cat, "#composer textarea", "@");
check("in a group, the @ list is its members, without @here for a member", catOffered.includes("@Bob Example") && catOffered.includes("@Ann Example")
  && !catOffered.includes("@here"), catOffered.join());
const refused = await signedGroupPost(cat, catGroup, groupPerson, here("Hello @here"));
check("…and the group refuses @here from a member", refused.status === 400 && /Only the group's admins can use @here/.test(refused.error ?? ""), JSON.stringify(refused));

await ann.goto(`${A}/groups/${annGroup}`);
const annOffered = await mention(ann, "#composer textarea", "@he");
check("its owner is offered @here", annOffered.join() === "@here", annOffered.join());
await ann.type("#composer textarea", "the walk's moved to 7");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
check("@here tells everyone else in the group", await waitFor(() => groupNotices(stateB, "here") === 1 && groupNotices(stateC, "here") === 1));
check("…on Bob's phone, and not Cat's (mentions off)", await waitFor(() => toPhone("bob") === 3) && toPhone("cat") === 1, `${toPhone("bob")} ${toPhone("cat")}`);
check("…and not the writer", groupNotices(stateA, "here") === 0);
await bob.goto(`${B}/groups/${bobGroup}`);
check("…shown as a mention in the group", (await bob.$eval("article.in-group strong.mention", (s) => s.textContent).catch(() => "")) === "@here");
await bob.goto(`${B}/activity`);
check("…and on Notifications", (await text(bob)).includes("Ann Example wrote to everyone (@here) in a post in Walkers"), (await text(bob)).slice(0, 300));

// Ann lets anyone use it; Cat can then, a few times a day.
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#here input[name=anyone]");
await Promise.all([ann.waitForNavigation(), ann.click("#here button")]);
check("the owner can let anyone use @here", n(stateG, "groups WHERE here_anyone = 1") === 1 && await ann.$eval("#here input[name=anyone]", (i) => i.checked));
const heres = [];
for (let i = 0; i < 4; i++) heres.push(await signedGroupPost(cat, catGroup, groupPerson, here(`Lifts? @here (${i})`)));
check("…then a member can, three times a day", heres.slice(0, 3).every((r) => r.status === 200), JSON.stringify(heres.slice(0, 3)));
check("…and no more", heres[3].status === 400 && /used a lot today/.test(heres[3].error ?? ""), JSON.stringify(heres[3]));
check("…each telling the others", await waitFor(() => groupNotices(stateB, "here") === 4));

// Mentioning by name in a group: members only, by who they are.
const gPost = sql(stateG, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at LIMIT 1")[0].id;
const point = (id) => { const r = sql(stateG, `SELECT n, head FROM lists WHERE id = '${id}'`)[0]; return { n: r.n, h: r.head }; };
const catPerson = sql(stateC, "SELECT person FROM own_identity")[0].person;
const outsider = "z".repeat(43);
const sayTo = (people, words) => signedGroupRecord(bob, bobGroup, { kind: "comment", host: groupPerson, item: gPost, seen: point(gPost),
  prev: sql(stateB, `SELECT fp FROM sent WHERE item = '${gPost}' ORDER BY created_at DESC, rowid DESC LIMIT 1`)[0]?.fp ?? null, mentions: people.map((p) => p.person) },
  { text: words, mentions: people });
check("a group comment mentioning someone who isn't in it is refused", (await sayTo([{ name: "Zed Stranger", person: outsider }], "@Zed Stranger, thoughts?")) === 400);
check("…and one mentioning a member, by who they are, tells them", (await sayTo([{ name: "Cat Example", person: catPerson }], "@Cat Example, thoughts?")) !== 400
  && await waitFor(() => groupNotices(stateC, "mention") === 1));
// The group's @here allowance holds back ordinary members only: with it used up, Ann (its owner) can still.
sql(stateG, `INSERT INTO here_log (member_id, at) VALUES ${Array.from({ length: 10 }, () => "(999, strftime('%s','now'))").join(",")}`);
const bobHere = await signedGroupPost(bob, bobGroup, groupPerson, here("Again @here"));
const annHere = await signedGroupPost(ann, annGroup, groupPerson, here("Admins can still @here"));
check("with the group's @here allowance used, members can't, but its admins can", bobHere.status === 400 && annHere.status === 200,
  `${JSON.stringify(bobHere)} ${JSON.stringify(annHere)}`);

check("no script errors", errors.length === 0, errors.join("; "));
pushService.close();
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
