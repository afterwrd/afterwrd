// Comments end to end: the owner imports a tiny export, whose posts and photos take no comments (for now), writes two
// posts (one with a picture that's also in the import) and comments on a post and a photo; their own comments aren't
// counted as new, cross-site and bad input refused, the burst limit, and comments survive a re-import. (Friends'
// comments, which arrive from their own sites, are in feed.mjs.)
//   node comments.mjs <zip>
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled, sql, setUpSigning } from "./helpers.mjs";
const WORKER = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const cli = (...a) => execFileSync("node", ["scripts/owner.mjs", ...a, "--local"], { cwd: WORKER, encoding: "utf8" });
// Each suite starts on a new site (run.sh), and makes its owner from the terminal: the link to add their first device.
const newOwner = (name) => cli(name).match(/http\S+\/_auth\/device\/\S+/)[0];
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function person(link) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  // afterwrd asks in its own box (ui.js): say yes, as a person would.
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(link);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  return page;
}
async function importZip(page) {
  await page.goto(`${BASE}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes) => boxes.forEach((b) => { b.checked = ["posts", "photos"].includes(b.value); }));
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}
async function say(page, scope, text) {
  // A post's comments are behind its button (views/items.js): pressed first, as a person would.
  // (Unless a comment box is already showing, as a photo's own on its page.)
  if (!(await page.$(`${scope} .say textarea`)) && (await page.$(`${scope} details.comments`)) && !(await page.$(`${scope} details.comments[open]`))) {
    await page.click(`${scope} details.comments summary`);
  }
  await page.waitForSelector(`${scope} .say textarea`, { timeout: 10_000 });
  await page.type(`${scope} .say textarea`, text);
  await Promise.all([settled(page), page.click(`${scope} .say button`)]);
}
const openThread = async (card) => {
  if (!(await owner.$(`${card} details.comments[open]`))) await owner.click(`${card} details.comments summary`);
  await owner.waitForSelector(`${card} .say textarea`, { timeout: 10_000 });
};
const bubbles = (page, scope) => page.$$eval(`${scope} .comment:not(.gone)`, (l) => l.map((c) => ({
  id: c.id, name: c.querySelector(".bubble strong").textContent, text: c.querySelector(".said").textContent,
  canDelete: Boolean(c.querySelector(".under .delete")),
})));
const badge = (page) => page.$eval('header.site a[href="/activity"]', (a) => a.querySelector(".count")?.firstChild.textContent ?? "");

const ownerName = `Owner <b>${Date.now()}</b>`;
const owner = await person(newOwner(ownerName));
await setUpSigning(owner);
check("tiny export imports", !(await importZip(owner)));

// Facebook's posts and photos take no comments, for now: their addresses may not survive a new download.
await owner.goto(`${BASE}/posts`);
check("imported posts have no comment box", (await owner.$$("article.card")).length === 2 && !(await owner.$("article.card .say")));
const [imported] = sql("SELECT id, hash, thumb_hash, width, height, size FROM media WHERE source = 'facebook' AND kind = 'photo' AND thumb_hash IS NOT NULL ORDER BY id LIMIT 1");
await owner.goto(`${BASE}/photos/${imported.id}`);
check("an imported photo has no comment box", Boolean(await owner.$(".info")) && !(await owner.$(".info .say")));
check("…and there's no way to comment unsigned any more", ![200, 302, 303].includes(await owner.evaluate((target) => fetch("/_comments", { method: "POST", redirect: "manual",
  body: new URLSearchParams({ target, text: "x", back: "/posts" }) }).then((r) => r.status), `photo-${imported.hash}`)));

// Two posts written here, signed in the page with this browser's key as the composer signs them (afterwrd 2): words,
// then a picture that's also in the import (its file is already stored).
const write = (content, photos = [], which = "own") => owner.evaluate(async (content, photos, which) => {
  const [{ makeRecord }, { savedKey }, { newKeyPair, publicKeyText }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js"), import("/static/signed.js")]);
  const own = await savedKey();
  let key = own;
  if (which === "stranger") { const pair = await newKeyPair(); key = { privateKey: pair.privateKey, publicKey: await publicKeyText(pair.publicKey) }; }
  const fields = { kind: "item", author: own.person, host: own.person };
  const made = [];
  for (const p of photos) made.push(await makeRecord(fields, { type: "photo", ...p }, key));
  const post = await makeRecord(fields, { ...content, photos: photos.map((p, i) => ({ item: made[i].fp, ...p })) }, key);
  return (await fetch("/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: post.sent, photos: made.map((m) => m.sent) }) })).status;
}, content, photos, which);
check("a post written here", (await write({ type: "post", text: "Written on afterwrd" })) === 200);
check("…and one with a picture from the import", (await write({ type: "post", text: "" }, [{ hash: imported.hash, thumb_hash: imported.thumb_hash,
  width: imported.width, height: imported.height, size: imported.size }])) === 200);

// The owner comments on their newest post, including some HTML and a link.
await owner.goto(`${BASE}/posts`);
const firstCard = "article.card:first-of-type";
check("each post written here has its comments behind a button, and only those", (await owner.$$("article.card details.comments")).length === 2
  && (await owner.$$("article.own details.comments")).length === 2
  && (await owner.$$eval("article.own details.comments summary", (l) => l.map((x) => x.textContent))).every((t) => t === "Comment"));
await say(owner, firstCard, "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("posting stays on the page", new URL(owner.url()).pathname === "/posts" && !new URL(owner.url()).hash, owner.url());
let shown = await bubbles(owner, firstCard);
check("comment shows straight away, text kept as typed", shown.length === 1 && shown[0].text === "Lovely <script>alert(1)</script>\nsecond line https://example.com");
check("names and text are escaped, link is a link", !(await owner.$(`${firstCard} .said script`)) && !(await owner.$(`${firstCard} .bubble strong b`))
  && (await owner.$eval(`${firstCard} .said a`, (a) => a.href)) === "https://example.com/");
check("owner can delete their own", shown[0].canDelete);

// The post's own page.
const postHref = await owner.$eval(`${firstCard} a.when`, (a) => a.getAttribute("href"));
await owner.goto(BASE + postHref);
check("post has its own page with the thread", (await bubbles(owner, "article.card")).length === 1, postHref);
check("…and, with a comment, its button says Comments", (await owner.$eval("article.card details.comments summary", (x) => x.textContent)) === "Comments");

// A comment on the photo posted here.
await owner.goto(`${BASE}/posts`);
// The photo's own address (from a post, its link also says which post it came from: ?in=post&back=…).
const photoHref = await owner.$eval(`${firstCard} .collage a.tile`, (a) => new URL(a.href).pathname);
await owner.goto(BASE + photoHref);
await say(owner, ".info", "Great photo");
check("photo comment shows in the info panel", (await bubbles(owner, ".info")).map((c) => c.text).join() === "Great photo");
// A photo posted here is an item of its own (afterwrd 2): its comments are its, not its file's, so the imported copy
// of the same picture has none.
await owner.goto(`${BASE}/photos/${imported.id}`);
check("…and not on the same picture's imported copy", (await bubbles(owner, ".info")).length === 0 && !(await owner.$(".info .say")));
// (Notifications for comments on signed posts come with step 4c: docs/signed-conversations.md.)
await owner.goto(`${BASE}/posts`);
check("own comments don't count as new", (await badge(owner)) === "", await badge(owner));

// Refused: another site, an unknown post, unsigned, signed by a key nobody allowed, too long, an off-site redirect,
// and nobody signed in. Each made as the page would (afterwrd 2: a record signed from the comment form's data-sign-*).
const cookie = (await owner.cookies()).find((c) => c.name === "__Host-session").value;
const postId = postHref.split("/").pop();
const signedComment = (text, { which = "own", back = "/posts", item = postId } = {}) => owner.evaluate(async (id, text, which, back, item) => {
  const [{ makeRecord }, { savedKey }, { newKeyPair, publicKeyText }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js"), import("/static/signed.js")]);
  const doc = new DOMParser().parseFromString(await (await fetch(`/posts/${id}`)).text(), "text/html");
  const d = doc.querySelector("form.say").dataset;
  const own = await savedKey();
  let key = own;
  if (which === "stranger") { const pair = await newKeyPair(); key = { privateKey: pair.privateKey, publicKey: await publicKeyText(pair.publicKey) }; }
  const made = await makeRecord({ kind: "comment", author: own.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null }, { text }, key);
  return JSON.stringify(made.sent);
}, postId, text, which, back, item);
const send = async (body, origin = BASE, item = postId) => fetch(`${BASE}/_admin/items/${item}/records`, { method: "POST", redirect: "manual",
  headers: { Cookie: `__Host-session=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
await owner.goto(`${BASE}/posts`);
check("comment from another site refused", (await send({ sent: await signedComment("x"), back: "/posts" }, "https://evil.example")).status === 403);
check("a comment on a post that isn't here refused", (await send({ sent: await signedComment("x"), back: "/posts" }, BASE, "y".repeat(43))).status === 400);
check("an unsigned comment refused", (await send({ text: "x", back: "/posts" })).status === 400);
check("one signed with a key nobody allowed refused", (await send({ sent: await signedComment("x", { which: "stranger" }), back: "/posts" })).status === 400);
check("over 2000 characters refused", (await send({ sent: await signedComment("x".repeat(2001)), back: "/posts" })).status === 400);
const offsite = await send({ sent: await signedComment("redirect test"), back: "https://evil.example/" });
check("back can't leave the site", offsite.status === 303 && new URL(offsite.headers.get("location"), BASE).origin === new URL(BASE).origin, offsite.headers.get("location"));
check("signed-out comment refused", (await fetch(`${BASE}/_admin/items/${postId}/records`, { method: "POST", redirect: "manual", headers: { Origin: BASE },
  body: new URLSearchParams({ text: "x" }) })).status === 401);
// (One person can add at most 20 entries to a post: tested in lists.mjs and posts.mjs.)
// The redirect test's comment, deleted again from its menu.
await owner.goto(BASE + postHref);
const stray = (await bubbles(owner, "article.card")).find((c) => c.text === "redirect test");
await owner.click(`#${stray.id} .under details.more summary`);
await Promise.all([settled(owner), owner.click(`#${stray.id} .under .delete`)]);

// Changing a comment (edits.js): for 15 minutes, and until someone else comments after it.
await owner.goto(`${BASE}/posts`);
await openThread(firstCard);
const firstComment = `${firstCard} .comment:first-of-type`;
const editComment = async (scope, words) => {
  await owner.click(`${scope} .under details.more summary`);
  await owner.click(`${scope} .under details.more a[href^="#edit"]`);
  await owner.$eval(`${scope} div.edit textarea`, (t, w) => { t.value = w; }, words);
  await Promise.all([settled(owner), owner.click(`${scope} div.edit button`)]);
};
check("the owner's comment offers Edit", Boolean(await owner.$(`${firstComment} div.edit`)));
await editComment(firstComment, "Lovely, changed");
check("the new words show, marked Edited, with what it said before", (await bubbles(owner, firstCard))[0].text === "Lovely, changed"
  && (await owner.$eval(`${firstComment} details.edited .versions`, (l) => l.textContent)).includes("Lovely <script>alert(1)</script>"));
await say(owner, firstCard, "Another thought");
check("the owner's own next comment doesn't stop them changing the first", Boolean(await owner.$(`${firstComment} div.edit`)));
check("…and the owner's own comments don't stop the post being changed", Boolean(await owner.$(`${firstCard} > div.edit`)));
// (Someone else's comment after it stopping a change is tested in lists.mjs; friends' comments come with step 4b.)
// "Another thought", deleted again.
const another = (await bubbles(owner, firstCard)).find((c) => c.text === "Another thought");
await owner.click(`#${another.id} .under details.more summary`);
await Promise.all([settled(owner), owner.click(`#${another.id} .under .delete`)]);

// A second comment, deleted again; the rest survive a re-import.
await owner.goto(`${BASE}/posts`);
await say(owner, firstCard, "Thanks!");
const before = (await bubbles(owner, firstCard)).length;
const last = (await bubbles(owner, firstCard)).at(-1).id;
await owner.click(`#${last} .under details.more summary`);
await Promise.all([settled(owner), owner.click(`#${last} .under .delete`)]);
check("owner deletes a comment", (await bubbles(owner, firstCard)).length === before - 1);
const beforeImport = (await bubbles(owner, firstCard)).length;
check("re-import finishes", !(await importZip(owner)));
await owner.goto(`${BASE}/posts`);
await openThread(firstCard);
check("post comments survive a re-import", beforeImport > 0 && (await bubbles(owner, firstCard)).length === beforeImport, `${(await bubbles(owner, firstCard)).length} after, page had ${beforeImport}`);
await owner.goto(BASE + photoHref);
check("photo comment survives a re-import", (await bubbles(owner, ".info")).length === 1);
await owner.goto(`${BASE}/posts`);
check("…and the posts written here keep their addresses", sql("SELECT COUNT(*) AS n FROM items WHERE type = 'post'")[0].n === 2
  && (await owner.$eval(`${firstCard} a.when`, (a) => a.getAttribute("href"))) === postHref);

// Offline (public/static/app/push-sw.js) and what's being written (ui.js): a comment typed and not sent is kept on the
// device; one sent with no connection stays in its box, saying so, and goes once connected.
await owner.goto(`${BASE}/posts`);
await owner.evaluate(() => navigator.serviceWorker.ready);
await owner.reload(); // so the service worker looks after the page
const box = `${firstCard} .say textarea`;
await openThread(firstCard);
await owner.type(box, "Half-written");
await owner.goto(`${BASE}/posts`); // a fresh visit: a reload could have the browser put the words back by itself
await openThread(firstCard);
check("a comment that isn't sent is still there after a reload", (await owner.$eval(box, (t) => t.value)) === "Half-written");
const worker = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(BASE))).createCDPSession();
await worker.send("Network.enable"); // without it, the worker's own requests ignore "offline"
const offline = async (on) => { // the worker first: the page reloads itself as soon as it's back online
  await worker.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await owner.setOfflineMode(on);
};
const countBefore = sql(`SELECT n FROM lists WHERE id = '${postId}'`)[0].n;
await owner.evaluate(() => { window.samePage = true; });
await offline(true);
await Promise.all([settled(owner), owner.click(`${firstCard} .say button`)]);
check("sending with no connection says so, on the same page, words still in the box",
  (await owner.evaluate(() => window.samePage)) && (await owner.$eval(box, (t) => t.value)) === "Half-written"
  && /not connected/.test(await owner.$eval(`${firstCard} .say + .form-error`, (p) => p.textContent).catch(() => "")));
check("…and nothing was sent", sql(`SELECT n FROM lists WHERE id = '${postId}'`)[0].n === countBefore);
await owner.click(`${firstCard} .comment:first-of-type .under details.more summary`);
await Promise.all([settled(owner), owner.click(`${firstCard} .comment:first-of-type .under .delete`)]);
check("a Delete that can't go says so where it can be seen, not in its closed menu",
  await owner.$eval(`${firstCard} .comment:first-of-type .under details.more + .form-error`, (p) => p.checkVisibility() && /not connected/.test(p.textContent)).catch(() => false));
check("…and the post's buttons and boxes work again", !(await owner.$(`${firstCard} button:disabled`)) && !(await owner.$(`${firstCard} textarea[readonly]`)));
check("…with no faded copy of the comment left behind", !(await owner.$(".comment.pending")) && !(await owner.$("button.busy")));
await offline(false);
// Watched for: the comment showing at once, faded, while it's sent (ui.js pendingComment).
await owner.evaluate(() => {
  window.sawPending = "";
  new MutationObserver((changes, watching) => {
    const pending = document.querySelector(".comment.pending");
    if (!pending) return;
    window.sawPending = `${pending.querySelector(".said").textContent}|${pending.querySelector(".sending").textContent}`;
    watching.disconnect();
  }).observe(document.body, { childList: true, subtree: true });
});
const answered = owner.waitForResponse((r) => new URL(r.url()).pathname === `/_admin/items/${postId}/records` && r.request().method() === "POST");
await Promise.all([settled(owner), owner.click(`${firstCard} .say button`)]);
const answer = await answered;
check("a comment shows at once, faded and saying Sending…", (await owner.evaluate(() => window.sawPending)) === "Half-written|Sending…");
check("…and the site sends the redrawn page back with its answer: one trip, not two",
  answer.status() === 200 && answer.headers()["afterwrd-redrawn"] === "1" && !(await owner.$(".comment.pending")));
check("sent once connected, still on the same page, with no note left", (await owner.evaluate(() => window.samePage))
  && sql(`SELECT n FROM lists WHERE id = '${postId}'`)[0].n === countBefore + 1
  && (await bubbles(owner, firstCard)).at(-1).text === "Half-written" && !(await owner.$(`${firstCard} .form-error`)));
const drafts = await owner.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("afterwrd-draft:")));
check("…the box is empty, and the words no longer kept on the device", (await owner.$eval(box, (t) => t.value)) === "" && drafts.length === 0,
  `box: ${JSON.stringify(await owner.$eval(box, (t) => t.value).catch(() => "?"))}, drafts: ${drafts.join(", ")}, this post: ${postId}, `
  + `kept: ${await owner.evaluate((k) => localStorage.getItem(k), drafts[0] ?? "").catch(() => "")}, page: ${owner.url()}`);
await offline(true);
const gone = await owner.goto(`${BASE}/activity`);
check("a page opened with no connection says so, with Try again", gone.status() === 503
  && (await owner.$eval("h1", (h) => h.textContent)) === "You're offline" && (await owner.$eval("main button", (b) => b.textContent)) === "Try again");
await offline(false);
check("…and loads by itself once connected", await owner.waitForSelector("header.site", { timeout: 15_000 }).then(() => true, () => false));

// Phone layout: nothing wider than the screen.
await owner.setViewport({ width: 375, height: 800, isMobile: true });
await owner.goto(`${BASE}/posts`);
check("no sideways scrolling on a phone", await owner.evaluate(() => document.documentElement.scrollWidth <= 375));
// Sending a comment doesn't make the page jump (ui.js): no new page, nothing above it moves, and the new comment
// shows where its box was. On Home, just that post is fetched again.
const settle = () => new Promise((r) => setTimeout(r, 1200));
const onScreen = (selector) => owner.evaluate((sel) => {
  const el = sel ? document.querySelector(sel) : document.getElementById(decodeURIComponent(location.hash.slice(1)));
  return { top: Math.round(el.getBoundingClientRect().top), header: Math.round(document.querySelector("header.site").getBoundingClientRect().bottom),
    // A short page (a post's own page) can't scroll a comment all the way up: then it's enough that it's in view.
    atEnd: scrollY + innerHeight >= document.documentElement.scrollHeight - 2, inView: el.getBoundingClientRect().bottom <= innerHeight };
}, selector);
for (const where of ["/posts", "/"]) {
  await owner.goto(`${BASE}${where}`);
  await openThread("article.card:first-of-type");
  await owner.evaluate(() => { const box = document.querySelector("article.card .say"); scrollBy(0, box.getBoundingClientRect().top - 450); });
  const box = await onScreen("article.card .say");
  const before = await owner.evaluate(() => { window.samePage = true; return scrollY; });
  await say(owner, "article.card:first-of-type", `Where it lands ${where}`);
  await settle();
  const landed = await owner.evaluate(() => {
    const el = [...document.querySelectorAll("article.card:first-of-type .comment")].at(-1);
    return { top: Math.round(el.getBoundingClientRect().top), text: el.querySelector(".said").textContent, scrollY, samePage: window.samePage };
  });
  check(`a new comment shows where its box was, and the page doesn't move (${where})`, landed.samePage && landed.scrollY === before
    && landed.text === `Where it lands ${where}` && Math.abs(landed.top - box.top) <= 4, `box at ${box.top}, comment at ${landed.top}, scrolled ${landed.scrollY - before}`);
  if (where === "/") check("…and on Home, the fresh copy's links still come back to Home", await owner.$$eval("article.card:first-of-type input[name=back]",
    (l) => l.length > 0 && l.every((i) => i.value === "/")));
}
// A link to a comment goes to its post's own page, where its comments are open.
await owner.goto(BASE + postHref);
const linked = (await bubbles(owner, "article.card")).find((c) => c.text === "Where it lands /posts").id;
await owner.goto(`${BASE}${postHref}#${linked}`);
await settle();
const opened = await onScreen();
check("a link to a comment shows it just below the header (or as far up as the page goes)", opened.top > opened.header
  && (opened.top < opened.header + 40 || (opened.atEnd && opened.inView)),
  `comment at ${opened.top}, header to ${opened.header}`);
await owner.screenshot({ path: `${OUT}/comments-phone.png`, fullPage: true });
await owner.setViewport({ width: 1280, height: 900 });
await owner.goto(`${BASE}/activity`);
await owner.screenshot({ path: `${OUT}/activity.png`, fullPage: true });
await owner.goto(BASE + photoHref);
await owner.screenshot({ path: `${OUT}/photo-comments.png` });

// Filters send themselves when a choice is picked (ui/autosubmit.js: no inline onchange under the pages' policy).
await owner.goto(`${BASE}/posts`);
const pick = await owner.$$eval("select[data-autosubmit]", (all) => all.map((s) => ({ name: s.name, value: [...s.options].map((o) => o.value).find(Boolean) }))
  .find((p) => p.value) ?? null);
if (pick) await Promise.all([owner.waitForNavigation(), owner.select(`select[name=${pick.name}]`, pick.value)]);
check("picking in a filter's list sends it", Boolean(pick) && new URL(owner.url()).searchParams.get(pick.name) === pick.value, `${JSON.stringify(pick)} ${owner.url()}`);

// Words kept on the device go on Sign out (it may be a shared phone).
await owner.goto(`${BASE}/posts`);
await openThread(firstCard);
await owner.type(box, "Not for the next person");
await Promise.all([owner.waitForNavigation(), owner.$eval('form[action="/_auth/logout"]', (f) => f.requestSubmit())]);
check("signing out clears what was being written", (await owner.evaluate(() => Object.keys(localStorage)
  .filter((k) => k.startsWith("afterwrd-draft:")).length)) === 0);

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
