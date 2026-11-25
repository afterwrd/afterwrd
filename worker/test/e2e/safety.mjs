// Safety (docs/safety-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's (G, 8790). Ann
// is friends with Bob and with Cat. Step 1, on Ann's own post: she removes Bob's comment, openly (Cat sees she did); she
// turns comments off, which covers its photo, refuses Bob's comment from a page he'd opened before, and leaves Ann able
// to have the last word; then on again, and Bob's comment goes in. Step 2, mute: Ann mutes Bob from his post on Home;
// his posts leave Home but not his page, his comments still show, and Friends lists him, with Unmute. In Ann's group,
// muting Bob folds his posts there to a line, and his post's own page still shows it.
//   node safety.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import puppeteer from "puppeteer-core";
import { count as n, letInto, settled, siteSql as sql, setUpSigning, signedGroupPost, startSignedGroup } from "./helpers.mjs";
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
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await test()) return true;
  return false;
};

// --- people and friends (as mentions.mjs) -------------------------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(`${site}: ${m.text()}`); });
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
const text = (page, selector = "main") => page.$eval(selector, (m) => m.innerText).catch(() => "");
/** Opens the post's comments if they're behind its button. */
async function openComments(page) {
  if (!(await page.$("article.card details.comments[open]")) && (await page.$("article.card details.comments"))) {
    await page.click("article.card details.comments summary");
  }
}
/** Writes a comment in the post on this page (in place); returns what the page then says under the box, if anything. */
async function comment(page, words) {
  await openComments(page);
  await page.waitForSelector("article.card .say textarea", { timeout: 15_000 });
  // Words a refused comment left behind (kept as a draft, drafts.js) are cleared first.
  await page.$eval("article.card .say textarea", (t) => { t.value = ""; });
  await page.type("article.card .say textarea", words);
  await Promise.all([settled(page), page.click("article.card .say button")]);
  return page.$eval("article.card .form-error", (p) => p.textContent).catch(() => "");
}
const comments = (page) => page.$$eval("article.card .comment:not(.gone) .said", (l) => l.map((s) => s.textContent));
/** Presses `button` (a selector) in a ⌄ menu (`menu`, the details.more it's in), in place. */
async function fromMenu(page, menu, button) {
  await page.click(`${menu} > summary`);
  await Promise.all([settled(page), page.click(`${menu} ${button}`)]);
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2);

// Ann's post, with a photo (so comments off is seen to cover it too).
await ann.goto(`${A}/posts`);
await ann.type("#composer textarea", "Picnic on Sunday");
await (await ann.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
const postId = sql(stateA, "SELECT id FROM items WHERE type = 'post'")[0]?.id;
const photoId = sql(stateA, `SELECT photo FROM item_photos WHERE post = '${postId}'`)[0]?.photo;
check("Ann's post is there, with its photo", Boolean(postId && photoId));
const annOn = (state, site) => `${site}/friend/${sql(state, `SELECT id FROM connections WHERE origin = '${A}'`)[0].id}/posts/${postId}`;
const onB = annOn(stateB, B);
const onC = annOn(stateC, C);
const annsPage = `${A}/posts/${postId}`;

// --- Remove, on your own post ---------------------------------------------------------------------------------------------

await bob.goto(onB);
check("Bob comments on Ann's post", (await comment(bob, "Count me in")) === "");
await cat.goto(onC);
check("…and so does Cat", (await comment(cat, "Me too")) === "");
await ann.goto(annsPage);
await openComments(ann);
check("Ann can remove each of their comments", (await ann.$$("article.card .comment form[data-sign=remove]")).length === 2);
check("…which says everyone will see she did", (await ann.$eval('.comment[data-name="Bob Example"] form[data-sign=remove]', (f) => f.dataset.confirm))
  === "Remove this comment? Everyone who can see the post will see you removed it.");
check("…and it isn't signed as a group's", !(await ann.$('.comment[data-name="Bob Example"] form[data-sign=remove][data-sign-group]')));
await fromMenu(ann, '.comment[data-name="Bob Example"] details.more', "form[data-sign=remove] button");
await ann.goto(annsPage);
await openComments(ann);
check("Bob's comment is gone from Ann's post", !(await comments(ann)).includes("Count me in") && (await comments(ann)).includes("Me too"));
check("…and Ann's page says she removed it", (await text(ann)).includes("You removed a comment."));
await cat.goto(onC);
await openComments(cat);
check("Cat sees it was removed, and by Ann", (await text(cat)).includes("A comment was removed by Ann Example.") && !(await comments(cat)).includes("Count me in"));
await bob.goto(onB);
await openComments(bob);
check("…and so does Bob", (await text(bob)).includes("A comment was removed by Ann Example."));

// --- Comments off, and on again -------------------------------------------------------------------------------------------

// Bob has the post open, with its comment box, before Ann turns comments off.
await bob.goto(onB);
await openComments(bob);
await ann.goto(annsPage);
check("Ann's post offers to turn comments off", Boolean(await ann.$('article.own header form[action$="/comments"] input[name=off][value="1"]')));
await fromMenu(ann, "article.own header details.more", 'form[action$="/comments"] button');
check("…which covers the post and its photo", n(stateA, `items WHERE comments_off_at IS NOT NULL AND id IN ('${postId}', '${photoId}')`) === 2);
await ann.goto(annsPage);
await openComments(ann);
check("Ann's post says comments are off, and now offers to turn them on", (await text(ann)).includes("You've turned comments off: only you can comment now.")
  && Boolean(await ann.$('article.own header form[action$="/comments"] input[name=off][value="0"]')));
const refused = await comment(bob, "Still coming?");
check("Bob's comment from the page he had open is refused, saying why", refused === "Couldn't send it: Comments are turned off on this post.", refused);
check("…and isn't on Ann's post", !sql(stateA, `SELECT entries FROM list_pages WHERE list = '${postId}'`).some((r) => r.entries.includes("Still coming")));
await bob.goto(onB);
await openComments(bob);
check("Opened again, Bob's page says comments are off, with no box", (await text(bob)).includes("Comments are turned off.") && !(await bob.$("article.card .say textarea")));
await bob.goto(`${onB}/photos/1`);
check("…and so does the photo's page", (await text(bob)).includes("Comments are turned off.") && !(await bob.$(".say textarea")));
await ann.goto(annsPage);
check("Ann can still have the last word", (await comment(ann, "See you all there")) === "");
await ann.goto(annsPage);
await openComments(ann);
check("…and it's there", (await comments(ann)).includes("See you all there"));

await fromMenu(ann, "article.own header details.more", 'form[action$="/comments"] button');
check("Turned on again, for the post and its photo", n(stateA, `items WHERE comments_off_at IS NOT NULL`) === 0);
await bob.goto(onB);
check("Bob can comment again", (await comment(bob, "Still coming?")) === "");
await ann.goto(annsPage);
await openComments(ann);
check("…and Ann sees it", (await comments(ann)).includes("Still coming?"));

// --- Mute (step 2) -------------------------------------------------------------------------------------------------------

await bob.goto(`${B}/posts`);
await bob.type("#composer textarea", "Bike ride this morning");
await Promise.all([bob.waitForNavigation({ timeout: 60_000 }), bob.click("#composer button.post")]);
const bobsCards = async () => { await ann.goto(`${A}/`); return ann.$$eval("article.from-friend", (l) => l.filter((a) => a.dataset.name === "Bob Example").length); };
check("Bob's post is on Ann's Home", await waitFor(async () => (await bobsCards()) === 1));
await ann.click('article.from-friend[data-name="Bob Example"] header details.more > summary');
await Promise.all([ann.waitForNavigation(), ann.click('article.from-friend[data-name="Bob Example"] header form[action="/_admin/mutes"] button')]);
check("Ann mutes Bob from his post, and it's gone from her Home", n(stateA, "mutes") === 1 && (await bobsCards()) === 0);
const bobOnA = sql(stateA, `SELECT id FROM connections WHERE origin = '${B}'`)[0].id;
await ann.goto(`${A}/friend/${bobOnA}/posts`);
check("Bob's page still shows his post, and says he's muted", (await text(ann)).includes("Bike ride this morning")
  && (await text(ann)).includes("You've muted Bob Example") && Boolean(await ann.$('form[action$="/unmute"]')));
await ann.goto(annsPage);
await openComments(ann);
check("Bob's comments on Ann's post still show", (await comments(ann)).includes("Still coming?"));
await ann.goto(`${A}/friend`);
check("Friends lists Bob as muted", (await text(ann, "#muted")).includes("Bob Example"));
await Promise.all([ann.waitForNavigation(), ann.click("#muted form button")]);
check("…and Unmute there brings his posts back to Home", n(stateA, "mutes") === 0 && (await bobsCards()) === 1);

// In a group: Bob's posts fold to a line for Ann, and show in full on their own page.
const annGroup = await startSignedGroup(ann, { origin: G, setup: GROUP_KEY, name: "Walkers" });
const bobGroup = await letInto(ann, A, annGroup, bob, B, stateB);
const groupPerson = sql(stateG, "SELECT person FROM own_identity")[0].person;
const posted = await signedGroupPost(bob, bobGroup, groupPerson, { type: "post", text: "Anyone for Saturday?" });
check("Bob posts in Ann's group", posted.status === 200, JSON.stringify(posted));
await ann.goto(`${A}/groups/${annGroup}`);
check("…and Ann sees it", (await text(ann)).includes("Anyone for Saturday?"));
await ann.click('article.in-group[data-name="Bob Example"] header details.more > summary');
await Promise.all([ann.waitForNavigation(), ann.click('article.in-group[data-name="Bob Example"] header form[action="/_admin/mutes"] button')]);
check("Muted from there, Bob's post folds to a line", (await text(ann)).includes("A post from Bob Example, whom you've muted.")
  && !(await text(ann)).includes("Anyone for Saturday?"));
await Promise.all([ann.waitForNavigation(), ann.click("p.muted a")]);
check("…and Show it opens the post, in full", (await text(ann)).includes("Anyone for Saturday?") && Boolean(await ann.$('article.in-group form[action$="/unmute"]')));
await ann.click('article.in-group header details.more > summary');
await Promise.all([ann.waitForNavigation(), ann.click('article.in-group header form[action$="/unmute"] button')]);
await ann.goto(`${A}/groups/${annGroup}`);
check("Unmuted, it's back in the group", n(stateA, "mutes") === 0 && (await text(ann)).includes("Anyone for Saturday?"));

check("no errors in the pages", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
