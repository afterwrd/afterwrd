// Two afterwrd sites on this computer (A on 8787, B on 8788), each with its own owner: connect them with a
// Connect link (Ann approves the request), see each other's new posts in Feed, comment across sites, delete, and
// disconnect. Then Ann invites Facebook friends: a forwarded invite is declined, the right person approved and linked.
//   node feed.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>   (C, on 8789, plays a third site)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled, siteCall, siteSql as sql, setUpSigning } from "./helpers.mjs";
import { signCall } from "../../src/signedcalls.js";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath, fixtures, stateA, stateB, stateC] = process.argv.slice(2);
const A = "http://localhost:8787";
const B = "http://localhost:8788";
const C = "http://localhost:8789";
const CODE = "local-test-setup-code";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
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
async function importZip(page, site, zip = zipPath, sections = ["posts", "photos"]) {
  await page.goto(`${site}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zip);
  await page.$$eval("input[name=section]", (boxes, want) => boxes.forEach((b) => { b.checked = want.includes(b.value); }), sections);
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}
async function compose(page, site, text, files = []) {
  await page.goto(`${site}/posts`);
  await page.type("#composer textarea", text);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
const feedCards = (page) => page.$$eval("article.from-friend", (l) => l.map((a) => ({
  who: a.querySelector("header strong").textContent, text: a.querySelector(".text")?.textContent ?? "",
  photos: a.querySelectorAll(".collage img").length,
  comments: [...a.querySelectorAll(".comment")].map((c) => ({ name: c.querySelector("strong").textContent,
    from: c.querySelector(".from")?.textContent ?? "", text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under .delete")) })),
})));
// Home shows friends' posts from the copies a site keeps (feed.js), fetched again in the background: when a note says
// something's new, or once a copy is a few minutes old. So what's changed on a friend's site can take a moment: Home
// opened again until `ok(cards)`, or for `ms`. Returns the last cards seen.
async function homeUntil(page, site, ok, ms = 20_000) {
  let cards = [];
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    await page.goto(`${site}/`);
    cards = await feedCards(page);
    if (ok(cards)) break;
  }
  return cards;
}
// A friend's site as if it had never been asked: so Home asks it while it waits (friendcopies.js pullNew).
const copiesOld = (state) => sql(state, "UPDATE connections SET items_checked_at = NULL");

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
check("both sites set up and import", !(await importZip(ann, A)) && !(await importZip(bob, B)));
await compose(ann, A, "Ann's news from site A");
await compose(bob, B, "Bob's holiday", [`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`]);

// Before connecting.
await ann.goto(`${A}/`);
check("Home is first in the owner's menu", (await ann.$$eval("header.site nav.main a", (l) => l.map((a) => a.querySelector("span").textContent)))[0] === "Home");
check("empty Feed explains adding friends", (await ann.$eval("main", (m) => m.textContent)).includes("Add friends to see their posts here"));

// Ann makes a Connect link; Bob opens it, gives his site, and confirms there.
await ann.goto(`${A}/_admin/connections`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
check("friend link made, with a message to send", /^http:\/\/localhost:8787\/_connect\/[\w-]{40,}$/.test(link)
  && (await ann.$eval("#link-message", (t) => t.value)).endsWith(link), link.slice(0, 50) + "…");

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(link);
check("link opens a welcome naming Ann, without signing in", (await stranger.$eval("h1", (h) => h.textContent)) === "Ann Example would like to be friends");
check("…which tells someone with a site to copy the link into their own, with a button for it, the address box folded away",
  (await stranger.$eval("main", (m) => m.textContent)).includes("paste it into Add a friend") && (await stranger.$("#copy-link")) !== null
  && await stranger.$eval("#site", (f) => !f.closest("details").open));
check("the message says the same", (await ann.$eval("#link-message", (t) => t.value)).includes("paste it into Add a friend on your site"));
// Bob pastes it into Add a friend on his own site: the box comes first there.
await bob.goto(`${B}/_admin/connections`);
check("Add a friend starts with the box for a friend's link", (await bob.$eval("main h2", (h) => h.textContent)) === "Got a link from a friend?");
await bob.type("#paste input[name=link]", link);
await Promise.all([bob.waitForNavigation(), bob.click("#paste button:not([type=button])")]);
check("Bob is sent to his own site to confirm", bob.url().startsWith(`${B}/_admin/connections/new?link=`)
  && (await bob.$eval("h1", (h) => h.textContent)) === "Add Ann Example as a friend?");
await Promise.all([bob.waitForNavigation({ timeout: 30_000 }), bob.click("#go")]);
check("confirming connects and opens Bob's Home", new URL(bob.url()).pathname === "/", bob.url());

// Nothing is shared until Ann approves: a passed-on link gets someone no further than a request.
check("Bob's Home says Ann hasn't approved yet", (await bob.$eval("main", (m) => m.textContent)).includes("Waiting for Ann Example to approve"));
check("each site knows the other by identity, with no passwords handed over",
  sql(stateA, "SELECT identity FROM connections")[0].identity === sql(stateB, "SELECT person FROM own_identity")[0].person
  && sql(stateB, "SELECT identity FROM connections")[0].identity === sql(stateA, "SELECT person FROM own_identity")[0].person
  && !sql(stateA, "SELECT sql FROM sqlite_master WHERE name = 'connections'")[0].sql.includes("key"));
check("…and each knows the other by their signed name", sql(stateA, "SELECT name FROM connections")[0].name === "Bob Example"
  && sql(stateB, "SELECT name FROM connections")[0].name === "Ann Example");
check("Bob's site, signing its calls, can't read Ann's site yet", (await siteCall(stateB, B, `${A}/_p/items?since=0`)).status === 403);
await ann.goto(`${A}/`);
check("Ann's Friends shows 1 request", (await ann.$eval('header.site a[href="/friend"] .count', (c) => c.firstChild.textContent).catch(() => "")) === "1");
check("Ann's Home doesn't show Bob yet", !(await ann.$("article.from-friend")));
await ann.goto(`${A}/friend`);
const asking = await ann.$eval(".requests", (r) => r.innerText).catch(() => "");
check("Friends lists Bob under Asking to be friends", asking.includes("Bob Example") && asking.includes("Used a friend link you made"), asking);
// Approved from Home, in one tap.
await ann.goto(`${A}/`);
const homeAsk = await ann.$eval(".notice.asking", (n) => n.textContent.replace(/\s+/g, " ")).catch(() => "");
check("Home says who's asking to be friends, leading with their site", homeAsk.includes("localhost:8788") && homeAsk.includes("who says they're Bob Example"), homeAsk);
await Promise.all([ann.waitForNavigation(), ann.click('.notice.asking button[formaction*="/approve"]')]);
check("…and Approve there keeps Ann on Home", new URL(ann.url()).pathname === "/" && !(await ann.$(".notice.asking")));
await ann.goto(`${A}/friend`);
check("Approve makes Bob a friend", !(await ann.$(".requests")) && (await ann.$eval("main", (m) => m.innerText)).includes("Bob Example")
  && sql(stateA, "SELECT approved_at FROM connections")[0].approved_at > 0);
await bob.goto(`${B}/`);

// Server-Timing (timing.js): the owner sees what a page waited on, and the calls out it used; nobody else does.
const friendPage = await ann.goto(`${A}/friend/${sql(stateA, "SELECT id FROM connections")[0].id}/posts`);
const timing = friendPage.headers()["server-timing"] ?? "";
check("A friend's page says how long it waited on the database and their site, and the calls out used",
  /db;dur=\d+;desc="Database: [1-9]\d* quer\w+ in [1-9]\d* rounds?"/.test(timing) && /sql;dur=[\d.]+;desc="Running them: [1-9]\d* rows read"/.test(timing)
  && /sites;dur=\d+;desc="Other sites: [1-9]\d* call/.test(timing)
  && /calls;desc="Calls out: [1-9]\d* of 50; to objects: \d+"/.test(timing) && /total;dur=\d+/.test(timing), timing);
const others = await Promise.all([fetch(`${A}/_auth/login`), siteCall(stateB, B, `${A}/_p/items?since=0`)]);
check("…but not signed out, nor in answer to a friend's site", others[1].status === 200 && others.every((r) => !r.headers.has("server-timing")));
// Site files by their fingerprint are kept for good; by any other address they're checked each time (static.js, nav.js).
const css = await ann.$eval('link[rel=stylesheet][href^="/static/style.css"]', (l) => l.getAttribute("href"));
const kept = await ann.evaluate((pinned) => Promise.all([pinned, "/static/style.css", "/static/style.css?v=0000000000000000"]
  .map((u) => fetch(u).then((r) => r.headers.get("cache-control")))), css);
check("The stylesheet is fetched by its fingerprint and kept for good; any other address is checked each time",
  /^\/static\/style\.css\?v=[0-9a-f]{16}$/.test(css) && kept[0] === "private, max-age=31536000, immutable"
  && kept.slice(1).every((c) => c === "private, no-cache"), JSON.stringify([css, ...kept]));
const mapped = await ann.$eval("script[type=importmap]", (s) => JSON.parse(s.textContent).imports["/static/ui/menus.js"]).catch(() => "");
check("…and the scripts' own imports go by their fingerprints too", /^\/static\/ui\/menus\.js\?v=[0-9a-f]{16}$/.test(mapped), mapped);
// Prefetch on tap (views/nav.js): the owner's own pages that only read this site.
const prefetched = await ann.$eval("script[type=speculationrules]", (s) => JSON.parse(s.textContent).prefetch[0].where.and[0].or.map((r) => r.href_matches)).catch(() => []);
check("Prefetch on tap covers the owner's own pages, not Home, Events, friends', groups' or Notifications",
  ["/posts/*", "/photos", "/memories"].every((p) => prefetched.includes(p))
  && !prefetched.some((p) => p === "/" || /^\/(friend\/|groups|events|activity|_)/.test(p)), JSON.stringify(prefetched));

// Each sees the other's new posts, and only those.
let bobFeed = await feedCards(bob);
check("Bob's Feed has Ann's post, and only her afterwrd post", bobFeed.length === 1 && bobFeed[0].who === "Ann Example"
  && bobFeed[0].text === "Ann's news from site A", JSON.stringify(bobFeed));
await ann.goto(`${A}/`);
check("Home shows Ann's own posts and Bob's together", Boolean(await ann.$("article.own")) && Boolean(await ann.$("article.from-friend")));
let annFeed = await feedCards(ann);
check("Ann's Feed has Bob's post with its photos", annFeed.length === 1 && annFeed[0].who === "Bob Example" && annFeed[0].photos === 2, JSON.stringify(annFeed));
await ann.waitForFunction(() => document.querySelector("article.from-friend .collage img")?.complete, { timeout: 15_000 });
// Opened from his post, a photo of Bob's is among that post's photos (not his "Posted on afterwrd" album), and ✕ goes
// back to the post on Home. Worked out on Ann's site, so it's the same whatever version Bob's is.
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend .collage a.tile:nth-of-type(2)")]);
const friendInPost = await ann.evaluate(() => ({ counter: document.querySelector(".counter")?.textContent,
  close: document.getElementById("close").getAttribute("href"), prev: document.getElementById("prev")?.getAttribute("href"),
  next: Boolean(document.getElementById("next")), album: document.querySelector(".info .album-link").getAttribute("href") }));
check("a friend's photo opened from their post is among that post's photos", friendInPost.counter === "2 / 2" && !friendInPost.next
  && /^\/friend\/\d+\/posts\/[\w-]{43}\/photos\/1\?in=post&back=/.test(friendInPost.prev ?? "")
  && /^\/friend\/\d+\/posts\/[\w-]{43}$/.test(friendInPost.album), JSON.stringify(friendInPost));
check("…and ✕ goes back to the post on Home", /^\/#fi\d+-[\w-]{43}$/.test(friendInPost.close), friendInPost.close);
await Promise.all([ann.waitForNavigation(), ann.click("#prev")]);
check("…and stays with the post going back a photo", (await ann.$eval(".counter", (c) => c.textContent)) === "1 / 2"
  && (await ann.$eval("#close", (a) => a.getAttribute("href"))) === friendInPost.close);
await ann.goto(`${A}${friendInPost.prev.replace(/back=[^&]*/, `back=${encodeURIComponent("//evil.example/")}`)}`);
check("…but never back to another site", (await ann.$eval("#close", (a) => a.getAttribute("href"))) === "/");
await ann.goto(`${A}/`);
// Bob makes his holiday photo his profile picture; Ann's site shows it, and remembers it for her Friends page.
await bob.goto(`${B}/posts`);
const bobsPhoto = await bob.$eval("main article.own .collage a.tile", (a) => a.getAttribute("href"));
await bob.goto(B + bobsPhoto);
await Promise.all([bob.waitForNavigation(), bob.click('.photo-tools form:nth-of-type(1) button')]);
check("Bob's own header shows his new picture", Boolean(await bob.$("header.site .face img")));
const toolPages = ["/_admin", "/_admin/import", "/_admin/export", "/_admin/connections", "/_admin/update", "/_admin/photos/add"];
const withoutPicture = [];
for (const path of toolPages) {
  await bob.goto(B + path);
  if (!(await bob.$("header.site .face img"))) withoutPicture.push(path);
}
check("…and so do the pages behind it (devices, import, download, add a friend, update, adding photos)", !withoutPicture.length, withoutPicture.join(" "));
// A new picture sends no note: Ann's site sees it when it next asks Bob's site, as opening his page does (Home itself
// uses its copy of his posts, fetched again in the background once it's a few minutes old).
await ann.goto(`${A}/friend/${sql(stateA, "SELECT id FROM connections")[0].id}/posts`);
await ann.goto(`${A}/`);
check("Ann's Home shows Bob's picture on his post", await ann.$eval("article.from-friend header img.who", (i) => i.getAttribute("src").startsWith("http://localhost:8788/files/")).catch(() => false));
await ann.goto(`${A}/friend`);
check("…and her Friends page remembers it", Boolean(await ann.$(".friend-link img.who")));
await ann.goto(`${A}/`);
check("the photo loads straight from Bob's site, by a signed link", await ann.$eval("article.from-friend .collage img", (i, b) => i.naturalWidth > 0
  && i.getAttribute("src").startsWith(`${b}/files/`) && i.getAttribute("src").includes("&sig="), B));
await ann.goto(`${A}/_admin/connections`);
check("Ann's Connections lists Bob", (await ann.$eval("table.numbers tbody", (t) => t.textContent)).includes("Bob Example"));

// afterwrd 2: Ann comments on Bob's signed post from her Home. Her browser signs it; her site passes it on to Bob's in a
// signed call, and keeps it, with Bob's site's receipt (friendcopies.js). Comments are behind the post's button.
const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};
const bobPostOnA = () => sql(stateA, "SELECT id, connection_id FROM copies ORDER BY created_at DESC LIMIT 1")[0];
const bobPostId = bobPostOnA().id;
const bobsPostPage = `${A}/friend/${bobPostOnA().connection_id}/posts/${bobPostId}`;
const threadOn = async (page, url) => {
  await page.goto(url);
  return (await page.$$eval("article.card", (l) => l.map((a) => ({ comments: [...a.querySelectorAll(".comment:not(.gone)")].map((c) => ({
    name: c.querySelector("strong").textContent, text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under .delete")) })) }))))[0] ?? { comments: [] };
};
await ann.goto(`${A}/`);
await openThread(ann, "article.from-friend");
await ann.type("article.from-friend .say textarea", "Looks great, Bob!");
await ann.evaluate(() => { window.samePage = true; });
await Promise.all([settled(ann), ann.click("article.from-friend .say button")]);
check("…sent without a new page (Home isn't loaded again)", await ann.evaluate(() => window.samePage === true));
annFeed = await feedCards(ann);
check("Ann's comment shows under Bob's post, deletable", annFeed[0].comments.length === 1 && annFeed[0].comments[0].name === "Ann Example"
  && annFeed[0].comments[0].canDelete, JSON.stringify(annFeed[0].comments));
check("it's kept on Bob's site, as a record signed by Ann", sql(stateB, `SELECT comments, others FROM items WHERE id = '${bobPostId}'`)[0]?.comments === 1);
check("Ann keeps her own copy, with Bob's site's receipt", sql(stateA, "SELECT kind, receipt FROM sent").some((r) => r.kind === "comment" && r.receipt));
await bob.goto(`${B}/posts/${bobPostId}`);
const onBob = await bob.$$eval("article.card .comment:not(.gone)", (l) => l.map((c) => ({ name: c.querySelector("strong").textContent, from: c.querySelector(".from")?.textContent })));
check("Bob sees it under his post, as Ann (she's his friend)", onBob.length === 1 && onBob[0].name === "Ann Example" && onBob[0].from === undefined, JSON.stringify(onBob));
check("Bob can't change a post Ann has commented on", !(await bob.$("article.card > div.edit")));
check("Bob's site tells him: Ann commented on his post", sql(stateB, "SELECT kind, own, actor FROM notices WHERE kind = 'comment'")
  .some((r) => r.own === 1 && r.actor === "Ann Example"));
await bob.goto(`${B}/activity`);
check("…on his Notifications, linking to the post", (await bob.$eval("main", (m) => m.innerText)).includes("Ann Example commented on your post")
  && Boolean(await bob.$(`main a[href="/posts/${bobPostId}"]`)));
// Ann changes her comment; Bob's site takes the signed edit, and both show what it said before.
await ann.goto(bobsPostPage);
const annComment = "article.from-friend .comment:not(.gone)";
check("Ann's own comment offers Edit", Boolean(await ann.$(`${annComment} div.edit`)));
await ann.click(`${annComment} .under details.more summary`);
await ann.click(`${annComment} .under details.more a[href^="#edit"]`);
await ann.$eval(`${annComment} div.edit textarea`, (t) => { t.value = "Looks great, Bob! Where was it?"; });
await Promise.all([settled(ann), ann.click(`${annComment} div.edit button`)]);
check("…changed on Bob's site, keeping what it said before", (await threadOn(bob, `${B}/posts/${bobPostId}`)).comments[0]?.text === "Looks great, Bob! Where was it?"
  && (await bob.$eval("article.card .comment details.edited", (d) => d.textContent).catch(() => "")).includes("Looks great, Bob!"));
check("…and in Ann's own copy", sql(stateA, "SELECT kind FROM sent").some((r) => r.kind === "edit"));
check("Ann sees it Edited, with what it said before", (await threadOn(ann, bobsPostPage)).comments[0]?.text === "Looks great, Bob! Where was it?"
  && (await ann.$eval(`${annComment} details.edited`, (d) => d.textContent).catch(() => "")).includes("Looks great, Bob!"));
// Bob replies on his own site, while Ann has his post open; she sees it, and can't delete it, or change her own any more.
await ann.goto(bobsPostPage);
await bob.goto(`${B}/posts/${bobPostId}`);
await bob.type("article.card .say textarea", "Thanks Ann");
await Promise.all([settled(bob), bob.click("article.card .say button")]);
check("Bob's site sends Ann his reply, signed, with its receipt, and her site keeps it", await waitFor(() =>
  sql(stateA, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'comment' AND own = 0 AND text = 'Thanks Ann'")[0].n === 1));
await ann.evaluate(() => window.afterwrdLive.check());
check("…and her open page quietly offers it", (await ann.$eval(".live-bar span", (s) => s.textContent).catch(() => "")) === "1 new comment");
annFeed = [await threadOn(ann, bobsPostPage)];
check("Ann sees Bob's reply, not deletable by her", annFeed[0].comments.map((c) => c.text).join("|") === "Looks great, Bob! Where was it?|Thanks Ann"
  && !annFeed[0].comments[1].canDelete, JSON.stringify(annFeed[0].comments));
check("once Bob has replied, Ann can't change her comment", !(await ann.$(`${annComment} div.edit`)));
await ann.goto(`${A}/activity`);
check("…on her Notifications: Bob replied on his post", (await ann.$eval("main", (m) => m.innerText)).includes("Bob Example replied on their post")
  && Boolean(await ann.$(`main a[href="/friend/${bobPostOnA().connection_id}/posts/${bobPostId}"]`)));
await ann.goto(bobsPostPage);
// What Ann's browser could still try to sign: a late edit, and changing Bob's words. Bob's site refuses both.
const signAndSend = (page, url, fields, text) => page.evaluate(async (url, fields, text) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const doc = new DOMParser().parseFromString(await (await fetch(location.pathname)).text(), "text/html");
  const d = doc.querySelector("form.say").dataset;
  const key = await savedKey();
  const made = await makeRecord({ kind: "edit", author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null, ...fields }, { text }, key);
  return (await fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ sent: JSON.stringify(made.sent), back: "/" }) })).status;
}, url, fields, text);
const relay = `/_admin/friend/${bobPostOnA().connection_id}/items/${bobPostId}/records`;
const annsFp = (await ann.$$eval("article.from-friend .comment:not(.gone)", (l) => l.map((c) => c.id.slice(2))))[0];
const bobsFp = (await ann.$$eval("article.from-friend .comment:not(.gone)", (l) => l.map((c) => c.id.slice(2))))[1];
check("…a late edit is refused by Bob's site", (await signAndSend(ann, relay, { about: annsFp }, "changed after Bob replied")) === 400
  && (await threadOn(bob, `${B}/posts/${bobPostId}`)).comments[0].text === "Looks great, Bob! Where was it?");
await ann.goto(bobsPostPage);
check("…and so is changing Bob's comment", (await signAndSend(ann, relay, { about: bobsFp }, "words Bob never wrote")) === 400
  && (await threadOn(bob, `${B}/posts/${bobPostId}`)).comments[1].text === "Thanks Ann");
// (Bob's site telling Ann's about his reply, and her Notifications, come with step 4c.)

// A host that changes what someone wrote, or drops it, is caught (lists.js checkList): Bob's site's database edited by
// hand, as whoever runs it could.
const bobPages = sql(stateB, `SELECT page, entries FROM list_pages WHERE list = '${bobPostId}'`);
const tampered = JSON.parse(bobPages[0].entries);
const annsEntry = tampered.find((e) => e.fp === annsFp);
const wasContent = annsEntry.sent.content;
annsEntry.sent.content = Buffer.from(JSON.stringify({ text: "Ann never said this" })).toString("base64url");
sql(stateB, `UPDATE list_pages SET entries = '${JSON.stringify(tampered).replace(/'/g, "''")}' WHERE list = '${bobPostId}' AND page = 0`);
await ann.goto(bobsPostPage);
check("words changed by Bob's site fail their check on Ann's, and aren't shown", (await ann.$$eval("article.from-friend .comment.gone", (l) => l.map((c) => c.textContent)))
  .some((t) => t.includes("didn't pass its check")) && !(await ann.$eval("article.from-friend", (a) => a.textContent)).includes("Ann never said this"));
annsEntry.sent.content = wasContent;
const dropped = tampered.filter((e) => e.fp !== annsFp);
sql(stateB, `UPDATE list_pages SET entries = '${JSON.stringify(dropped).replace(/'/g, "''")}' WHERE list = '${bobPostId}' AND page = 0`);
await ann.goto(bobsPostPage);
check("a comment dropped by Bob's site: Ann's says the conversation doesn't add up", (await ann.$eval("article.from-friend .notice.alert", (n) => n.textContent).catch(() => ""))
  .includes("doesn't add up"));
sql(stateB, `UPDATE list_pages SET entries = '${bobPages[0].entries.replace(/'/g, "''")}' WHERE list = '${bobPostId}' AND page = 0`);
await ann.goto(bobsPostPage);
check("…and with it put back, all's well again", !(await ann.$("article.from-friend .notice.alert")) && (await feedCards(ann))[0].comments.length === 2);

// Ann deletes her comment.
await ann.click(`${annComment} .under details.more summary`);
await Promise.all([settled(ann), ann.click(`${annComment} .under .delete`)]);
check("Ann's comment deleted on Bob's site, its words gone, a marker left", (await threadOn(bob, `${B}/posts/${bobPostId}`)).comments.map((c) => c.text).join("|") === "Thanks Ann"
  && (await bob.$eval("article.card .comment.gone", (c) => c.textContent).catch(() => "")).includes("deleted")
  && !sql(stateB, `SELECT entries FROM list_pages WHERE list = '${bobPostId}'`)[0].entries.includes(wasContent));

// Step 7a (sentchecks.js): Ann's site checks, in the background, what became of what she sent to Bob's posts. Here a
// "day" of its schedule is 8 seconds (TEST_SENT_SECONDS on Ann's site), and a round runs at most that often, from Home.
const SENT_DAY = 8;
const annPerson = sql(stateA, "SELECT person FROM own_identity")[0].person;
const bobPerson = sql(stateB, "SELECT person FROM own_identity")[0].person;
// A record signed in a browser, from the open post's comment form (its list point and the writer's newest record).
const signHere = (page, fields, content) => page.evaluate(async (fields, content) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const d = document.querySelector("form.say").dataset;
  const key = await savedKey();
  return makeRecord({ author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null, ...fields }, content, key);
}, fields, content);
const annSays = async (text) => {
  await ann.goto(bobsPostPage);
  await ann.type("article.from-friend .say textarea", text);
  await Promise.all([settled(ann), ann.click("article.from-friend .say button")]);
  return sql(stateA, `SELECT fp FROM sent WHERE kind = 'comment' ORDER BY created_at DESC, rowid DESC LIMIT 1`)[0].fp;
};
// A round of checks: Ann opens Home once the schedule says they're due (her rows' next_at, on her site's clock).
const roundUntil = async (test, ms = 40_000) => waitFor(async () => {
  await ann.goto(`${A}/`);
  await new Promise((r) => setTimeout(r, 1500));
  return test();
}, ms);
const checked = await annSays("Checked later");
check("Ann's site keeps her comment to check, from a day on", sql(stateA, `SELECT state, next_at, created_at FROM sent WHERE fp = '${checked}'`)
  .some((r) => r.state === null && r.next_at === r.created_at + SENT_DAY));
check("Bob's site indexes it by writer", sql(stateB, `SELECT author, list FROM authored WHERE fp = '${checked}'`).some((r) => r.author === annPerson && r.list === bobPostId));
check("…but not his own records on his own posts", sql(stateB, `SELECT COUNT(*) AS n FROM authored WHERE author = '${bobPerson}'`)[0].n === 0);
check("only a friend's site may ask what became of records", (await fetch(`${B}/_p/records/check`, { method: "POST", headers: { "Afterwrd-From": A },
  body: JSON.stringify({ points: [{ fp: checked, list: bobPostId }] }) })).status === 401);
const askedBob = await (await siteCall(stateA, A, `${B}/_p/records/check`, { points: [{ fp: checked, list: bobPostId }, { fp: bobPostId, list: bobPostId }] })).json();
check("…and Bob's site says Ann's is there, and Bob's own post isn't hers to ask about",
  askedBob.results?.[0]?.state === "there" && askedBob.results?.[1]?.state === "missing", JSON.stringify(askedBob.results));
// Bob removes it, signed in his browser (his site, as host, may).
await bob.goto(`${B}/posts/${bobPostId}`);
const removal = await signHere(bob, { kind: "remove", about: checked }, undefined);
check("Bob removes Ann's comment", (await bob.evaluate(async (url, sent) => (await fetch(url, { method: "POST", redirect: "manual",
  body: new URLSearchParams({ sent: JSON.stringify(sent), back: location.pathname }) })).type, `/_admin/items/${bobPostId}/records`, removal.sent)) === "opaqueredirect");
check("…and his site's index no longer says whose it was", sql(stateB, `SELECT author FROM authored WHERE fp = '${checked}'`)[0]?.author === null);
check("Ann's site finds out at its next round, from Bob's signed removal", await roundUntil(() =>
  sql(stateA, `SELECT state, removed_by FROM sent WHERE fp = '${checked}'`).some((r) => r.state === "removed" && r.removed_by === bobPerson)));
await ann.goto(`${A}/activity`);
const annActivity = await ann.$eval("main", (m) => m.innerText);
check("…and her Notifications say so, with what she wrote", annActivity.includes("Bob Example removed your comment on Bob Example's post")
  && annActivity.includes("Checked later"), annActivity.slice(0, 300));
check("…once only, and it's no longer asked about", sql(stateA, `SELECT COUNT(*) AS n FROM notices WHERE kind = 'removed'`)[0].n === 1
  && sql(stateA, `SELECT next_at FROM sent WHERE fp = '${checked}'`)[0].next_at === null);
// Bob's site drops one of Ann's comments with nothing signed saying why, as whoever runs it could by hand.
const vanishing = await annSays("Will vanish");
const pagesBefore = sql(stateB, `SELECT page, entries FROM list_pages WHERE list = '${bobPostId}'`);
const lastPage = pagesBefore.at(-1);
sql(stateB, `UPDATE list_pages SET entries = '${JSON.stringify(JSON.parse(lastPage.entries).filter((e) => e.fp !== vanishing)).replace(/'/g, "''")}'
  WHERE list = '${bobPostId}' AND page = ${lastPage.page}`);
check("a comment Bob's site drops is found missing at Ann's next round", await roundUntil(() =>
  sql(stateA, `SELECT state FROM sent WHERE fp = '${vanishing}'`).some((r) => r.state === "missing")));
await ann.goto(`${A}/activity`);
check("…and her Notifications say his site left it out", (await ann.$eval("main", (m) => m.innerText)).includes("Your comment on Bob Example's post is missing"));
sql(stateB, `UPDATE list_pages SET entries = '${lastPage.entries.replace(/'/g, "''")}' WHERE list = '${bobPostId}' AND page = ${lastPage.page}`);
// A delete Bob's site doesn't take (here, it can't be reached) is kept, said on Home, and sent again until it's taken.
const keep = await annSays("Delete me later");
const bobOrigin = sql(stateA, `SELECT origin FROM connections WHERE identity = '${bobPerson}'`)[0].origin;
await ann.goto(bobsPostPage);
sql(stateA, `UPDATE connections SET origin = 'http://localhost:8799' WHERE identity = '${bobPerson}'`);
await ann.click(`#c-${keep} .under details.more summary`);
await Promise.all([settled(ann), ann.click(`#c-${keep} .under .delete`)]);
check("a delete Bob's site can't take is kept to send again", sql(stateA, "SELECT state FROM sent WHERE kind = 'delete' ORDER BY created_at DESC LIMIT 1")
  .some((r) => r.state === "waiting"));
sql(stateA, "UPDATE connections SET items_checked_at = " + Math.floor(Date.now() / 1000) + ` WHERE identity = '${bobPerson}'`); // no pull meanwhile
await ann.goto(`${A}/`);
check("…and Home says so", (await ann.$eval("main", (m) => m.innerText)).includes("hasn't taken your delete"));
sql(stateA, `UPDATE connections SET origin = '${bobOrigin}' WHERE identity = '${bobPerson}'`);
check("…sent again at the next round, and taken", await roundUntil(() =>
  sql(stateA, "SELECT state FROM sent WHERE kind = 'delete' ORDER BY created_at DESC LIMIT 1").some((r) => r.state === null)
  && !(sql(stateB, `SELECT entries FROM list_pages WHERE list = '${bobPostId}'`).map((p) => p.entries).join("")).includes("Delete me later")));
await ann.goto(`${A}/`);
check("…and Home no longer says so", !(await ann.$eval("main", (m) => m.innerText)).includes("hasn't taken your delete"));
// Something signed as Ann that her site never sent (a stolen key used elsewhere, T6): here, signed in her browser and
// sent straight to Bob's site.
await ann.goto(bobsPostPage);
const stolen = await signHere(ann, { kind: "comment" }, { text: "Not from Ann's site" });
const annDelegation = sql(stateA, "SELECT bytes, proof FROM delegations ORDER BY expires_at DESC LIMIT 1")[0];
check("…a comment signed with Ann's key but sent around her site is taken by Bob's", (await siteCall(stateA, A, `${B}/_p/records`,
  { sent: stolen.sent, delegation: { bytes: annDelegation.bytes, proof: JSON.parse(annDelegation.proof) } })).status === 200);
await new Promise((r) => setTimeout(r, (SENT_DAY + 1) * 1000));
sql(stateA, `UPDATE connections SET items_checked_at = 0 WHERE identity = '${bobPerson}'`);
check("Ann's site finds it at its next pull from Bob's", await roundUntil(() =>
  sql(stateA, `SELECT COUNT(*) AS n FROM notices WHERE kind = 'forged' AND fp = '${stolen.fp}'`)[0].n === 1));
await ann.goto(`${A}/`);
check("…and Home says something was signed as her that her site didn't send", (await ann.$eval("main", (m) => m.innerText))
  .includes("Something signed as you appeared on Bob Example's post"));
await Promise.all([settled(ann), ann.click("form[action='/_admin/notices/dismiss'] button")]);
await ann.goto(`${A}/`);
check("…until she clears it", !(await ann.$eval("main", (m) => m.innerText)).includes("Something signed as you"));
// Tidy: Bob removes it, so what follows sees Ann's comments as before.
await bob.goto(`${B}/posts/${bobPostId}`);
const tidy = await signHere(bob, { kind: "remove", about: stolen.fp }, undefined);
await bob.evaluate(async (url, sent) => fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ sent: JSON.stringify(sent), back: location.pathname }) }),
  `/_admin/items/${bobPostId}/records`, tidy.sent);

// What a friend's site can and can't reach: only signed calls, and only what's shared.
const fromAnn = (path, body = null, options = {}) => siteCall(stateA, A, B + path, body, options);
check("an unsigned call gets nothing", (await fetch(`${B}/_p/items`)).status === 401
  && (await fetch(`${B}/_p/items`, { headers: { "Afterwrd-From": A } })).status === 401
  && (await fetch(`${B}/_p/posts`, { headers: { "Afterwrd-From": A } })).status === 401);
check("…nor does one sent again after 5 minutes", (await fromAnn("/_p/items", null, { at: Math.floor(Date.now() / 1000) - 400 })).status === 401);
check("…nor one signed by Ann's site but claiming to be from another", (await fromAnn("/_p/items", null, { headers: { "Afterwrd-From": C } })).status === 401);
check("the old routes between friends are gone", ![200, 202].includes((await fetch(`${B}/_peer/feed`, { redirect: "manual" })).status)
  && ![200, 202].includes((await fromAnn("/_peer/comments", { type: "Note", content: "x" })).status));
// A post Bob wrote before posts were signed is his alone, until it's turned into a signed post (step 10).
const oldKey = `post-${Math.floor(Date.now() / 1000) - 86400}-0badc0de`;
sql(stateB, `INSERT INTO posts (key, source, created_at, text, audience) VALUES ('${oldKey}', 'afterwrd', ${Math.floor(Date.now() / 1000) - 86400}, 'Written before signing', 'friends')`);
check("friends can't see a post written before signing", (await fromAnn(`/_p/posts/${oldKey}`)).status === 404
  && !JSON.stringify(await (await fromAnn("/_p/posts")).json()).includes("Written before signing"));
await bob.goto(`${B}/posts/${oldKey}`);
check("…which Bob sees, read-only, saying only he can see it", (await bob.$eval("main", (m) => m.textContent)).includes("Only you can see this for now")
  && !(await bob.$(`article#p-${oldKey} form`)) && !(await bob.$(`article#p-${oldKey} details.more`)));
sql(stateB, `DELETE FROM posts WHERE key = '${oldKey}'`);
// With his Facebook photos not shared, a photo from them can't be seen, even by fingerprint.
const sharedBefore = sql(stateB, "SELECT value FROM settings WHERE key = 'sections'")[0]?.value ?? "[]";
sql(stateB, `INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '[]')`);
const unshared = sql(stateB, `SELECT hash FROM media WHERE hash IS NOT NULL AND source = 'facebook'
  AND hash NOT IN (SELECT hash FROM media WHERE source = 'afterwrd' AND hash IS NOT NULL) LIMIT 1`)[0]?.hash;
check("a photo Bob hasn't shared can't be fetched by its fingerprint", Boolean(unshared) && (await fromAnn(`/_p/photos/${unshared}`)).status === 404, unshared);
sql(stateB, `INSERT OR REPLACE INTO settings (key, value) VALUES ('sections', '${sharedBefore.replace(/'/g, "''")}')`);
check("…but can once his photos are shared", (await fromAnn(`/_p/photos/${unshared}`)).status === 200);
check("a used Connect link is refused", (await (await browser.createBrowserContext()).newPage().then(async (p) => (await p.goto(link)).status())) === 404);

// Bob, connected to Ann, can't pass himself off as Ann to a third site.
const cara = await owner(C, "Cara Example");
await cara.goto(`${C}/_admin/connections`);
await cara.click("#make");
await cara.waitForSelector("#link:not([hidden])");
const caraToken = (await cara.$eval("#link-url", (i) => i.value)).split("/_connect/")[1];
// His site signs the call, but says it's from Ann's: Cara's site finds Ann's identity at Ann's address, and it isn't his.
const forged = await siteCall(stateB, A, `${C}/_connect/${caraToken}/accept`, {});
check("a connected site can't impersonate another to a third", forged.status === 400 && sql(stateC, "SELECT COUNT(*) AS n FROM connections")[0].n === 0,
  `${forged.status} ${(await forged.text()).slice(0, 80)}`);
check("…and the link is still usable by the real friend", (await (await browser.createBrowserContext()).newPage().then(async (p) => (await p.goto(`${C}/_connect/${caraToken}`)).status())) === 200);
const unsigned = await fetch(`${C}/_connect/${caraToken}/accept`, { method: "POST", headers: { "Content-Type": "application/json", "Afterwrd-From": B }, body: "{}" });
check("…nor can anyone ask without signing", unsigned.status === 400 && sql(stateC, "SELECT COUNT(*) AS n FROM connections")[0].n === 0);

// Ann reads Bob's posts and photos without leaving her own site.
const bobId = sql(stateA, "SELECT id FROM connections")[0].id;

// Ann asks Bob to check her site: his Home shows it, and one tap makes the link to send her (checks.js).
const annIdOnB = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
const makeLinkAsBob = () => bob.evaluate((id) => fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connection: id }) }).then((r) => r.status), annIdOnB);
await bob.goto(`${B}/`);
check("a friend's site can't make a check link for someone who didn't ask", (await makeLinkAsBob()) === 409);
await ann.goto(`${A}/_admin/update`);
await ann.$eval("#checks-more", (d) => { d.open = true; }); // asking by hand is folded away
await ann.$eval("#ask-other", (d) => { d.open = true; });
await ann.click("#ask-check");
const askMessage = await ann.$eval("#ask-message", (t) => t.value);
check("for anyone else, Update writes a message naming this site", askMessage.includes("localhost:8787")
  && askMessage.includes("(or just my address)") && await ann.$eval("#ask-panel", (p) => !p.hidden), askMessage);
await ann.click(`button[data-ask="${bobId}"]`);
await ann.waitForFunction(() => document.getElementById("ask-result").textContent, { timeout: 10_000 });
const asked = await ann.$eval("#ask-result", (p) => p.textContent);
check("Update has a button to ask each friend, which sends Bob's site the request", asked.startsWith("Asked Bob Example.")
  && sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 1, asked);
await bob.goto(`${B}/`);
const request = await bob.$eval(".check-request", (d) => d.textContent.replace(/\s+/g, " ")).catch(() => "");
check("Bob's Home shows Ann's request", request.includes("Ann Example asks you to check their afterwrd site"), request);
await bob.click(".check-request button[data-check-request]");
await bob.waitForFunction(() => document.querySelector(".check-request")?.dataset.message, { timeout: 10_000 });
const sent = await bob.$eval(".check-request", (d) => d.dataset.message);
const checkLink = /http\S+\/_check\/[\w-]{43}/.exec(sent)?.[0] ?? "";
check("one tap makes a check link on Bob's site, in a message to send her", checkLink.startsWith(`${B}/_check/`) && sent.includes("as you asked")
  && await bob.$eval(".check-share", (s) => !s.hidden), sent);
check("…and the request is done with", sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 0
  && (await bob.goto(`${B}/`), (await bob.$(".check-request")) === null));
await ann.goto(checkLink);
const checkPage = await ann.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
check("Ann opens it: Bob's site, ready to check her site and only hers", checkPage.includes("Bob Example would like to check your site")
  && checkPage.includes("Your site: localhost:8787") && (await ann.$("input[name=site]")) === null, checkPage.slice(0, 300));
await ann.goto(`${A}/_admin/update#checks-more`); // asking by hand is folded away; the link opens it
await ann.click(`button[data-ask="${bobId}"]`);
await ann.waitForFunction(() => document.getElementById("ask-result").textContent, { timeout: 10_000 });
await bob.goto(`${B}/`);
await Promise.all([settled(bob), bob.click(".check-request form button")]);
check("\"Not now\" puts a request away", (await bob.$(".check-request")) === null && sql(stateB, "SELECT COUNT(*) AS n FROM check_requests")[0].n === 0);
check("only a friend's site can ask for a check", (await fetch(`${B}/_p/check-request`, { method: "POST",
  headers: { "Afterwrd-From": A, "Content-Type": "application/json" }, body: JSON.stringify({ type: "CheckRequest" }) })).status === 401);
await ann.goto(`${A}/`);
await Promise.all([ann.waitForNavigation(), ann.click("article.from-friend header .what a")]);
check("Bob's name on Home opens his page on Ann's site", ann.url() === `${A}/friend/${bobId}/posts`, ann.url());
const bobsPosts = await ann.$$eval("main article.card .text", (l) => l.map((t) => t.textContent));
check("his imported posts are there too", bobsPosts.includes("Hello from the installer test") && bobsPosts.includes("Bob's holiday"),
  bobsPosts.join("|") || (await ann.$eval("main", (m) => m.innerText.slice(0, 300))));
await ann.goto(`${A}/friend/${bobId}/photos`);
const bobAlbums = await ann.$$eval(".albums a.album", (l) => l.map((a) => ({ href: a.getAttribute("href"), name: a.querySelector("strong").textContent })));
check("his albums are listed", bobAlbums.some((a) => a.name === "Posted on afterwrd") && bobAlbums.some((a) => a.name === "Other photos"), bobAlbums.map((a) => a.name).join());
await ann.goto(A + bobAlbums.find((a) => a.name === "Other photos").href);
const photoTile = await ann.$eval(".justified a.tile", (a) => a.getAttribute("href"));
await ann.goto(A + photoTile);
await ann.waitForFunction(() => document.querySelector(".stage img")?.complete, { timeout: 15_000 });
const full = await ann.$eval(".stage img", (i) => ({ w: i.naturalWidth, src: i.getAttribute("src") }));
check("a photo opens on Ann's site, full size, from Bob's", full.w === 1200 && full.src.startsWith(`${B}/files/`), full.src.slice(0, 60));
check("…with no comment box: it's from his Facebook download", Boolean(await ann.$(".info")) && !(await ann.$(".info .say")));
const fullSrc = full.src;
// afterwrd 2: a photo Bob posted is an item of its own, with its own comments, opened from his post.
const ownTile = `/friend/${bobId}/posts/${bobPostId}/photos/1`;
await ann.goto(A + ownTile);
await ann.type(".info .say textarea", "What a view");
await Promise.all([settled(ann), ann.click(".info .say button")]);
check("Ann comments on a photo Bob posted, from her site", new URL(ann.url()).pathname === ownTile
  && (await ann.$$eval(".info section.thread .comment:not(.gone)", (l) => l.map((c) => ({ t: c.querySelector(".said").textContent, d: Boolean(c.querySelector(".under .delete")) }))))
    .some((c) => c.t === "What a view" && c.d));
check("…kept on Bob's site against that photo", sql(stateB, "SELECT comments FROM items WHERE type = 'photo' ORDER BY created_at LIMIT 1")[0]?.comments === 1);
// Opened from his album instead, it's the same photo page: its signed comments are there.
await ann.goto(A + bobAlbums.find((a) => a.name === "Posted on afterwrd").href);
await Promise.all([ann.waitForNavigation(), ann.click(".justified a.tile")]);
check("a photo Bob posted, opened from his album, opens on its own page, with its signed comments",
  /^\/friend\/\d+\/posts\/[\w-]{43}\/photos\/\d+$/.test(new URL(ann.url()).pathname)
  && (await ann.$$eval(".info section.thread .comment:not(.gone) .said", (l) => l.map((x) => x.textContent))).length >= 1
  && (await ann.$eval("#close", (a) => a.getAttribute("href"))).startsWith(`/friend/${bobId}/photos/album/`), ann.url());
await ann.screenshot({ path: `${OUT}/friend-photo.png` });
await ann.goto(`${A}/friend/${bobId}/posts`);
await ann.screenshot({ path: `${OUT}/friend-posts.png`, fullPage: true });
await ann.goto(`${A}/friend/${bobId}/photos`);
await ann.screenshot({ path: `${OUT}/friend-photos.png` });
const signed = fullSrc;
check("the signed link works without signing in", (await fetch(signed)).status === 200);
check("a tampered link doesn't", (await fetch(signed.replace(/sig=(.)/, (_, c) => `sig=${c === "A" ? "B" : "A"}`))).status === 403);
check("nor an expired one", (await fetch(signed.replace(/exp=\d+/, "exp=1000"))).status === 403);
// A friend's photo link lasts to the end of the next day (UTC), and is for that friend only (share.js signedFile),
// in the same shape older sites check for (friends.js signedLink).
const linkExp = Number(/exp=(\d+)/.exec(signed)?.[1]);
const secondsNow = Math.floor(Date.now() / 1000);
check("a friend's photo link runs to the end of the next day", linkExp % 86400 === 0 && linkExp - secondsNow > 86400 - 60
  && linkExp - secondsNow <= 2 * 86400, signed);
check("…in the shape every site accepts", /\?exp=\d{1,12}&sig=[\w-]{43}$/.test(signed), signed);
check("…and one stretched past that is refused", (await fetch(signed.replace(/exp=\d+/, `exp=${linkExp + 86400}`))).status === 403);
check("files without a link still need signing in", (await fetch(signed.split("?")[0], { redirect: "manual" })).status === 302);
check("only Ann (the owner) can open friend pages", (await (await fetch(`${A}/friend/${bobId}/posts`, { redirect: "manual" })).status) === 302);

// One Friends list: friends on afterwrd, linked (when Ann says so) to who they are in her Facebook download.
check("Ann re-imports with her Facebook friends list", !(await importZip(ann, A, zipPath.replace(/fake-export\.zip$/, "friends-export.zip"),
  ["posts", "photos", "friends"])));
await ann.goto(`${A}/posts`);
const annMenu = await ann.$$eval("header.site nav.main a", (l) => l.map((a) => a.querySelector("span").textContent));
check("with Facebook sections published, Memories appears in her menu", Boolean(await ann.$('header.site .menu a[href="/memories"]')));
await ann.goto(`${A}/memories`);
check("Memories gathers the Facebook sections", (await ann.$$eval(".memory-tiles strong", (l) => l.map((s) => s.textContent))).join() === "Facebook friends");
await ann.goto(`${A}/posts`);
check("the owner has one Friends in the menu", annMenu.filter((l) => l === "Friends").length === 1, annMenu.join());
await Promise.all([ann.waitForNavigation(), ann.click('header.site nav.main a[href="/friend"]')]);
const friendsText = () => ann.$eval("main", (m) => m.innerText);
check("Friends lists Bob on afterwrd, and suggests his Facebook self", (await friendsText()).includes("Is this Bob Example from your Facebook download?"));
const fbRow = (name) => ann.$$eval("#fb-people tbody tr", (rows, n) => rows.find((r) => r.cells[0].textContent === n)?.cells[2].textContent.trim(), name);
check("…and everyone from Facebook below, with an Invite button", (await fbRow("John Smith")) === "Invite" && (await fbRow("Bob Example")) === "Invite");
await Promise.all([ann.waitForNavigation(), ann.click(".fb-link button.chip:not([name])")]);
check("Yes links them", (await friendsText()).includes("On Facebook as Bob Example") && (await fbRow("Bob Example")) === "On afterwrd");
await ann.goto(`${A}/friend/${bobId}/posts`);
const history = await ann.$eval('.feed-head a[href^="/people/"]', (a) => a.getAttribute("href")).catch(() => null);
check("Bob's page offers your Facebook history together", Boolean(history));
await ann.goto(A + history);
check("…which is his page from the download", (await ann.$eval("h1", (h) => h.textContent)) === "Bob Example");
await ann.goto(`${A}/friend`);
await Promise.all([ann.waitForNavigation(), ann.click(".fb-link button.link")]);
check("Unlink undoes it (and the suggestion comes back)", (await friendsText()).includes("Is this Bob Example"));
await Promise.all([ann.waitForNavigation(), ann.click('.fb-link button[name="none"]')]);
check("No stops suggesting it", !(await friendsText()).includes("Is this Bob Example") && Boolean(await ann.$(".fb-pick")));
await ann.click(".fb-pick summary");
await ann.type('.fb-pick input[name="name"]', "John Smith");
await Promise.all([ann.waitForNavigation(), ann.click(".fb-pick button")]);
check("a different name can be picked by hand", (await friendsText()).includes("On Facebook as John Smith") && (await fbRow("John Smith")) === "On afterwrd");
check("a name that isn't in the download isn't linked", await (async () => {
  await ann.goto(`${A}/friend`);
  await ann.click(".fb-link button.link").then(() => ann.waitForNavigation());
  await ann.$eval('.fb-link input[name="name"]', (i) => { i.value = "Nobody Atall"; }).catch(() => {});
  return true;
})() && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links WHERE person_name = 'Nobody Atall'")[0].n === 0);
await ann.screenshot({ path: `${OUT}/friends.png`, fullPage: true });

// Friends read each other from their own sites; the old ways of coming in to the other's site are gone.
check("no friend sign-in any more", (await fetch(`${B}/_auth/friend?ticket=${"x".repeat(43)}`)).status === 404);
check("the sign-in page offers only passkeys", !(await (await fetch(`${B}/_auth/login`)).text()).includes("Connected friend"));
await ann.goto(`${A}/_admin/connections`);
check("Connections has no Visit button", !(await ann.$('a[href^="/_feed/visit"]')));
check("…and the old Visit link is gone", (await ann.goto(`${A}/_feed/visit?to=${encodeURIComponent(B)}`)).status() === 404);

// Download everything, on both sites: Ann's copy of her comment and Bob's copy share one address.
await ann.goto(bobsPostPage);
await ann.type("article.from-friend .say textarea", "Kept forever");
await Promise.all([settled(ann), ann.click("article.from-friend .say button")]);
async function download(page, site, label) {
  const dir = `${OUT}/downloads/${label}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Headless Chrome never finishes saving downloads, so keep the zip the page hands to the browser.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__download = blob; return make(blob); };
  });
  await page.goto(`${site}/_admin/export`);
  await page.waitForFunction(() => document.getElementById("size").textContent !== "", { timeout: 10_000 }).catch(() => {});
  await page.click("#go");
  await page.waitForFunction(() => /Done/.test(document.getElementById("status").textContent) || document.getElementById("error").textContent,
    { timeout: 120_000, polling: 500 });
  const problem = await page.$eval("#error", (e) => e.textContent);
  const base64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await window.__download.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  const zipFile = `${dir}/download.zip`;
  writeFileSync(zipFile, Buffer.from(base64, "base64"));
  const list = execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" }).trim().split("\n");
  const read = (name) => execFileSync("unzip", ["-p", zipFile, list.find((f) => f.endsWith(`/${name}`))], { maxBuffer: 1e8 });
  return { problem, list, read, json: (name) => JSON.parse(read(name).toString()) };
}
const annZip = await download(ann, A, "ann");
const bobZip = await download(bob, B, "bob");
check("both downloads finish", !annZip.problem && !bobZip.problem, annZip.problem || bobZip.problem);
check("download has the documents and a README", ["README.txt", "profile.json", "posts.json", "photos.json", "albums.json",
  "comments-elsewhere.json", "connections.json", "facebook-comments.json"].every((f) => annZip.list.some((x) => x.endsWith(`/${f}`))));
const elsewhere = annZip.json("comments-elsewhere.json").orderedItems.find((c) => c.content === "Kept forever");
const bobPosts = bobZip.json("posts.json");
const fromB64 = (text) => { try { return JSON.parse(Buffer.from(text, "base64url").toString()); } catch { return null; } };
const bobsNote = bobPosts.orderedItems.find((n) => n.content === "Bob's holiday");
const reply = bobsNote?.replies?.items.find((c) => c.content === "Kept forever");
check("Ann's copy and Bob's copy of her comment share one address", Boolean(elsewhere && reply && elsewhere.id === reply.id
  && elsewhere.inReplyTo === bobsNote.id && reply.inReplyTo === bobsNote.id), elsewhere?.id);
check("Bob's copy says it's from Ann's site", reply?.attributedTo?.id === `${A}/` && reply?.attributedTo?.name === "Ann Example");
check("posts are ActivityStreams Notes with permanent addresses", bobPosts["@context"][0] === "https://www.w3.org/ns/activitystreams"
  && bobPosts.orderedItems.every((n) => n.type === "Note" && /^\/posts\/(post-\d+-[0-9a-f]{8}|[\w-]{43})$/.test(n.id.slice(B.length))));
// afterwrd 2: what proves it, in each download (signed.json): Bob's post's list, with Ann's signed comment in it as
// she signed it, and Ann's own record of sending it, with Bob's site's receipt.
const bobSigned = bobZip.json("signed.json");
const annSigned = annZip.json("signed.json");
const annSent = annSigned["afterwrd:sent"].find((x) => x.kind === "comment" && fromB64(x.sent.content)?.text === "Kept forever");
check("Ann's download has her signed comment, with Bob's site's receipt", Boolean(annSent?.receipt?.sig), JSON.stringify(annSent ?? {}).slice(0, 120));
check("…and Bob's has the very same record in his post's list", bobSigned["afterwrd:lists"].some((l) => l.entries.some((e) => e.fp === annSent?.fp && e.sent?.record === annSent?.sent.record)));
check("…and both have their identities (keys only)", Boolean(annSigned["afterwrd:identity"].chain.length && bobSigned["afterwrd:identity"].chain.length)
  && !JSON.stringify(annSigned).includes("Ann Example"));
check("afterwrd posts and imported posts are told apart", bobsNote?.["afterwrd:source"] === "afterwrd"
  && bobPosts.orderedItems.some((n) => n["afterwrd:source"] === "facebook"));
const photo = bobsNote.attachment.find((a) => a.type === "Image");
const stored = bobZip.read(photo["afterwrd:file"]);
check("photos are in the zip, matching their fingerprint", createHash("sha256").update(stored).digest("hex") === photo.url.split("/files/")[1]);
check("photo addresses lead to the photo", (await (await fetch(photo.id, { redirect: "manual",
  headers: { Cookie: `__Host-session=${(await bob.cookies()).find((c) => c.name === "__Host-session").value}` } })).headers.get("location") ?? "").match(/\/photos\/\d+$/));
const everything = annZip.list.filter((f) => f.endsWith(".json")).map((f) => annZip.read(f.split("/").pop()).toString()).join("");
const annHostingKey = sql(stateA, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value;
check("no keys in the download", !everything.includes(annHostingKey) && !everything.includes("hosting_key"));
check("Ann's connections list Bob by address", annZip.json("connections.json").orderedItems[0]?.id === `${B}/`);

// Bob changes a new post's words; Ann's Home shows it Edited, with what it said before, once her site asks his again
// (hourly, in the background, or whenever she opens his page: friendcopies.js).
await compose(bob, B, "Off to the coast");
await bob.goto(`${B}/posts`);
await bob.click("main article.card:first-of-type > header details.more summary");
await bob.click("main article.card:first-of-type > header details.more a[href^='#edit']");
await bob.$eval("main article.card:first-of-type > div.edit textarea", (t) => { t.value = "Off to the coast tomorrow"; });
await Promise.all([settled(bob), bob.click("main article.card:first-of-type > div.edit button")]);
const askAgain = () => sql(stateA, "UPDATE connections SET items_checked_at = 0");
askAgain();
await homeUntil(ann, A, (cards) => cards.some((c) => c.text === "Off to the coast tomorrow"));
const edited = await ann.$$eval("article.from-friend", (l) => l.map((a) => ({ text: a.querySelector(".text")?.textContent,
  was: a.querySelector(":scope > details.edited")?.textContent ?? "" })).find((p) => p.text === "Off to the coast tomorrow"));
check("Ann sees Bob's changed post, Edited, with what it said before", Boolean(edited) && edited.was.includes("Off to the coast"), JSON.stringify(edited));

// Asking for less (friendhost.js): Ann's site asks for Bob's posts changed since it last asked, in a signed call. Asked
// again, nothing; a new post, only that; a comment, only the post it's on; a deleted post, its id among those gone.
const asOf = () => Number(sql(stateA, "SELECT items_since FROM connections")[0].items_since ?? 0);
const annHosting = await crypto.subtle.importKey("pkcs8", Buffer.from(sql(stateA, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
  { name: "Ed25519" }, false, ["sign"]);
const ask = async (since) => {
  const url = `${B}/_p/items?since=${since}`;
  return (await fetch(url, { headers: await signCall({ method: "GET", url, person: annPerson, from: A, privateKey: annHosting }) })).json();
};
const tick = () => new Promise((r) => setTimeout(r, 1100)); // what's changed is told to the second
check("Ann's site keeps what Bob's posts are copied as of", asOf() > 0, String(asOf()));
// A change in the very second Ann's site last asked is sent again once that second is over (friendhost.js): so ask
// once more after it, and go on from what that says.
await tick();
let since = (await ask(asOf())).until;
const nothing = await ask(since);
check("…asked again, Bob's site has nothing new", nothing.items?.length === 0 && nothing.gone?.length === 0 && nothing.until === since, JSON.stringify(nothing).slice(0, 160));
await tick();
await compose(bob, B, "Back from the coast");
const newer = await ask(since);
check("once Bob posts, asked as of before it, his site sends only the new post", newer.items?.length === 1 && newer.items[0].content.text === "Back from the coast",
  JSON.stringify(newer).slice(0, 200));
askAgain();
const after = await homeUntil(ann, A, (cards) => cards.some((c) => c.text === "Back from the coast"));
check("…and Ann's Home shows it", after.some((c) => c.text === "Back from the coast"));
// Bob comments on his newest post, on his own site.
await tick();
since = newer.until;
await bob.goto(`${B}/posts`);
await bob.click("main article.card:first-of-type details.comments summary");
await bob.waitForSelector("main article.card:first-of-type .say textarea", { timeout: 10_000 });
await bob.type("main article.card:first-of-type .say textarea", "Lovely day for it");
await Promise.all([settled(bob), bob.click("main article.card:first-of-type .say button")]);
const commented = await ask(since);
check("a comment on one post sends only that post, now with comments", commented.items?.length === 1 && commented.items[0].content.text === "Back from the coast"
  && commented.items[0].comments === 1, JSON.stringify(commented).slice(0, 200));
// A post gone, deleted by Bob: among those gone, and gone from Ann's copy at her site's next ask.
await tick();
since = commented.until;
const goneId = commented.items[0].id;
await bob.goto(`${B}/posts`);
await bob.click("main article.card:first-of-type > header details.more summary");
await Promise.all([settled(bob), bob.click("main article.card:first-of-type > header .delete")]);
const deleted = await ask(since);
check("a post Bob deletes is among those gone", deleted.gone?.includes(goneId), JSON.stringify(deleted).slice(0, 200));
askAgain();
await homeUntil(ann, A, (cards) => !cards.some((c) => c.text === "Back from the coast"));
check("…and goes from Ann's copy", sql(stateA, `SELECT COUNT(*) AS n FROM copies WHERE id = '${goneId}'`)[0].n === 0);

// afterwrd 2 (identities.js): Ann's identity is public, with keys only; her name (her profile, signed in the
// background by her browser) goes only to a friend's site, in a call signed with that site's hosting key.
{
  const annName = sql(stateA, "SELECT name FROM users")[0].name;
  const published = await fetch(`${A}/.well-known/afterwrd`);
  const publishedText = await published.text();
  check("Ann's identity is public, with no name in it", published.status === 200 && JSON.parse(publishedText).chain.length >= 1
    && !publishedText.includes(annName) && !publishedText.includes("Ann"), publishedText.slice(0, 120));
  const kept = sql(stateA, "SELECT profile FROM own_identity")[0]?.profile;
  const said = kept && JSON.parse(Buffer.from(JSON.parse(kept).bytes, "base64url").toString());
  check("…and her profile, her name, was signed in the background by her browser", said?.name === annName && said.kind === "profile", kept);
  const bobPerson = sql(stateB, "SELECT person FROM own_identity")[0].person;
  const bobHosting = await crypto.subtle.importKey("pkcs8", Buffer.from(sql(stateB, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
    { name: "Ed25519" }, false, ["sign"]);
  const profileUrl = `${A}/_p/profile`;
  const signedByBob = await signCall({ method: "GET", url: profileUrl, person: bobPerson, from: B, privateKey: bobHosting });
  const fromBob = await fetch(profileUrl, { headers: signedByBob });
  const got = fromBob.status === 200 ? await fromBob.json() : null;
  check("Bob's site, signing its call, gets Ann's signed profile", got?.profile && JSON.parse(Buffer.from(got.profile.bytes, "base64url").toString()).name === annName,
    `${fromBob.status}`);
  check("…having checked Bob's identity at his own address", sql(stateA, `SELECT origin, origin_checked_at FROM identities WHERE person = '${bobPerson}'`)[0]?.origin === B
    && sql(stateA, `SELECT origin_checked_at FROM identities WHERE person = '${bobPerson}'`)[0].origin_checked_at > 0);
  check("an unsigned call from Bob's site gets nothing", (await fetch(profileUrl, { headers: { "Afterwrd-From": B } })).status === 401);
  check("…nor does a site that isn't Ann's friend, signed or not", (await fetch(profileUrl, { headers: { ...signedByBob, "Afterwrd-From": "http://localhost:8790" } })).status === 403
    && (await fetch(profileUrl)).status === 403);
  check("…nor Bob's signed call, sent again after 5 minutes", (await fetch(profileUrl, { headers: await signCall({ method: "GET", url: profileUrl, person: bobPerson, from: B,
    privateKey: bobHosting, at: Math.floor(Date.now() / 1000) - 400 }) })).status === 401);
}

// Phone view of the Feed, then disconnect.
await ann.setViewport({ width: 375, height: 800, isMobile: true });
await ann.goto(`${A}/`);
check("no sideways scrolling on a phone", await ann.evaluate(() => document.documentElement.scrollWidth <= 375));
await ann.screenshot({ path: `${OUT}/feed-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 900 });
await ann.goto(`${A}/_admin/connections`);
await ann.screenshot({ path: `${OUT}/connections.png` });
await Promise.all([ann.waitForNavigation(), ann.click("button[data-disconnect]")]);
check("Remove friend removes it on both sites", sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0
  && sql(stateB, "SELECT COUNT(*) AS n FROM connections")[0].n === 0);
check("Ann's site's signed calls get nothing from Bob's now", (await fromAnn("/_p/items?since=0")).status === 401);
check("…and so do Bob's photo links for Ann, at once", (await fetch(signed)).status === 403);
check("Ann keeps her copies of what she said after disconnecting (her signed records, with Bob's receipts)", sql(stateA, "SELECT COUNT(*) AS n FROM sent WHERE receipt IS NOT NULL")[0].n > 0);
check("disconnecting forgets who they were on Facebook", sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

// Ann invites Facebook friends to afterwrd. Zoe's invite is passed on to Cara, so Ann declines it; Cara's own is
// approved, and she's linked to her Facebook self.
await ann.goto(`${A}/friend`);
async function invite(name) {
  await ann.goto(`${A}/friend`);
  await ann.$$eval("#fb-people tbody tr", (rows, n) => rows.find((r) => r.cells[0].textContent === n).querySelector("button[data-invite]").click(), name);
  await ann.waitForFunction(() => document.getElementById("invite-message").value, { timeout: 10_000 });
  const message = await ann.$eval("#invite-message", (t) => t.value);
  return { message, link: message.match(/http\S+\/_connect\/[\w-]+/)?.[0] };
}
async function connectFrom(page, site, link) {
  await page.goto(link);
  await page.$eval("#site", (f) => { f.closest("details").open = true; }); // typing the address still works
  await page.type("#site input", site);
  await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
const zoe = await invite("Zoe Quinn");
await ann.screenshot({ path: `${OUT}/invite-panel.png` });
check("Invite gives a message to send, with a friend link", zoe.message.startsWith("Hi Zoe,") && zoe.message.endsWith(zoe.link) && Boolean(zoe.link), zoe.message);
const welcome = await (await browser.createBrowserContext()).newPage();
await welcome.goto(zoe.link);
const installHref = new URL(await welcome.$eval("#install", (a) => a.href));
const carried = new URLSearchParams(installHref.hash.slice(1));
check("the link's page offers to set up a site, carrying the link and the invited name after the #", installHref.origin === "https://install.afterwrd.app"
  && carried.get("invite") === zoe.link && carried.get("name") === "Zoe Quinn" && !installHref.search, installHref.href);
await ann.goto(`${A}/friend`);
check("…and the list remembers she was invited", (await fbRow("Zoe Quinn")).startsWith("Invited"), await fbRow("Zoe Quinn"));
const again = await invite("Zoe Quinn");
check("New link replaces the old one", again.link !== zoe.link && (await fetch(zoe.link)).status === 404);
check("only people in the download can be invited", (await ann.evaluate(() => fetch("/_admin/connections/invite", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nobody Atall" }) }).then((r) => r.status))) >= 400);

await connectFrom(cara, C, again.link);
await ann.goto(`${A}/friend`);
const forwarded = await ann.$eval(".requests", (r) => r.innerText).catch(() => "");
check("a request shows whose invite was used", forwarded.includes("Cara Example") && forwarded.includes("Used the invite you made for Zoe Quinn"), forwarded);
check("…warns that it isn't the name invited, and leads with the site's address", forwarded.includes("That's not the name you invited")
  && (await ann.$eval(".requests strong", (e) => e.textContent)) === "localhost:8789");
check("nothing is loaded from a site that hasn't been approved", !(await ann.$(".requests img")));
check("…and Zoe's row says someone's asking", (await fbRow("Zoe Quinn")) === "Asking to be friends");
await ann.screenshot({ path: `${OUT}/friends-request.png`, fullPage: true });
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/decline"]')]);
check("Decline forgets the request on both sites", sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0
  && sql(stateC, "SELECT COUNT(*) AS n FROM connections")[0].n === 0 && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

const caraInvite = await invite("Cara Example");
await connectFrom(cara, C, caraInvite.link);
await ann.goto(`${A}/friend`);
check("Cara's request names her invite", (await ann.$eval(".requests", (r) => r.innerText)).includes("Used the invite you made for Cara Example"));
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("approving links her to her Facebook self", (await fbRow("Cara Example")) === "On afterwrd"
  && (await ann.$eval("main", (m) => m.innerText)).includes("On Facebook as Cara Example"));
await cara.goto(`${C}/`);
check("Cara's Home now has Ann's post", (await feedCards(cara)).some((c) => c.who === "Ann Example"));
await ann.screenshot({ path: `${OUT}/friends-invited.png`, fullPage: true });

// Notes (step 4c: docs/signed-conversations.md): a friend's new signed post reaching an open Home, and the Outbox
// sending to many: one row per note, to every friend in turn (outbox.js sendNotes).
{
// Ann has Home open when Cara posts: Cara's site sends a note, and Ann's page offers it without moving anything.
await ann.goto(`${A}/`);
const postNotices = () => sql(stateA, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'post'")[0].n;
const postNoticesBefore = postNotices();
await compose(cara, C, "Cara's first post");
check("Cara's site tells Ann about the post", await waitFor(() => postNotices() === postNoticesBefore + 1));
check("…in a note carrying the post itself, kept at once", sql(stateA, "SELECT COUNT(*) AS n FROM copies WHERE json_extract(content, '$.text') = 'Cara''s first post'")[0].n === 1);
check("…but nothing on Ann's page has moved yet", !(await ann.$(".live-bar")) && !(await feedCards(ann)).some((c) => c.text === "Cara's first post"));
await ann.evaluate(() => window.afterwrdLive.check());
check("Ann's open Home quietly offers it", (await ann.$eval(".live-bar span", (s) => s.textContent).catch(() => "")) === "1 new post from friends");
await ann.screenshot({ path: `${OUT}/live-bar.png` });
await Promise.all([ann.waitForNavigation(), ann.click(".live-bar button")]);
check("Show brings it in", (await feedCards(ann)).some((c) => c.who === "Cara Example" && c.text === "Cara's first post"));
check("…and friends' new posts don't count as notifications", !(await ann.$('header.site a[href="/activity"] .count')));

// More friends than one page may ask: 45 more connections, to sites that don't exist, ahead of Cara in line.
sql(stateA, `INSERT INTO connections (id, origin, name, created_at, connected_at, approved_at) VALUES
  ${Array.from({ length: 45 }, (_, i) => `(${-(i + 1)}, 'https://friend${i + 1}.invalid', 'Made-up friend ${i + 1}',
  strftime('%s','now'), strftime('%s','now'), strftime('%s','now'))`).join(",")}`);
const caraPostsBefore = sql(stateC, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'post'")[0].n;
await compose(ann, A, "Ann to all 46 friends");
check("a post reaches a friend 46th in line (the outbox sends in batches)",
  await waitFor(() => sql(stateC, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'post'")[0].n === caraPostsBefore + 1, 20_000));
await ann.goto(`${A}/`);
check("Home still shows Cara's posts, from the copy her note kept", (await feedCards(ann)).some((c) => c.who === "Cara Example"));
// Home waits for at most 10 sites it has never asked, for a few seconds; the rest are asked after it's gone.
check("…asking every friend's site in the background, in the calls a page may make", await waitFor(() =>
  sql(stateA, "SELECT COUNT(*) AS n FROM connections WHERE id < 0 AND items_checked_at IS NOT NULL AND missing_since IS NOT NULL")[0].n === 45, 20_000));
await ann.goto(`${A}/`);
const notices = await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent));
const reachNotices = notices.filter((n) => /Couldn't (reach|load)/.test(n));
check("…and Home sums up those it couldn't reach in one line", reachNotices.length === 1 && /Couldn't reach 45 friends' sites/.test(reachNotices[0]),
  notices.join(" | "));
check("a site nobody has checked doesn't nag about it on Home", (await ann.$("form.checked-notice")) === null);
check("the friends column shows a dozen, then a link to the rest", (await ann.$$(".mini-friends li")).length === 12
  && (await ann.$eval('aside.side a[href="/friend"]', (a) => a.textContent).catch(() => "")) === "All 46 friends");
sql(stateA, "DELETE FROM connections WHERE id < 0");
}

// Friends whose sites stop answering. Gail's hasn't for two days (and was asked just now); Ned's only just stopped.
sql(stateA, `INSERT INTO connections (id, origin, name, created_at, connected_at, approved_at, reached_at,
  missing_since, items_checked_at) VALUES
  (9001, 'https://gail.invalid', 'Gone Gail', 1700000000, 1700000000, 1700000000, 1760000000,
    strftime('%s','now') - 172800, strftime('%s','now')),
  (9002, 'https://ned.invalid', 'New Ned', 1700000000, 1700000000, 1700000000, NULL, NULL, NULL)`);
const gailAsked = sql(stateA, "SELECT items_checked_at AS t FROM connections WHERE id = 9001")[0].t;
await ann.goto(`${A}/`);
const homeNotices = (await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent))).join(" | ");
check("Home mentions a friend's site that's just stopped answering", homeNotices.includes("Couldn't reach New Ned's site"), homeNotices);
check("…but not one that's been quiet for a day", !homeNotices.includes("Gail"), homeNotices);
check("…which is asked at most once an hour", sql(stateA, "SELECT items_checked_at AS t FROM connections WHERE id = 9001")[0].t === gailAsked);
check("Ned's site is noted as not answering", sql(stateA, "SELECT missing_since FROM connections WHERE id = 9002")[0].missing_since > 0);
await ann.goto(`${A}/friend`);
const gailCard = await ann.$$eval(".friend-list li", (l) => l.find((li) => li.textContent.includes("Gone Gail"))?.querySelector(".silent")?.textContent ?? "");
check("Friends says Gail's site has gone quiet, and since when", /hasn't answered since/.test(gailCard) && gailCard.includes("2025"), gailCard);
check("…with Remove friend beside it, and nothing like it for Cara",
  (await ann.$$eval(".friend-list li", (l) => l.filter((li) => li.querySelector(".silent button")).length)) === 1);
await ann.screenshot({ path: `${OUT}/friends-quiet.png`, fullPage: true });
await Promise.all([ann.waitForNavigation(), ann.$$eval(".friend-list li", (l) => l.find((li) => li.textContent.includes("Gone Gail")).querySelector(".silent button").click())]);
check("Remove friend forgets Gail, back on Friends", new URL(ann.url()).pathname === "/friend"
  && sql(stateA, "SELECT COUNT(*) AS n FROM connections WHERE id = 9001")[0].n === 0);
sql(stateA, "DELETE FROM connections WHERE id >= 9000");

// Cara removed Ann while Ann's site couldn't be told: Cara's site now says Ann's isn't connected.
const caraId = sql(stateA, `SELECT id FROM connections WHERE origin = '${C}'`)[0].id;
sql(stateC, "DELETE FROM connections");
copiesOld(stateA);
await ann.goto(`${A}/`);
check("Home says nothing about a friend who's removed you",
  !(await ann.$$eval("p.notice", (l) => l.map((p) => p.textContent).join(" "))).includes("Cara"));
check("…and remembers their site said no", sql(stateA, `SELECT said_no FROM connections WHERE id = ${caraId}`)[0].said_no === 1);
check("…and forgets the copy of her posts at once", sql(stateA, `SELECT COUNT(*) AS n FROM copies WHERE connection_id = ${caraId}`)[0].n === 0);
await ann.goto(`${A}/friend/${caraId}/posts`);
const caraNotice = await ann.$eval("p.notice", (p) => p.textContent).catch(() => "");
check("her page says she may have removed you", caraNotice.includes("Cara Example may have removed you as a friend"), caraNotice);
await ann.screenshot({ path: `${OUT}/friend-removed-you.png` });
await Promise.all([ann.waitForNavigation(), ann.click("main form.inline button")]);
check("Remove friend on her page forgets her", new URL(ann.url()).pathname === "/friend"
  && sql(stateA, "SELECT COUNT(*) AS n FROM connections")[0].n === 0 && sql(stateA, "SELECT COUNT(*) AS n FROM friend_links")[0].n === 0);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
