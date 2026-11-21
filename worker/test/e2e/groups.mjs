// Groups: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's own Worker (G, 8790, in group
// mode). Ann claims the group (making the Worker in Cloudflare can't happen locally, so the test starts it), invites
// Bob and Cat with a link, lets them in and makes Bob an admin. They read it from their own sites and post, every post
// and comment signed in its writer's browser and hosted by the group (photos are copied to it); comments reach only
// those who wrote or commented on the post; the group can't put words in a member's mouth, or drop them unnoticed;
// signed calls open nothing else; the group's Worker serves nothing else; then renaming, admins removing things,
// events (adding one, answering, changing it, calling it off: only those going hear, and only of changes), leaving,
// removing, and deleting the group.
//   node groups.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count as n, settled, siteCall, siteSql as sql, setUpSigning } from "./helpers.mjs";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [, fixtures, stateA, stateB, stateC, stateG] = process.argv.slice(2);
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
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 400))) if (await test()) return true;
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
const text = (page, selector = "main") => page.$eval(selector, (m) => m.innerText).catch(() => "");
const cards = (page) => page.$$eval("article.in-group", (l) => l.map((a) => ({
  id: a.id, who: a.querySelector("header strong").textContent, text: a.querySelector(".text")?.textContent ?? "",
  photos: a.querySelectorAll(".collage img").length, canDelete: Boolean(a.querySelector("header .delete")),
  comments: [...a.querySelectorAll(".comment:not(.gone)")].map((c) => ({ name: c.querySelector("strong").textContent,
    text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under .delete")) })),
})));
async function postInGroup(page, words, files = []) {
  await page.type("#composer textarea", words);
  if (files.length) await (await page.$("#composer input[type=file]")).uploadFile(...files);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
let inPlaceChecked = false;
// Comments are behind each post's "Comments" (or "Comment") button, opened in place (ui/threads.js).
async function comment(page, card, words) {
  if (!(await page.$(`#${card} details.comments[open]`))) await page.click(`#${card} details.comments summary`);
  await page.waitForSelector(`#${card} form.say textarea`, { timeout: 15_000 });
  await page.type(`#${card} form.say textarea`, words);
  await page.evaluate(() => { window.samePage = true; });
  await Promise.all([settled(page, { timeout: 30_000 }), page.click(`#${card} form.say button`)]);
  if (!inPlaceChecked) {
    inPlaceChecked = true;
    check("a comment in a group is sent without a new page", await page.evaluate((id) => window.samePage === true
      && [...document.querySelectorAll(`#${id} .comment .said`)].some((s) => s.textContent.length > 0), card));
  }
}
// Joining the way the page suggests (pasting the link into Groups on your own site), or by opening the link and
// typing your site's address.
async function join(page, site, link, { typed = false } = {}) {
  if (typed) {
    await page.goto(link);
    page.joinPage = await page.$eval("main", (m) => m.textContent.replace(/\s+/g, " "));
    page.joinFolded = await page.$eval("#site", (f) => !f.closest("details").open);
    await page.$eval("#site", (f) => { f.closest("details").open = true; });
    await page.type("#site input", site);
    await Promise.all([page.waitForNavigation(), page.click("#site button")]);
  } else {
    await page.goto(`${site}/groups`);
    page.joinBoxFirst = await page.$eval("main form", (f) => f.id === "join");
    await page.type("#join input[name=link]", link);
    await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
  }
  const asked = (await page.$eval("h1", (h) => h.textContent).catch(() => "")) === "Join Book club?";
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
  return asked;
}
// A call as a site: with a key (groups from before step 6b), or, for {state, from}, signed by that site (step 6b on).
const call = (site, path, key, body) => (key && typeof key === "object" ? siteCall(key.state, key.from, site + path, body ?? null)
  : fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
    headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) }));
// Signing as each site (step 6b: a group with an identity knows its members by theirs, and calls them signed).
const asAnn = { state: stateA, from: A };
const asBob = { state: stateB, from: B };
const asCat = { state: stateC, from: C };
const asGroup = { state: stateG, from: G };
async function addEvent(page, fields) {
  await page.$eval("details.add-event", (d) => { d.open = true; });
  await page.$eval("form.event-form", (f, v) => { for (const [k, x] of Object.entries(v)) f.elements[k].value = x; }, fields);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("form.event-form button.primary")]);
}
async function answer(page, card, value) {
  await Promise.all([settled(page, { timeout: 30_000 }), page.click(`#${card} .answers button[value=${value}]`)]);
}
const pressed = (page, card) => page.$eval(`#${card} .answers [aria-pressed=true]`, (b) => b.value).catch(() => null);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");

// The group's Worker serves its members' sites and nothing else; people's sites don't serve groups.
check("a group's Worker has no pages, sign-in or friends", (await fetch(`${G}/`)).status === 404
  && (await fetch(`${G}/_auth/setup?code=${CODE}`)).status === 404 && (await fetch(`${G}/_p/profile`, { headers: { "Afterwrd-From": A } })).status === 404);
check("…and says it's a group", (await (await fetch(`${G}/`)).text()).includes("This is an afterwrd group"));
check("a person's site doesn't answer as a group", (await call(A, "/_group/ping")).status !== 200);

// Ann starts the group. (Locally, her site claims a group Worker that's already running.)
await ann.goto(`${A}/groups`);
check("Groups is in the main menu", (await ann.$$eval("header.site nav.main a span", (l) => l.map((s) => s.textContent))).includes("Groups"));
check("no groups yet", (await text(ann)).includes("You're not in any groups yet"));
await ann.goto(`${A}/groups/new`);
check("starting a group explains it's its own site", (await text(ann)).includes("its own small site in your Cloudflare account"));
check("wrong key can't claim the group", (await call(G, "/_group/claim", null, { setup: "nope", origin: A, key: "k".repeat(43), name: "x" })).status === 403);
const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Book club", about: "One book a month" });
const claimed = await post(ann, "/_groups/create/claim", { id: waiting.id });
check("Ann's site claims the group", claimed.status === 200 && n(stateG, "group_members WHERE role = 'owner' AND origin = 'http://localhost:8787'") === 1, JSON.stringify(claimed));
check("…only once", (await call(G, "/_group/claim", null, { setup: GROUP_KEY, origin: C, key: "k".repeat(43), name: "Mine now" })).status === 409);
const annGroup = claimed.id;
// afterwrd 2 (step 6a): one passkey prompt signs the group's identity as Ann's, as the page does after claiming.
const signGroup = (page, id) => page.evaluate(async (id) => {
  const [S, { passkeySigns }] = await Promise.all([import("/static/signed.js"), import("/static/passkey.js")]);
  const send = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const start = await send(`/_groups/${id}/identity/start`, {});
  if (start.status !== 200) return start;
  const response = await passkeySigns(start.nonce, [await S.fingerprintOf("identity", S.fromB64url(start.doc))], start.allow);
  return send(`/_groups/${id}/identity/finish`, { doc: start.doc, response });
}, id);
const signedGroup = await signGroup(ann, annGroup);
const groupDoc = (() => { const row = sql(stateG, "SELECT person, chain FROM own_identity")[0];
  return row && { person: row.person, doc: JSON.parse(Buffer.from(JSON.parse(row.chain)[0].bytes, "base64url").toString()) }; })();
const annPerson = sql(stateA, "SELECT person FROM own_identity")[0].person;
check("Ann's passkey signs the group's identity: owned by her, at its address, with its hosting key", signedGroup.status === 200
  && groupDoc?.doc.owner === annPerson && groupDoc.doc.origin === G && groupDoc.doc.passkeys.length === 0 && !("recovery" in groupDoc.doc)
  && groupDoc.doc.hosting === (await (await call(G, "/_group/ping")).json()).hosting, JSON.stringify(signedGroup));
check("…and her site ties the group to it", sql(stateA, `SELECT identity FROM groups WHERE id = ${annGroup}`)[0]?.identity === groupDoc?.person);
const published = await (await fetch(`${G}/.well-known/afterwrd`)).json().catch(() => ({}));
check("the group publishes its identity, with Ann's beside it", published.chain?.length === 1
  && JSON.stringify(published.owner) === sql(stateA, "SELECT chain FROM own_identity")[0].chain);
check("…once: it can't be signed again", (await signGroup(ann, annGroup)).status === 409);
await ann.goto(`${A}/groups/${annGroup}/members`);
check("the group's page names it and its site", (await ann.$eval("h1", (h) => h.textContent)) === "Book club" && (await text(ann)).includes("Your group, at localhost:8790"));
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
check("invite link made, on the group's site", /^http:\/\/localhost:8790\/_join\/[\w-]{40,}$/.test(link), link.slice(0, 40));

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(link);
check("the link opens a page naming the group, without signing in", (await stranger.$eval("h1", (h) => h.textContent)) === "Join Book club");

// Bob and Cat ask to join, from their own sites.
check("Bob pastes the link into Groups on his own site (the box comes first there), and is asked to confirm", await join(bob, B, link) && bob.joinBoxFirst);
check("Bob waits to be let in", (await text(bob)).includes("Waiting for Ann Example to let you in"), await text(bob));
const bobKey = asBob;
check("Bob's site can't read the group yet", (await call(G, "/_p/items", bobKey)).status === 403);
check("…nor anything on Ann's site", (await call(A, "/_p/items", bobKey)).status === 401 && (await call(A, "/_group/posts", bobKey)).status !== 200);
check("Cat opens the link instead: it says to paste it into Groups on her site, with the address box folded away, which still works",
  await join(cat, C, link, { typed: true }) && cat.joinPage.includes("paste it into Groups") && cat.joinFolded);
const catKey = asCat;

await ann.goto(`${A}/groups/${annGroup}`);
check("Ann's group shows 2 asking to join", (await ann.$eval(".tabs .count", (c) => c.firstChild.textContent).catch(() => "")) === "2");
await ann.goto(`${A}/groups/${annGroup}/members`);
check("Members lists both asking to join", (await text(ann, ".requests")).includes("Bob Example") && (await text(ann, ".requests")).includes("localhost:8789"));
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[data-group-record="approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[data-group-record="approve"]')]);
check("Ann lets them both in", !(await ann.$(".requests")) && n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const bobMember = sql(stateG, `SELECT id FROM group_members WHERE origin = '${B}'`)[0].id;
const bobJoin = sql(stateG, `SELECT join_fp FROM group_members WHERE origin = '${B}'`)[0].join_fp;
check("each is in by their own signed join, and Ann's signed approval, on the group's members list",
  n(stateG, `lists WHERE id = '${groupDoc.person}' AND n = 4`) === 1);
await Promise.all([ann.waitForNavigation(), ann.click(`button[data-group-record="role"][data-role="admin"][data-about="${bobJoin}"]`)]);
check("Ann makes Bob an admin", sql(stateG, `SELECT role FROM group_members WHERE id = ${bobMember}`)[0].role === "admin");
check("Cat can't run the group", (await call(G, "/_group/admin/link", catKey, {})).status === 403);
const linkRow = sql(stateG, "SELECT requests FROM group_links")[0];
check("each request counts against the invite link", linkRow?.requests === 2);
sql(stateG, "UPDATE group_links SET requests = 100");
check("a link that's been used too often stops working", (await fetch(link)).status === 404);
sql(stateG, "UPDATE group_links SET requests = 2");

// Posting (afterwrd 2, step 6c): each post is signed in its writer's browser and hosted by the group (groupposts.js);
// members' sites keep copies of the newest (groupcopies.js). Bob's photos are copied to the group's Worker.
const groupPerson = groupDoc.person;
const bobPerson = sql(stateB, "SELECT person FROM own_identity")[0].person;
const catPerson = sql(stateC, "SELECT person FROM own_identity")[0].person;
const postBy = (person) => sql(stateG, `SELECT id FROM items WHERE type = 'post' AND author = '${person}' ORDER BY created_at`).map((r) => r.id);
// Where a list on the group's site is up to, and the newest record a member's site sent to it (what theirs follows).
const point = (id) => { const r = sql(stateG, `SELECT n, head FROM lists WHERE id = '${id}'`)[0]; return { n: r.n, h: r.head }; };
const lastSent = (state, item) => sql(state, `SELECT fp FROM sent WHERE item = '${item}' ORDER BY created_at DESC, rowid DESC LIMIT 1`)[0]?.fp ?? null;
// A record signed in `page`'s browser and passed on by its site, as a form would be: 303 if the group took it, 400 if not.
// `roleAt`: an admin's, saying where the members list was (as the page does: ui/sign.js).
const relaySigned = (page, group, fields, content, { roleAt = false } = {}) => page.evaluate(async (g, f, c, withRole) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  let role = {};
  if (withRole) role = { role_at: (await (await fetch(`/_groups/${g}/point`, { method: "POST" })).json()).role_at };
  const made = await makeRecord({ author: key.person, ...f, ...role }, c ?? undefined, key);
  const body = new FormData();
  body.set("sent", JSON.stringify(made.sent));
  body.set("back", "/");
  return (await fetch(`/_groups/${g}/items/${f.item}/records`, { method: "POST", body, redirect: "manual" })).status;
}, group, fields, content ?? null, roleAt);
// A new post signed in `page`'s browser for the group, with photos as listed (none: no files), sent to its own site.
const signedPost = (page, group, content, { photos = [] } = {}) => page.evaluate(async (g, host, c, ph) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const own = { kind: "item", author: key.person, host };
  const made = [];
  for (const p of ph) made.push(await makeRecord(own, { type: "photo", ...p }, key));
  const post = await makeRecord(own, { ...c, photos: ph.map((p, i) => ({ item: made[i].fp, ...p })) }, key);
  return { sent: post.sent, photos: made.map((m) => m.sent) };
}, group, groupPerson, content, photos);
// …sent straight to the group by the member's site, as their site would, with links of its own choosing (`files`).
const delegationOf = (state, sent) => {
  const key = JSON.parse(Buffer.from(sent.record, "base64url").toString()).key;
  const d = sql(state, `SELECT bytes, proof FROM delegations WHERE key = '${key}'`)[0];
  return { bytes: d.bytes, proof: JSON.parse(d.proof) };
};
const toGroup = async (state, from, signed, files) => {
  const res = await siteCall(state, from, `${G}/_p/items`, { ...signed, files, delegation: delegationOf(state, signed.sent) });
  return res.status;
};

await ann.goto(`${A}/groups/${annGroup}`);
await postInGroup(ann, "Welcome, everyone");
let annCards = await cards(ann);
check("Ann's post shows as hers", annCards.length === 1 && annCards[0].who === "You", JSON.stringify(annCards));
const annPost = postBy(annPerson)[0];
check("…signed by Ann, hosted by the group, with her own record of it", Boolean(annPost) && n(stateG, `lists WHERE id = '${annPost}' AND owner = '${annPerson}'`) === 1
  && n(stateA, `sent WHERE item = '${annPost}' AND kind = 'item' AND receipt IS NOT NULL`) === 1);
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
await bob.goto(`${B}/groups/${bobGroup}`);
let bobCards = await cards(bob);
check("Bob reads the group from his site", bobCards.length === 1 && bobCards[0].who === "Ann Example" && bobCards[0].text === "Welcome, everyone", JSON.stringify(bobCards));
check("…with its name and members", (await text(bob)).includes("Book club") && (await text(bob)).includes("3 members"));
check("…keeping a copy of it", n(stateB, `copies WHERE group_id = ${bobGroup} AND id = '${annPost}' AND connection_id IS NULL`) === 1);
await postInGroup(bob, "Started the first book", [`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`]);
const bobPost = postBy(bobPerson)[0];
const photo = sql(stateG, "SELECT hash, thumb_hash FROM media WHERE item_id IS NOT NULL")[0];
check("Bob's photos are kept on the group's Worker, each an item of its own", Boolean(photo) && n(stateG, `item_photos WHERE post = '${bobPost}'`) === 2);
check("…and not left behind on his site", (await bob.evaluate((h) => fetch(`/files/${h}`, { cache: "no-store" }).then((r) => r.status), photo?.hash)) === 404);
bobCards = await cards(bob);
check("Bob's post shows as his, with the photos", bobCards[0]?.who === "You" && bobCards[0].photos === 2 && bobCards[0].canDelete, JSON.stringify(bobCards[0]));
check("Bob, an admin, isn't offered removing Ann's post (she owns the group)", bobCards[1]?.who === "Ann Example" && !bobCards[1].canDelete);
await bob.waitForFunction(() => document.querySelector("article.in-group .collage img")?.complete, { timeout: 15_000 });
check("the photo loads from the group's Worker", await bob.$eval("article.in-group .collage img", (i) => i.naturalWidth > 0 && i.src.startsWith("http://localhost:8790/files/")));
await bob.screenshot({ path: `${OUT}/group-desktop.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.screenshot({ path: `${OUT}/group-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });
// A photo opened from a group's post is among that post's photos, and ✕ goes back to the post where it was.
await bob.goto(`${B}/groups/${bobGroup}`);
await Promise.all([bob.waitForNavigation(), bob.click(`#gi-${bobPost} .collage a.tile:nth-of-type(2)`)]);
const groupInPost = await bob.evaluate(() => ({ counter: document.querySelector(".counter")?.textContent, close: document.getElementById("close").getAttribute("href"),
  prev: document.getElementById("prev")?.getAttribute("href"), next: Boolean(document.getElementById("next")),
  shown: document.querySelector(".stage img")?.naturalWidth > 0, post: document.querySelector(".info article.in-group .text")?.textContent }));
check("a photo opened from a group's post is among that post's photos", groupInPost.counter === "2 / 2" && !groupInPost.next
  && groupInPost.prev?.startsWith(`/groups/${bobGroup}/posts/${bobPost}/photos/1`) && groupInPost.prev.includes("back=")
  && groupInPost.post === "Started the first book", JSON.stringify(groupInPost));
check("…and ✕ goes back to the post where it was", groupInPost.close === `/groups/${bobGroup}#gi-${bobPost}`, groupInPost.close);
await Promise.all([bob.waitForNavigation(), bob.click("#prev")]);
check("…and stays with the post going back a photo", (await bob.$eval(".counter", (c) => c.textContent)) === "1 / 2"
  && (await bob.$eval("#close", (a) => a.getAttribute("href"))) === groupInPost.close);
await bob.goto(`${B}${groupInPost.prev.replace(/back=[^&]*/, `back=${encodeURIComponent("//evil.example/")}`)}`);
check("…but never back to another site", (await bob.$eval("#close", (a) => a.getAttribute("href"))) === "/");

// Changing words: only the writer, for 15 minutes, and until someone else comments (lists.js), each change signed.
// `item` is the post or comment; `v` where its V is: "> header" for a post, ".under" for a comment.
const edit = async (page, item, v, words) => {
  await page.click(`${item} ${v} details.more summary`);
  await page.click(`${item} ${v} details.more a[href^="#edit"]`);
  await page.$eval(`${item} div.edit textarea`, (t, w) => { t.value = w; }, words);
  await Promise.all([settled(page), page.click(`${item} div.edit button`)]);
};
const bobRow = () => sql(stateG, `SELECT content, earlier FROM items WHERE id = '${bobPost}'`)[0];
await bob.goto(`${B}/groups/${bobGroup}`);
check("Bob's new post offers Edit", Boolean(await bob.$(`#gi-${bobPost} > div.edit`)));
await edit(bob, `#gi-${bobPost}`, "> header", "Started the first book: The Hobbit");
check("…a signed edit on the group's Worker, keeping what it said before", JSON.parse(bobRow().content).text === "Started the first book: The Hobbit"
  && JSON.parse(bobRow().earlier ?? "[]")[0]?.text === "Started the first book", JSON.stringify(bobRow()));
check("…and in Bob's own record of what he sent", n(stateB, `sent WHERE item = '${bobPost}' AND kind = 'edit' AND receipt IS NOT NULL`) === 1);
await ann.goto(`${A}/groups/${annGroup}`);
check("Ann sees it Edited, with what it said before", (await ann.$eval(`#gi-${bobPost} > details.edited`, (d) => d.textContent).catch(() => ""))
  .includes("Started the first book"));
check("Ann can't change Bob's post", (await relaySigned(ann, annGroup, { kind: "edit", host: groupPerson, item: bobPost, seen: point(bobPost), prev: null, about: bobPost },
  { text: "Ann's words" })) === 400 && !bobRow().content.includes("Ann's words"));

// Comments are told only to those who wrote or commented on the post.
const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};
const commentFp = (item, words) => sql(stateG, `SELECT entries FROM list_pages WHERE list = '${item}'`).flatMap((r) => JSON.parse(r.entries))
  .find((e) => e.sent?.content && Buffer.from(e.sent.content, "base64url").toString().includes(words))?.fp ?? null;
const groupNotices = (state, kind = null) => n(state, `notices WHERE group_id IS NOT NULL${kind ? ` AND kind = '${kind}'` : ""}`);
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;
await cat.goto(`${C}/groups/${catGroup}`);
check("Cat sees both posts, and can't delete or remove either", (await cards(cat)).length === 2 && (await cards(cat)).every((c) => !c.canDelete));
await comment(cat, `gi-${bobPost}`, "Which book?");
const catComment = commentFp(bobPost, "Which book?");
check("Cat's comment is on Bob's post, signed by her, with the group's receipt", Boolean(catComment)
  && n(stateC, `sent WHERE fp = '${catComment}' AND receipt IS NOT NULL`) === 1);
check("Cat's comment locks Bob's post", (await relaySigned(bob, bobGroup, { kind: "edit", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateB, bobPost), about: bobPost }, { text: "too late" })) === 400);
await cat.goto(`${C}/groups/${catGroup}/posts/${bobPost}`);
await edit(cat, `#c-${catComment}`, ".under", "Which book was it?");
check("Cat changes her comment", Boolean(commentFp(bobPost, "Which book was it?")) && n(stateC, `sent WHERE item = '${bobPost}' AND kind = 'edit'`) === 1);
check("Bob, an admin, still can't change Cat's words", (await relaySigned(bob, bobGroup, { kind: "edit", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateB, bobPost), about: catComment }, { text: "Bob's words" })) === 400);
check("Bob is told about Cat's comment on his post", await waitFor(() => groupNotices(stateB, "comment") === 1));
check("Ann isn't: it's not her post and she hasn't commented", groupNotices(stateA) === 0);
await ann.goto(`${A}/groups/${annGroup}`);
await comment(ann, `gi-${bobPost}`, "The one we picked!");
check("Bob and Cat are told about Ann's comment", await waitFor(() => groupNotices(stateB) === 2 && groupNotices(stateC) === 1));
check("Ann's comment after Cat's locks Cat's", (await relaySigned(cat, catGroup, { kind: "edit", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateC, bobPost), about: catComment }, { text: "changed later" })) === 400);
await cat.goto(`${C}/groups/${catGroup}/posts/${bobPost}`);
check("…and Cat's site stops offering Edit, showing it Edited", !(await cat.$(`#c-${catComment} div.edit`))
  && (await cat.$eval(`#c-${catComment} details.edited`, (d) => d.textContent).catch(() => "")).includes("Which book?"));
await bob.goto(`${B}/groups/${bobGroup}`);
await comment(bob, `gi-${bobPost}`, "Ah, of course");
check("Ann and Cat are told about Bob's", await waitFor(() => groupNotices(stateA) === 1 && groupNotices(stateC) === 2));
await ann.goto(`${A}/activity`);
check("Ann's Notifications show it", (await text(ann)).includes("Bob Example also commented on a post in Book club"), (await text(ann)).slice(0, 300));
await bob.goto(`${B}/activity`);
const bobNews = await text(bob);
check("Bob's say who commented on his post, and where", bobNews.includes("Cat Example commented on your post in Book club")
  && bobNews.includes("Ann Example commented on your post"), bobNews.slice(0, 300));
await Promise.all([bob.waitForNavigation(), bob.click(`a[href="/groups/${bobGroup}/posts/${bobPost}"]`)]);
check("…and link to the post's own page, with its comments", (await cards(bob))[0]?.comments.length === 3, JSON.stringify(await cards(bob)));

// Live: Bob has his post open; Cat comments on it; a quiet bar offers it. Times are in seconds and the bar counts from
// the second the page was made, so the earlier comments' notes are let fall into an earlier second first.
await pause(1100);
await bob.goto(`${B}/groups/${bobGroup}/posts/${bobPost}`);
await pause(1100);
await cat.goto(`${C}/groups/${catGroup}`);
await comment(cat, `gi-${bobPost}`, "Lovely photo");
check("Bob's open page offers the new comment", await waitFor(async () => {
  await bob.evaluate(() => window.afterwrdLive.check());
  return (await text(bob, ".live-bar")).includes("1 new comment");
}));

// The group can't put words in a member's mouth (lists.js checkList, friendcopies.js keepCopy): its database edited by
// hand, as whoever runs it could.
const bobsComment = commentFp(bobPost, "Ah, of course");
const pages = sql(stateG, `SELECT page, entries FROM list_pages WHERE list = '${bobPost}'`);
const tampered = JSON.parse(pages[0].entries);
const bobsEntry = tampered.find((e) => e.fp === bobsComment);
const wasContent = bobsEntry.sent.content;
bobsEntry.sent.content = Buffer.from(JSON.stringify({ text: "forged words" })).toString("base64url");
sql(stateG, `UPDATE list_pages SET entries = '${JSON.stringify(tampered).replace(/'/g, "''")}' WHERE list = '${bobPost}' AND page = 0`);
await ann.goto(`${A}/groups/${annGroup}/posts/${bobPost}`);
check("words the group changed fail their check, and aren't shown", (await ann.$$eval("article.in-group .comment.gone", (l) => l.map((c) => c.textContent)))
  .some((t) => t.includes("didn't pass its check")) && !(await text(ann)).includes("forged words"));
bobsEntry.sent.content = wasContent;
sql(stateG, `UPDATE list_pages SET entries = '${JSON.stringify(tampered.filter((e) => e.fp !== bobsComment)).replace(/'/g, "''")}' WHERE list = '${bobPost}' AND page = 0`);
await ann.goto(`${A}/groups/${annGroup}/posts/${bobPost}`);
check("a comment the group dropped: the conversation doesn't add up", (await text(ann, "article.in-group .notice.alert")).includes("doesn't add up"));
sql(stateG, `UPDATE list_pages SET entries = '${pages[0].entries.replace(/'/g, "''")}' WHERE list = '${bobPost}' AND page = 0`);
await ann.goto(`${A}/groups/${annGroup}/posts/${bobPost}`);
check("…and with it put back, all's well again", !(await ann.$("article.in-group .notice.alert")) && (await cards(ann))[0].comments.length === 4);
// A post's words as the group says them, changed: members' sites work them out from what Bob signed.
const bobContent = bobRow().content;
sql(stateG, `UPDATE items SET content = '${bobContent.replace("The Hobbit", "something forged").replace(/'/g, "''")}', changed_at = changed_at + 1 WHERE id = '${bobPost}'`);
await cat.goto(`${C}/groups/${catGroup}`);
check("Bob's post as the group rewords it shows as Bob signed it", (await cards(cat)).find((c) => c.id === `gi-${bobPost}`)?.text === "Started the first book: The Hobbit");
sql(stateG, `UPDATE items SET content = '${bobContent.replace(/'/g, "''")}' WHERE id = '${bobPost}'`);
// A post claiming to be Bob's that he never signed (Ann's, under another id) isn't kept.
const fakeId = "f".repeat(43);
const annFirst = JSON.parse(sql(stateG, `SELECT entries FROM list_pages WHERE list = '${annPost}' AND page = 0`)[0].entries)[0];
sql(stateG, `INSERT INTO items (id, author, type, content, created_at, changed_at, author_last, audience) VALUES ('${fakeId}', '${bobPerson}', 'post',
  '{"type":"post","text":"never said this","photos":[]}', strftime('%s','now'), strftime('%s','now'), '${fakeId}', 'group');
  INSERT INTO lists (id, owner, n, head, created_at) VALUES ('${fakeId}', '${bobPerson}', 1, '${annFirst.head}', strftime('%s','now'));
  INSERT INTO list_pages (list, page, entries) VALUES ('${fakeId}', 0, '${JSON.stringify([annFirst]).replace(/'/g, "''")}');`);
await cat.goto(`${C}/groups/${catGroup}`);
check("a post Bob never signed isn't shown as his", !(await text(cat)).includes("never said this") && n(stateC, `copies WHERE id = '${fakeId}'`) === 0);
sql(stateG, `DELETE FROM items WHERE id = '${fakeId}'; DELETE FROM lists WHERE id = '${fakeId}'; DELETE FROM list_pages WHERE list = '${fakeId}';`);

// Signed calls open only what they're for.
check("an unsigned call gets nothing", (await call(G, "/_p/items")).status === 401 && (await fetch(`${G}/_p/items`, { headers: { "Afterwrd-From": B } })).status === 401);
check("Cat can't delete Bob's post", (await relaySigned(cat, catGroup, { kind: "delete", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateC, bobPost), about: bobPost })) === 400 && n(stateG, `items WHERE id = '${bobPost}'`) === 1);
const tiny = { hash: photo.hash, thumb_hash: photo.thumb_hash, width: 10, height: 10, size: 100 };
const claimedPhoto = await signedPost(cat, catGroup, { type: "post", text: "Bob's photo, claimed" }, { photos: [tiny] });
check("a member can't post files from someone else's site", (await toGroup(stateC, C, claimedPhoto,
  [{ src: `${B}/files/${photo.hash}?exp=9999999999&sig=${"x".repeat(43)}`, thumbSrc: `${B}/files/${photo.thumb_hash}?exp=9999999999&sig=${"x".repeat(43)}` }])) === 400);
const fakeFile = (h) => ({ src: `${C}/files/${h}?exp=9999999999&sig=${"x".repeat(43)}`, thumbSrc: `${C}/files/${"b".repeat(64)}?exp=9999999999&sig=${"x".repeat(43)}` });
const big = await signedPost(cat, catGroup, { type: "post", text: "big" }, { photos: [{ ...tiny, hash: "a".repeat(64), thumb_hash: "b".repeat(64), size: 9_000_000 }] });
check("a photo too big for a group is refused before anything's fetched", (await toGroup(stateC, C, big, [fakeFile("a".repeat(64))])) === 400);
const itemsBefore = n(stateG, "items");
const lost = await signedPost(cat, catGroup, { type: "post", text: "photo that won't arrive" }, { photos: [{ ...tiny, hash: "a".repeat(64), thumb_hash: "b".repeat(64) }] });
check("a post whose photos can't be copied isn't kept, nor its photos", (await toGroup(stateC, C, lost, [fakeFile("a".repeat(64))])) === 400
  && n(stateG, "items") === itemsBefore && n(stateG, `media WHERE hash = '${"a".repeat(64)}'`) === 0);
check("Bob, an admin, can't remove Ann's post (she owns the group)", (await relaySigned(bob, bobGroup, { kind: "remove", host: groupPerson, item: annPost,
  seen: point(annPost), prev: lastSent(stateB, annPost), about: annPost }, null, { roleAt: true })) === 400 && n(stateG, `items WHERE id = '${annPost}'`) === 1);
const noted = groupNotices(stateB);
const forgedNote = await siteCall(stateG, G, `${B}/_p/notes`, { v: 2, kind: "comment", item: annPost, entry: { n: 2, fp: "x".repeat(43), taken: 1, prev: "", sent: {} }, receipt: {} });
check("the group can't send notes that don't check", forgedNote.status === 400 && groupNotices(stateB) === noted);
check("…nor read anything of Bob's", (await call(B, "/_p/items", asGroup)).status === 401);
check("…nor pretend to be mid-join", (await call(B, `/_member/hello?from=${encodeURIComponent(G)}&group=1`, asGroup)).status === 401);
check("group actions need the owner's session", (await fetch(`${A}/_groups/${annGroup}/delete`, { method: "POST", redirect: "manual", headers: { Origin: A } })).status === 401);
const exported = await ann.evaluate(() => fetch("/_admin/export/rows?table=groups").then((r) => r.text()));
check("Download everything carries no group keys", !exported.includes("key") && exported.includes("Book club"));

// Bob, an admin, sees the controls a member would; deleting, and admins removing (signed, with where they stood).
await bob.goto(`${B}/groups/${bobGroup}/members`);
const bobControls = await bob.$$eval(".member-list button[data-group-record]", (l) => l.map((b) => b.textContent));
check("Bob, an admin, can remove Cat but not Ann, nor make admins", bobControls.join() === "Remove", bobControls.join());
const commentCards = async (page) => page.$$eval("article.in-group .comment:not(.gone)", (l) => l.map((c) => ({ id: c.id.slice(2),
  text: c.querySelector(".said").textContent, canDelete: Boolean(c.querySelector(".under .delete")) })));
await bob.goto(`${B}/groups/${bobGroup}/posts/${bobPost}`);
const onBobs = await commentCards(bob);
check("Bob, an admin, may remove Cat's comments but not Ann's", onBobs.find((c) => c.id === catComment)?.canDelete
  && !onBobs.find((c) => c.text === "The one we picked!")?.canDelete, JSON.stringify(onBobs));
await bob.click(`#c-${bobsComment} .under details.more summary`);
await Promise.all([settled(bob), bob.click(`#c-${bobsComment} .under .delete`)]);
check("Bob deletes his own comment: a marker stays", (await text(bob, `#c-${bobsComment}`)).includes("A comment was deleted"));
const lovely = commentFp(bobPost, "Lovely photo");
await bob.click(`#c-${lovely} .under details.more summary`);
await Promise.all([settled(bob), bob.click(`#c-${lovely} .under .delete`)]);
check("…and removes Cat's, signed, with where he stood as an admin", !commentFp(bobPost, "Lovely photo")
  && sql(stateG, `SELECT entries FROM list_pages WHERE list = '${bobPost}'`).flatMap((r) => JSON.parse(r.entries))
    .some((e) => e.sent && JSON.parse(Buffer.from(e.sent.record, "base64url").toString()).kind === "remove"
      && JSON.parse(Buffer.from(e.sent.record, "base64url").toString()).role_at?.n >= 1));
check("Bob can't remove Ann's comment", (await relaySigned(bob, bobGroup, { kind: "remove", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateB, bobPost), about: commentFp(bobPost, "The one we picked!") }, null, { roleAt: true })) === 400);
await ann.goto(`${A}/groups/${annGroup}`);
annCards = await cards(ann);
check("Ann, its owner, may take down anything in the group", annCards.every((c) => c.canDelete));
await ann.goto(`${A}/groups/${annGroup}/posts/${bobPost}`);
check("…comments too", (await commentCards(ann)).every((c) => c.canDelete));
await ann.click(`#c-${catComment} .under details.more summary`);
await Promise.all([settled(ann), ann.click(`#c-${catComment} .under .delete`)]);
await cat.goto(`${C}/groups/${catGroup}/posts/${bobPost}`);
const markers = await cat.$$eval("article.in-group .comment.gone", (l) => l.map((c) => c.textContent.trim()));
check("Cat sees who removed her comments: Bob, an admin, and Ann, the group's owner", markers.includes("A comment was removed by Bob Example, an admin.")
  && markers.includes("A comment was removed by the group's owner, Ann Example."), markers.join(" | "));
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.$eval('form[action$="/about"] input[name=name]', (i) => { i.value = "Book club (2026)"; });
await Promise.all([ann.waitForNavigation(), ann.click('form[action$="/about"] button')]);
await cat.goto(`${C}/groups/${catGroup}`);
check("renaming reaches members' sites", (await cat.$eval("h1", (h) => h.textContent)) === "Book club (2026)");

// Events: posts with an event, for everyone in the group (itemkinds.js). Ann adds one; nobody is sent anything about it.
for (const page of [ann, bob, cat]) await page.emulateTimezone("Europe/London");
const tells = () => [stateA, stateB, stateC].map((st) => groupNotices(st)).join();
const quiet = tells();
await ann.goto(`${A}/groups/${annGroup}/calendar`);
check("the Calendar starts empty, with adding an event open", (await text(ann)).includes("Nothing this month.") && await ann.$eval("details.add-event", (d) => d.open)
  && Boolean(await ann.$(".calendar .cal-grid")));
await addEvent(ann, { title: "Book swap", start_date: "2027-06-12", start_time: "19:00", end_time: "21:00", place: "Ann's house", text: "Bring a book" });
const swap = postBy(annPerson).find((id) => JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${id}'`)[0].content).type === "event");
const swapEvent = () => JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${swap}'`)[0].content).event;
check("Ann adds an event, in her time zone, signed", swapEvent()?.title === "Book swap" && swapEvent().time_zone === "Europe/London"
  && swapEvent().starts_at === Date.UTC(2027, 5, 12, 18) / 1000 && swapEvent().ends_at === Date.UTC(2027, 5, 12, 20) / 1000, JSON.stringify(swapEvent()));
check("…lands on its page, saying when and where", (await text(ann)).includes("Sat 12 Jun 2027, 19:00–21:00") && (await text(ann)).includes("Ann's house"), (await text(ann)).slice(0, 400));
await pause(2500);
check("no one is sent anything about a new event", tells() === quiet, `${quiet} -> ${tells()}`);
const tally = () => JSON.parse(sql(stateG, `SELECT tally FROM items WHERE id = '${swap}'`)[0].tally ?? "{}");
await bob.goto(`${B}/groups/${bobGroup}/calendar?month=2027-06`);
check("Bob's Calendar lists it under its month", (await text(bob)).includes("June 2027") && (await text(bob, ".calendar")).includes("Book swap"));
await answer(bob, `gi-${swap}`, "going");
check("Bob says he's going", await pressed(bob, `gi-${swap}`) === "going" && tally().answers?.[bobPerson]?.answer === "going");
await cat.goto(`${C}/groups/${catGroup}`);
check("the event shows in Posts too", (await text(cat)).includes("Book swap") && (await text(cat)).includes("1 going"));
await answer(cat, `gi-${swap}`, "maybe");
check("Cat might go", tally().answers?.[catPerson]?.answer === "maybe");
await pause(2500);
check("…and no one is told who's going", tells() === quiet);
await bob.goto(`${B}/events?month=2027-06`);
check("Bob's Events calendar shows it, as a group's", (await bob.$$eval(".cal-event.cal-group", (es) => es.map((e) => e.textContent).join())).includes("Book swap"));
await cat.goto(`${C}/groups/${catGroup}/posts/${swap}`);
const who = await text(cat, ".event .answered");
check("the event's page names who's going", who.includes("Bob Example") && who.includes("You"), who);

// Changing it: words only, quietly; the time, and those going (or who might) are told.
await ann.goto(`${A}/groups/${annGroup}/posts/${swap}/edit`);
check("Ann's form shows the event as it is", await ann.$eval("form.event-form", (f) => f.elements.start_time.value === "19:00" && f.elements.end_time.value === "21:00"));
await ann.$eval("form.event-form", (f) => { f.elements.text.value = "Bring a book or two"; });
await Promise.all([ann.waitForNavigation(), ann.click("form.event-form button.primary")]);
await pause(2500);
check("changing only the words tells no one", tells() === quiet && (await text(ann)).includes("Bring a book or two"), `${quiet} -> ${tells()}`);
await ann.goto(`${A}/groups/${annGroup}/posts/${swap}/edit`);
await ann.$eval("form.event-form", (f) => { f.elements.start_time.value = "20:00"; f.elements.end_time.value = "22:00"; });
await Promise.all([ann.waitForNavigation(), ann.click("form.event-form button.primary")]);
check("changing the time tells Bob and Cat", await waitFor(() => groupNotices(stateB, "changed") === 1 && groupNotices(stateC, "changed") === 1));
check("…and not Ann, who changed it", groupNotices(stateA, "changed") === 0);
const moved = (hour) => ({ title: "Book swap", starts_at: Date.UTC(2027, 5, 12, hour) / 1000, ends_at: Date.UTC(2027, 5, 12, hour + 2) / 1000, all_day: 0,
  time_zone: "Europe/London", place: "Ann's house" });
check("changing it again straight away is refused", (await relaySigned(ann, annGroup, { kind: "change", host: groupPerson, item: swap, seen: point(swap),
  prev: lastSent(stateA, swap) }, { event: moved(17), text: "" })) === 400);
check("Bob's copy is brought up to date", JSON.parse(sql(stateB, `SELECT content FROM copies WHERE id = '${swap}'`)[0].content).event.starts_at === Date.UTC(2027, 5, 12, 19) / 1000);
await bob.goto(`${B}/activity`);
check("Bob's Notifications say what changed", (await text(bob)).includes("Ann Example changed an event you're going to in Book club (2026)")
  && (await text(bob)).includes("Sat 12 Jun 2027, 20:00–22:00"), (await text(bob)).slice(0, 400));
await cat.goto(`${C}/groups/${catGroup}/posts/${swap}`);
await answer(cat, `gi-${swap}`, "no");
check("Cat can't go after all", tally().answers?.[catPerson]?.answer === "no");
const ics = await bob.evaluate((p) => fetch(p).then(async (r) => ({ type: r.headers.get("Content-Type"), body: await r.text() })),
  `/groups/${bobGroup}/posts/${swap}/event.ics`);
check("Add to my calendar gives a calendar file", ics.type.startsWith("text/calendar") && ics.body.includes("SUMMARY:Book swap")
  && ics.body.includes("DTSTART:20270612T190000Z") && ics.body.includes("LOCATION:Ann's house"), ics.body.slice(0, 300));

// Only whoever added an event can change it; an admin can't call off the owner's; the group can't reword Ann's.
check("Bob can't change Ann's event", (await relaySigned(bob, bobGroup, { kind: "change", host: groupPerson, item: swap, seen: point(swap),
  prev: lastSent(stateB, swap) }, { event: { ...moved(18), title: "Hijacked" }, text: "x" })) === 400 && swapEvent().title === "Book swap");
check("Bob, an admin, can't call off the owner's event", (await relaySigned(bob, bobGroup, { kind: "calloff", host: groupPerson, item: swap, seen: point(swap),
  prev: lastSent(stateB, swap), about: swap }, null, { roleAt: true })) === 400 && !swapEvent().cancelled);
check("a made-up answer is refused", (await relaySigned(bob, bobGroup, { kind: "answer", host: groupPerson, item: swap, seen: point(swap),
  prev: lastSent(stateB, swap), version: sql(stateG, `SELECT version FROM items WHERE id = '${swap}'`)[0].version }, { answer: "definitely" })) === 400);
const marsEvent = await signedPost(bob, bobGroup, { type: "event", text: "", event: { ...moved(18), time_zone: "Mars/Olympus" } });
check("an event with a made-up time zone is refused", (await toGroup(stateB, B, marsEvent, [])) === 400);
const pastEvent = await signedPost(bob, bobGroup, { type: "event", text: "", event: { ...moved(18), starts_at: Date.UTC(2020, 0, 1, 19) / 1000, ends_at: null } });
check("…or one that's already over", (await toGroup(stateB, B, pastEvent, [])) === 400);
const swapContent = sql(stateG, `SELECT content FROM items WHERE id = '${swap}'`)[0].content;
sql(stateG, `UPDATE items SET content = '${swapContent.replace(/Book swap/g, "Forged swap").replace(/'/g, "''")}', changed_at = changed_at + 1 WHERE id = '${swap}'`);
await ann.goto(`${A}/groups/${annGroup}`);
check("Ann sees her event as she signed it, not the group's version", (await text(ann)).includes("Book swap") && !(await text(ann)).includes("Forged swap"));
sql(stateG, `UPDATE items SET content = '${swapContent.replace(/'/g, "''")}' WHERE id = '${swap}'`);
check("Ann can't move her event into the past", (await relaySigned(ann, annGroup, { kind: "change", host: groupPerson, item: swap, seen: point(swap),
  prev: lastSent(stateA, swap) }, { event: { ...moved(18), starts_at: Date.UTC(2020, 5, 12, 19) / 1000, ends_at: null }, text: "" })) === 400);

// Bob adds one and is going; Ann, the owner, calls it off (a signed calloff); Bob is told.
await bob.goto(`${B}/groups/${bobGroup}/calendar`);
await addEvent(bob, { title: "Pub quiz", start_date: "2027-07-01", start_time: "", place: "The Crown" });
const quiz = postBy(bobPerson).find((id) => JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${id}'`)[0].content).event?.title === "Pub quiz");
check("Bob adds an all-day event", JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${quiz}'`)[0]?.content ?? "{}").event?.all_day === 1
  && (await text(bob)).includes("Thu 1 Jul 2027"));
await answer(bob, `gi-${quiz}`, "going");
await ann.goto(`${A}/groups/${annGroup}/posts/${quiz}`);
await Promise.all([settled(ann), ann.click(".event form[data-sign='calloff'] button")]);
check("Ann calls it off", JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${quiz}'`)[0].content).event.cancelled === true
  && (await text(ann)).includes("Called off"));
check("…and Bob is told", await waitFor(() => groupNotices(stateB, "cancelled") === 1));
await bob.goto(`${B}/activity`);
check("Bob's Notifications say it's off", (await text(bob)).includes("Ann Example called off an event you were going to"), (await text(bob)).slice(0, 400));
await ann.setViewport({ width: 390, height: 844 });
await ann.goto(`${A}/groups/${annGroup}/calendar`);
await ann.screenshot({ path: `${OUT}/group-calendar-phone.png`, fullPage: true });
await ann.setViewport({ width: 1280, height: 800 });

// Polls are public in a group too (decision 10): everyone in it sees who chose what. Mentions are of members, by who
// they are; @here (the owner and admins) reaches everyone, but only the first a day reaches the phone.
async function mention(page, box, typed) {
  await page.type(box, typed);
  await page.waitForSelector("#mention-list:not([hidden]) li", { timeout: 5000 }).catch(() => {});
  const offered = await page.$$eval("#mention-list:not([hidden]) li", (l) => l.map((li) => li.firstChild.textContent));
  if (offered.length) await page.keyboard.press("Enter");
  return offered;
}
await cat.goto(`${C}/groups/${catGroup}`);
await cat.type("#composer textarea", "Next book?");
await cat.click("#composer .add-poll");
const optionBoxes = await cat.$$("#composer .poll-options input");
await optionBoxes[0].type("Dune");
await optionBoxes[1].type("Emma");
await Promise.all([cat.waitForNavigation({ timeout: 60_000 }), cat.click("#composer button.post")]);
const pollPost = postBy(catPerson).find((id) => JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${id}'`)[0].content).poll);
check("Cat asks a poll in the group, signed into her post", Boolean(pollPost));
await bob.goto(`${B}/groups/${bobGroup}`);
await Promise.all([settled(bob, { timeout: 30_000 }), bob.click(`#poll-${pollPost} button[value="0"]`)]);
await ann.goto(`${A}/groups/${annGroup}`);
await Promise.all([settled(ann, { timeout: 30_000 }), ann.click(`#poll-${pollPost} button[value="1"]`)]);
const pollVotes = () => JSON.parse(sql(stateG, `SELECT tally FROM items WHERE id = '${pollPost}'`)[0].tally).votes;
check("Bob and Ann answer it, each signed", pollVotes()[bobPerson] === 1 && pollVotes()[annPerson] === 2, JSON.stringify(pollVotes()));
await cat.goto(`${C}/groups/${catGroup}/posts/${pollPost}`);
const whoChose = await cat.$eval(`#poll-${pollPost} .poll-who`, (d) => d.textContent).catch(() => "");
check("…and everyone in it can see who chose what", whoChose.includes("Bob Example") && whoChose.includes("Ann Example"), whoChose);
await bob.goto(`${B}/groups/${bobGroup}/posts/${pollPost}`);
check("…Bob too, not only Cat who asked", (await bob.$eval(`#poll-${pollPost} .poll-who`, (d) => d.textContent).catch(() => "")).includes("Ann Example"));

// Cat mentions Bob in a comment on Ann's post: the group tells him, and so does Cat's own site, with the group's receipt.
await cat.goto(`${C}/groups/${catGroup}`);
if (!(await cat.$(`#gi-${annPost} details.comments[open]`))) await cat.click(`#gi-${annPost} details.comments summary`);
await cat.waitForSelector(`#gi-${annPost} form.say textarea`, { timeout: 15_000 });
const offeredToCat = await mention(cat, `#gi-${annPost} form.say textarea`, "Thanks! @Bo");
await cat.type(`#gi-${annPost} form.say textarea`, " what do you think?");
await Promise.all([settled(cat, { timeout: 30_000 }), cat.click(`#gi-${annPost} form.say button`)]);
check("Cat's @ list offers the group's members", offeredToCat.includes("@Bob Example"), offeredToCat.join());
const mentionFp = commentFp(annPost, "what do you think?");
const sentRecord = (state, fp) => JSON.parse(Buffer.from(JSON.parse(sql(state, `SELECT record FROM sent WHERE fp = '${fp}'`)[0]?.record ?? "{}").record ?? "", "base64url").toString() || "{}");
check("…her comment names Bob by who he is, signed", Boolean(mentionFp) && sentRecord(stateC, mentionFp).mentions?.includes(bobPerson));
check("Bob is told he's mentioned, once (the group's note and Cat's receipt are the same mention)", await waitFor(() => groupNotices(stateB, "mention") === 1)
  && await waitFor(() => n(stateB, `mention_receipts WHERE fp = '${mentionFp}' AND group_id IS NOT NULL`) === 1) && groupNotices(stateB, "mention") === 1);
check("…and his site checks the group shows him that very comment", await waitFor(() => n(stateB, `mention_receipts WHERE fp = '${mentionFp}' AND state = 'ok'`) === 1));
const stranger_ = `Z${annPerson.slice(1)}`;
check("Cat can't mention someone who isn't in the group", (await relaySigned(cat, catGroup, { kind: "comment", host: groupPerson, item: annPost, seen: point(annPost),
  prev: lastSent(stateC, annPost), mentions: [stranger_] }, { text: "Hi @Zed", mentions: [{ name: "Zed", person: stranger_ }] })) === 400);

// @here: Ann (the owner) writes to everyone; members' sites tell them, but only one a day per group reaches the phone.
await ann.goto(`${A}/groups/${annGroup}`);
const offeredToAnn = await mention(ann, "#composer textarea", "Meeting moved to Friday @he");
check("Ann's @ list offers @here on a new post", offeredToAnn.includes("@here"), offeredToAnn.join());
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
const herePost = postBy(annPerson).find((id) => JSON.parse(sql(stateG, `SELECT content FROM items WHERE id = '${id}'`)[0].content).here === true);
check("…signed as for everyone", Boolean(herePost));
check("Bob and Cat are told", await waitFor(() => groupNotices(stateB, "here") === 1 && groupNotices(stateC, "here") === 1));
await bob.goto(`${B}/activity`);
check("Bob's Notifications say Ann wrote to everyone", (await text(bob)).includes("Ann Example wrote to everyone (@here) in a post in Book club (2026)"), (await text(bob)).slice(0, 300));
await cat.goto(`${C}/groups/${catGroup}`);
check("Cat, a member, isn't offered @here", !(await mention(cat, "#composer textarea", "@he")).includes("@here"));
await cat.$eval("#composer textarea", (t) => { t.value = ""; });
const catHere = await signedPost(cat, catGroup, { type: "post", text: "Hello @here", here: true });
check("…and the group refuses one from her", (await toGroup(stateC, C, catHere, [])) === 403);

// Asking to be friends from a group's members, and introductions by friends. Nobody here is friends yet.
const ask = (page, from) => Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click(`li[data-from="${from}"] .friendship button`)]);
const friendship = (page, from) => page.$eval(`li[data-from="${from}"] .friendship`, (e) => e.innerText.trim()).catch(() => "");
const remoteGroup = sql(stateB, "SELECT remote_id FROM groups")[0].remote_id;
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("in a group, Bob can ask Ann and Cat to be friends", (await friendship(bob, A)) === "Ask to be friends"
  && (await friendship(bob, C)) === "Ask to be friends" && (await friendship(bob, B)) === "");
await ask(bob, C);
check("Bob asks Cat: his side is done, hers waits for her", n(stateB, `connections WHERE origin = '${C}' AND approved_at IS NOT NULL`) === 1
  && n(stateC, `connections WHERE origin = '${B}' AND approved_at IS NULL AND via_kind = 'group' AND via_name = 'Book club (2026)'`) === 1);
check("…and his page says he's asked", (await friendship(bob, C)) === "Asked", await friendship(bob, C));
// Asking without signing, for a site: as anyone could.
const askAs = (from, via) => fetch(`${C}/_connect/ask`, { method: "POST", headers: { "Afterwrd-From": from, "Content-Type": "application/json" },
  body: JSON.stringify({ via }) });
const probe = await askAs(B, { group: G, id: remoteGroup });
check("asking for a site you can't prove is yours says nothing about it (Bob's already asking)", probe.status === 403
  && (await probe.json()).error.startsWith("Without a friend link"));
check("a site that isn't in the group can't ask", (await askAs("http://localhost:8795", { group: G, id: remoteGroup })).status === 403);
check("…nor can one that wasn't introduced", (await askAs(A, { introduction: true })).status === 403);
check("…nor can a site in the group sign as another", (await siteCall(stateA, B, `${C}/_connect/ask`, { via: { group: G, id: remoteGroup } })).status === 403);
check("…and nothing was kept for them", n(stateC, "connections") === 1);
await cat.goto(`${C}/`);
check("Cat's Home says Bob is asking, from Book club", (await text(cat, "form.notice.asking")).includes("in Book club (2026) with you"), await text(cat, "form.notice.asking"));
await Promise.all([cat.waitForNavigation(), cat.click("form.notice.asking button.primary")]);
check("Cat approves: they're friends", n(stateC, `connections WHERE origin = '${B}' AND approved_at IS NOT NULL`) === 1);
await bob.goto(`${B}/`);
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("…and Bob's group page says so", (await friendship(bob, C)) === "Friends");

await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, C);
await cat.goto(`${C}/groups/${catGroup}/members`);
check("Cat's group page offers to approve Ann", (await friendship(cat, A)).includes("Approve"), await friendship(cat, A));
await Promise.all([cat.waitForNavigation(), cat.click(`li[data-from="${A}"] .friendship button`)]);
check("…which she does, staying on the page", n(stateC, `connections WHERE origin = '${A}' AND approved_at IS NOT NULL`) === 1
  && new URL(cat.url()).pathname === `/groups/${catGroup}/members`);

// Cat, friends with both, introduces Ann and Bob.
const catsAnn = sql(stateC, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
const catsBob = sql(stateC, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
await cat.goto(`${C}/`); // her site hears from Ann's, so she knows Ann approved her too
await cat.goto(`${C}/friend`);
check("Cat's friends each have an Introduce link", Boolean(await cat.$(`a[href="/_admin/connections/${catsAnn}/introduce"]`)));
await cat.goto(`${C}/_admin/connections/${catsAnn}/introduce`);
check("…offering her other friends", (await cat.$$eval("select[name=to] option", (l) => l.map((o) => o.textContent.trim()))).join() === "Bob Example");
await cat.select("select[name=to]", String(catsBob));
await cat.type("textarea[name=note]", "You both run book clubs");
await Promise.all([cat.waitForNavigation({ timeout: 30_000 }), cat.click("#introduce")]);
check("both are told", n(stateA, `introductions WHERE origin = '${B}' AND name = 'Bob Example' AND note = 'You both run book clubs'`) === 1
  && n(stateB, `introductions WHERE origin = '${A}' AND name = 'Ann Example'`) === 1, await text(cat, "body"));
check("introducing again changes nothing", (await siteCall(stateC, C, `${A}/_p/introduce`, { origin: B, name: "Someone else" })).status === 200
  && n(stateA, `introductions WHERE name = 'Bob Example'`) === 1);
check("only friends can introduce", (await siteCall(stateB, B, `${A}/_p/introduce`, { origin: C, name: "Cat" })).status === 401
  && (await fetch(`${A}/_p/introduce`, { method: "POST", headers: { "Afterwrd-From": C, "Content-Type": "application/json" }, body: "{}" })).status === 401);
await ann.goto(`${A}/`);
check("Ann's Home mentions it", (await text(ann, ".notice.introduction")).includes("Cat Example introduced you to localhost:8788, who they call Bob Example"), await text(ann, ".notice.introduction"));
await ann.goto(`${A}/friend`);
check("…and her Friends, with Cat's note", (await text(ann, "#introductions")).includes("You both run book clubs"));
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#introductions button.primary")]);
check("Ann asks Bob from the introduction", n(stateB, `connections WHERE origin = '${A}' AND approved_at IS NULL
  AND via_kind = 'introduction' AND via_name = 'Cat Example'`) === 1 && n(stateA, "introductions") === 0);
await bob.goto(`${B}/friend`);
check("Bob's Friends says Cat introduced them", (await text(bob, ".requests")).includes("Introduced by Cat Example"), await text(bob, ".requests"));
check("…in place of the introduction itself", !(await bob.$("#introductions")));
await Promise.all([bob.waitForNavigation(), bob.click('.requests button[formaction$="/decline"]')]);
check("Bob declines: Ann's site is told", await waitFor(() => n(stateA, `connections WHERE origin = '${B}'`) === 0)
  && n(stateB, `declined_asks WHERE origin = '${A}'`) === 1 && n(stateB, "introductions") === 0);
await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, B);
check("Ann can't ask again another way", (await text(ann, "body")).includes("already asked") && n(stateB, `connections WHERE origin = '${A}'`) === 0
  && n(stateA, `connections WHERE origin = '${B}'`) === 0);

// Several friends introduced to each other at once: Cat ticks Ann and Bob (finding Bob by typing), with a note.
await cat.goto(`${C}/_admin/connections/together`);
check("Introduce friends to each other lists Cat's friends to tick", (await cat.$$eval("input[name=friend]", (l) => l.map((b) => b.dataset.name))).join() === "Ann Example,Bob Example"
  && await cat.$eval("#together-go", (b) => b.disabled));
await cat.type("#together-filter", "an");
check("…typing narrows the list", (await cat.$$eval(".together-friend:not([hidden])", (l) => l.map((x) => x.textContent.trim()))).join() === "Ann Example");
await cat.click(`input[name=friend][value="${catsAnn}"]`);
await cat.$eval("#together-filter", (i) => { i.value = ""; });
await cat.type("#together-filter", "bo");
check("…keeping anyone ticked", (await cat.$$eval(".together-friend:not([hidden])", (l) => l.map((x) => x.textContent.trim()))).join() === "Ann Example,Bob Example"
  && (await cat.$$eval(".together-friend[hidden]", (l) => l.length)) === 0);
await cat.click(`input[name=friend][value="${catsBob}"]`);
await cat.type("textarea[name=note]", "Book club, all of you");
await cat.click("#together-go");
await cat.waitForFunction(() => document.querySelectorAll("#together-log li").length === 2 && ![...document.querySelectorAll("#together-log li")].some((l) => l.textContent.endsWith("…")), { timeout: 30_000 })
  .catch(async () => { throw new Error(`Introducing stuck: ${await cat.$eval("main", (m) => m.textContent.replace(/\s+/g, " ").slice(-400))} / go disabled: ${await cat.$eval("#together-go", (b) => b.disabled)} / url: ${cat.url()} / errors: ${errors.join(" | ")}`); });
const togetherLog = await cat.$$eval("#together-log li", (l) => l.map((x) => x.textContent));
check("…each is told about the others, one at a time", togetherLog.join() === "Told Ann Example ✓,Told Bob Example ✓", togetherLog.join(" | "));
check("…as introductions with the note (Bob, who declined Ann, isn't bothered again)", n(stateA, `introductions WHERE origin = '${B}' AND note = 'Book club, all of you'`) === 1
  && n(stateB, `introductions WHERE origin = '${A}'`) === 0);
check("…and only friends can be introduced", (await cat.evaluate(() => fetch("/_admin/connections/together", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to: 999, others: [1] }) }).then((r) => r.status))) === 400);
await bob.goto(`${B}/groups/${bobGroup}/members`);
await ask(bob, A);
check("Bob can still ask Ann himself", n(stateA, `connections WHERE origin = '${B}' AND approved_at IS NULL`) === 1 && n(stateB, "declined_asks") === 0);
await ann.goto(`${A}/friend`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("…and Ann approves", n(stateA, `connections WHERE origin = '${B}' AND approved_at IS NOT NULL`) === 1);
await bob.goto(`${B}/`);
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/groups/${bobGroup}/members`);
await bob.screenshot({ path: `${OUT}/group-members-friends-phone.png`, fullPage: true });
await bob.setViewport({ width: 1280, height: 800 });
const annAtBob = sql(stateB, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id;
check("Bob removes Ann", (await post(bob, `/_admin/connections/${annAtBob}/disconnect`, {})).ok === true && n(stateA, `connections WHERE origin = '${B}'`) === 0);
await ann.goto(`${A}/groups/${annGroup}/members`);
await ask(ann, B);
check("…and she can't ask again from the group", (await text(ann, "body")).includes("already asked") && n(stateB, `connections WHERE origin = '${A}'`) === 0);

// Leaving and removing.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click(`button[data-group-record="role"][data-role="member"][data-about="${bobJoin}"]`)]);
await bob.goto(`${B}/groups/${bobGroup}/members`);
check("Ann takes Bob's admin role back", (await bob.$$eval(".member-list button[data-group-record]", (l) => l.length)) === 0);
check("…and he can no longer remove anything", (await relaySigned(bob, bobGroup, { kind: "remove", host: groupPerson, item: bobPost, seen: point(bobPost),
  prev: lastSent(stateB, bobPost), about: commentFp(bobPost, "The one we picked!") }, null, { roleAt: true })) === 400);
await Promise.all([bob.waitForNavigation(), bob.click('button[data-group-record="leave"]')]);
check("Bob leaves", n(stateB, "groups") === 0 && n(stateG, `group_members WHERE origin = '${B}'`) === 0);
check("…keeping his own record of what he signed there", n(stateB, `sent WHERE item = '${bobPost}' AND kind = 'item'`) === 1);
check("…and forgetting the group's posts and notices", n(stateB, "copies WHERE group_id IS NOT NULL") === 0 && n(stateB, "notices WHERE group_id IS NOT NULL") === 0);
check("…whose posts stay in the group", n(stateG, `items WHERE id = '${bobPost}'`) === 1);
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('button[data-group-record="remove"]')]);
check("Ann removes Cat, and Cat's site forgets the group", await waitFor(() => n(stateC, "groups") === 0));
check("…and the group's list says so, signed by Ann", n(stateG, `lists WHERE id = '${groupDoc.person}' AND n = 8`) === 1);
check("Cat's site no longer gets in", (await call(G, "/_p/items", catKey)).status === 401);
check("the owner can't just leave", (await ann.evaluate((p) => fetch(p, { method: "POST" }).then((r) => r.status), `/_groups/${annGroup}/leave`)) === 400);

// Deleting the group empties it, and Ann's site forgets it.
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click("#delete-go")]);
check("deleting the group empties its Worker", n(stateG, "groups") + n(stateG, "items") + n(stateG, "lists") + n(stateG, "list_pages")
  + n(stateG, "media") + n(stateG, "group_members") === 0);
check("…and Ann's site forgets it", n(stateA, "groups") === 0 && new URL(ann.url()).pathname === "/groups");
check("the invite link stops working", (await fetch(link)).status === 404);

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
