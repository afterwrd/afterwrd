// Safety (docs/safety-plan.md): three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's (G, 8790). Ann
// is friends with Bob and with Cat. Step 1, on Ann's own post: she removes Bob's comment, openly (Cat sees she did); she
// turns comments off, which covers its photo, refuses Bob's comment from a page he'd opened before, and leaves Ann able
// to have the last word; then on again, and Bob's comment goes in. Step 2, mute: Ann mutes Bob from his post on Home;
// his posts leave Home but not his page, his comments still show, and Friends lists him, with Unmute. In Ann's group,
// muting Bob folds his posts there to a line, and his post's own page still shows it.
//   node safety.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count as n, letInto, settled, siteSql as sql, setUpSigning, signedGroupPost, startSignedGroup } from "./helpers.mjs";
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

// --- Tell the admins, and Tell Ann (step 4) ----------------------------------------------------------------------------

const catGroup = await letInto(ann, A, annGroup, cat, C, stateC);
const second = await signedGroupPost(bob, bobGroup, groupPerson, { type: "post", text: "Something nasty" });
check("Cat joins the group, and Bob posts again", second.status === 200, JSON.stringify(second));
const bobPersonG = () => sql(stateG, `SELECT identity FROM group_members WHERE name = 'Bob Example'`)[0]?.identity ?? "";
const groupPost = (words) => sql(stateG, "SELECT id, content FROM items WHERE type = 'post'").find((r) => JSON.parse(r.content).text === words)?.id;
/** Cat opens "Tell …" from a ⌄ menu (`menu`), picks `reason`, and sends it; returns what the page then says. */
async function tell(page, menu, reason, { note = "", named = true } = {}) {
  await page.click(`${menu} > summary`);
  await Promise.all([page.waitForNavigation(), page.click(`${menu} a[href*="/report?"]`)]);
  await page.click(`form.report input[name=reason][value=${reason}]`);
  if (note) await page.type("form.report textarea[name=note]", note);
  if (!named) await page.click("form.report input[name=named]");
  await Promise.all([page.waitForNavigation(), page.click("form.report button.primary")]);
  return text(page);
}
const saturday = groupPost("Anyone for Saturday?");
const nastyId = groupPost("Something nasty");
await cat.goto(`${C}/groups/${catGroup}`);
const said = await tell(cat, `#gi-${saturday} header details.more`, "unkind", { note: "Not kind to Dan" });
check("Cat tells the admins about Bob's post, named", said.includes("The admins of Walkers have been told"), said);
check("…which the group keeps, with who and why", sql(stateG, "SELECT reporter_name, reason, note FROM reports").some((r) => r.reporter_name === "Cat Example"
  && r.reason === "unkind" && r.note === "Not kind to Dan"));
await cat.goto(`${C}/groups/${catGroup}`);
const again = await tell(cat, `#gi-${saturday} header details.more`, "spam");
check("…and once is enough", again.includes("You've told them about this already"), again);
check("Ann, who runs it, is told quietly", await waitFor(() => n(stateA, "notices WHERE kind = 'report'") === 1));
await ann.goto(`${A}/activity`);
check("…in Notifications", (await text(ann)).includes("someone has raised something with the admins"));
await ann.goto(`${A}/groups/${annGroup}/reports`);
let page_ = await text(ann);
check("Ann's Things to look at shows what, why, and who", page_.includes("Anyone for Saturday?") && page_.includes("Unkind or bullying")
  && page_.includes("raised by Cat Example") && page_.includes("Not kind to Dan"));
// R2 (security review): 600 reports about one harmless thing don't push the real one off the page.
const flood = "f".repeat(43);
sql(stateG, `WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s WHERE value < 600)
  INSERT INTO reports (id, item, about, author, reason, copy, created_at) SELECT 'flood-' || value, '${flood}', '${flood}', '${bobPersonG()}', 'spam', 'null',
  strftime('%s','now') FROM s`);
await ann.goto(`${A}/groups/${annGroup}/reports`);
check("a flood about one thing doesn't push other reports off Things to look at", (await text(ann)).includes("Anyone for Saturday?"));
sql(stateG, `DELETE FROM reports WHERE about = '${flood}'`);
// R1: the day's caps are kept in the database, under hashes that name nobody.
check("the day's caps are kept, naming nobody", n(stateG, "report_caps") === 2
  && sql(stateG, "SELECT key FROM report_caps").every((r) => /^[0-9a-f]{64}$/.test(r.key) && !r.key.includes(bobPersonG())));

// Unnamed, and might be illegal: the group's site keeps no record of who.
await cat.goto(`${C}/groups/${catGroup}/posts/${nastyId}`);
await tell(cat, "article.in-group header details.more", "illegal", { named: false });
check("Cat tells them about the other post without being named: nothing there says who", sql(stateG, `SELECT reporter, reporter_name FROM reports WHERE about = '${nastyId}'`)
  .every((r) => r.reporter === null && r.reporter_name === null) && n(stateG, `reports WHERE about = '${nastyId}'`) === 1);
check("…and Ann's site marks it as maybe illegal", await waitFor(() => n(stateA, "notices WHERE kind = 'report' AND about = 'illegal'") === 1));
await ann.goto(`${A}/groups/${annGroup}/reports`);
check("…shown as raised without a name, and not how many", (await text(ann)).includes("raised without a name"));
// R7: what became of a report is asked without saying who asks.
const unsignedCheck = await fetch(`${G}/_p/reports/check`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: sql(stateG, `SELECT id FROM reports WHERE about = '${nastyId}'`).map((r) => r.id) }) });
check("what became of a report can be asked unsigned, by its id alone", unsignedCheck.status === 200 && (await unsignedCheck.json()).reports?.length === 1);
// R3: a report about the owner's own post, with nobody else running the group, isn't taken.
const annsNotice = await signedGroupPost(ann, annGroup, groupPerson, { type: "post", text: "Ann's notice" });
await cat.goto(`${C}/groups/${catGroup}/posts/${annsNotice.id}`);
const aboutOwner = await tell(cat, "article.in-group header details.more", "unkind");
check("a report about the owner's own post, with nobody else to tell, isn't taken", aboutOwner.includes("there's nobody else to tell")
  && n(stateG, `reports WHERE about = '${annsNotice.id}'`) === 0, aboutOwner);

// Ann leaves the first, with a word back, and removes the second.
await ann.type(`#r-${saturday} textarea[name=word]`, "Talked to Bob");
await Promise.all([ann.waitForNavigation(), ann.click(`#r-${saturday} form button`)]);
check("Ann leaves the first, with a word back", sql(stateG, `SELECT outcome, word FROM reports WHERE about = '${saturday}'`).every((r) => r.outcome === "left" && r.word === "Talked to Bob"));
await ann.goto(`${A}/groups/${annGroup}/posts/${nastyId}`);
await ann.click("article.in-group header details.more > summary");
await Promise.all([settled(ann), ann.click("article.in-group header form[data-sign=remove] button")]);
check("…and removing the second deals with what was raised about it", await waitFor(() => sql(stateG, `SELECT outcome FROM reports WHERE about = '${nastyId}'`)[0]?.outcome === "removed"));

// "Tell Ann": Cat, about Bob's comment on Ann's post. Not about Ann's own.
await cat.goto(onC);
await openComments(cat);
check("Cat isn't offered Tell Ann about Ann's own comment", !(await cat.$('.comment[data-name="Ann Example"] a[href*="/report?"]')));
// R8: the form shows what's being reported, and a made-up one isn't there.
await cat.click('.comment[data-name="Bob Example"] details.more > summary');
await Promise.all([cat.waitForNavigation(), cat.click('.comment[data-name="Bob Example"] details.more a[href*="/report?"]')]);
check("the Tell form shows what's being reported", (await text(cat)).includes("Still coming?"));
const forged = new URL(cat.url());
forged.searchParams.set("about", "z".repeat(43));
check("…and a link about something that isn't there goes nowhere", (await cat.goto(forged.href)).status() === 404);
await cat.goto(onC);
await openComments(cat);
const toAnn = await tell(cat, '.comment[data-name="Bob Example"] details.more', "spam");
check("Cat tells Ann about Bob's comment", toAnn.includes("Ann Example has been told"), toAnn);
await ann.goto(`${A}/`);
check("Ann's Home says a comment's been raised", (await text(ann)).includes("on your posts has been raised with you"));
await Promise.all([ann.waitForNavigation(), ann.click('a[href="/reports"]')]);
check("…and her Things to look at shows it", (await text(ann)).includes("Still coming?") && (await text(ann)).includes("Spam"));
await ann.goto(annsPage);
await openComments(ann);
await fromMenu(ann, '.comment[data-name="Bob Example"] details.more', "form[data-sign=remove] button");
check("Removing it deals with it, and Home goes quiet", n(stateA, "reports WHERE handled_at IS NULL") === 0
  && sql(stateA, "SELECT outcome FROM reports")[0]?.outcome === "removed");
// R5: a report about a comment is dealt with when Ann deletes the whole post.
await bob.goto(onB);
check("Bob comments again", (await comment(bob, "Last word")) === "");
await cat.goto(onC);
await openComments(cat);
await tell(cat, '.comment[data-name="Bob Example"]:has(.said) details.more', "unkind");
check("Cat tells Ann about that one too", n(stateA, "reports WHERE handled_at IS NULL") === 1);
await ann.goto(annsPage);
await ann.click("article.own header details.more > summary");
await Promise.all([ann.waitForNavigation(), ann.click("article.own header form[data-sign=delete] button")]);
await ann.goto(`${A}/reports`);
check("…and deleting the whole post deals with it", n(stateA, "reports WHERE handled_at IS NULL") === 0 && (await text(ann)).includes("Nothing waiting"));

// What Cat hears back, at her site's next asking; and, for "might be illegal" nobody looks at, where else to turn.
// R6: reports to a friend who's gone don't hold up the rest.
sql(stateC, `WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s WHERE value < 120)
  INSERT INTO reports_sent (id, connection_id, item, post, reason, created_at) SELECT 'gone-friend-' || value, 999, '${saturday}', '${saturday}', 'spam',
  strftime('%s','now') FROM s`);
sql(stateC, `INSERT INTO reports_sent (id, group_id, item, post, reason, created_at) VALUES ('never-looked-at-${"x".repeat(12)}', ${catGroup}, '${saturday}', '${saturday}', 'illegal', strftime('%s','now') - 4 * 86400)`);
sql(stateC, "UPDATE reports_sent SET checked_at = 0");
await cat.goto(`${C}/`);
check("Cat is told what became of each", await waitFor(async () => { await cat.goto(`${C}/`); return n(stateC, "notices WHERE kind = 'reported'") === 5; }),
  String(n(stateC, "notices WHERE kind = 'reported'")));
await cat.goto(`${C}/activity`);
page_ = await text(cat);
check("…in Notifications: left, with the word back; removed; and removed by Ann", page_.includes("looked at what you raised, and left it. “Talked to Bob”")
  && page_.includes("The admins looked at what you raised, and removed it") && page_.includes("Ann Example looked at what you raised, and removed it"));
check("…and where else to turn for what nobody's looked at", page_.includes("haven't looked at what you raised yet") && Boolean(await cat.$('a[href="/help"]')));
check("…and those raised with a friend who's gone are marked so", n(stateC, "reports_sent WHERE outcome = 'gone'") === 120);
check("Bob is told nothing about any of it", n(stateB, "notices WHERE kind IN ('report', 'reported')") === 0);

// --- Groups (step 5): rules, remove and clear up, removed stays removed -------------------------------------------------

await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.type("#about textarea[name=rules]", "Be kind.\nNo selling.");
await Promise.all([ann.waitForNavigation(), ann.click("#about button")]);
check("Ann writes the group's rules", sql(stateG, "SELECT rules FROM groups")[0]?.rules === "Be kind.\nNo selling.");
await cat.goto(`${C}/groups/${catGroup}`);
check("…and members see them on the group's page", (await text(cat)).includes("The group's rules"));

// Cat posts; Bob comments on it; then Ann removes Bob, and clears up everything he wrote.
const catsPost = await signedGroupPost(cat, catGroup, groupPerson, { type: "post", text: "Cat's walk" });
await bob.goto(`${B}/groups/${bobGroup}/posts/${catsPost.id}`);
check("Bob comments on Cat's post", (await comment(bob, "Rubbish walk")) === "");
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click(`li.member[data-from="${B}"] button[data-clear]`)]);
const bobPerson = sql(stateA, `SELECT identity FROM connections WHERE origin = '${B}'`)[0].identity;
check("Remove and clear up removes Bob, and remembers he was removed", n(stateG, `group_members WHERE identity = '${bobPerson}'`) === 0
  && n(stateG, `group_removed WHERE person = '${bobPerson}'`) === 1);
check("…and his post goes, whole", sql(stateG, `SELECT deleted_at FROM lists WHERE id = '${saturday}'`)[0]?.deleted_at !== null);
await cat.goto(`${C}/groups/${catGroup}/posts/${catsPost.id}`);
await openComments(cat);
check("…and his comment on Cat's post, removed by the group", (await text(cat)).includes("A comment was removed by the group.") && !(await text(cat)).includes("Rubbish walk"));
await ann.goto(`${A}/groups/${annGroup}/members`);
check("Ann's Members lists him as removed", (await text(ann, "#removed")).includes("Bob Example"));

// Bob can't ask again with a new invite link; the join page shows the rules; until Ann lets him.
const askToJoin = async () => {
  await ann.goto(`${A}/groups/${annGroup}/members`);
  await ann.click("#make");
  await ann.waitForSelector("#link:not([hidden])");
  const link = await ann.$eval("#link-url", (i) => i.value);
  await bob.goto(`${B}/groups`);
  await bob.type("#join input[name=link]", link);
  await Promise.all([bob.waitForNavigation(), bob.click("#join button:not([type=button])")]);
};
await waitFor(() => n(stateB, `groups WHERE origin = '${G}' AND joined_at IS NOT NULL`) === 0);
await askToJoin();
check("Asking to join shows the group's rules", (await text(bob)).includes("Be kind.") && (await text(bob)).includes("By asking to join, you agree to them."));
await bob.click("#go");
await bob.waitForFunction(() => document.getElementById("error")?.textContent, { timeout: 15_000 }).catch(() => {});
check("…but Bob, removed, can't ask again", (await bob.$eval("#error", (e) => e.textContent).catch(() => "")).includes("You can't join this group"));
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click("#removed form button")]);
check("Ann lets him ask again", n(stateG, "group_removed") === 0);
await askToJoin();
await Promise.all([bob.waitForNavigation({ timeout: 30_000 }), bob.click("#go")]);
check("…and now he can", await waitFor(() => n(stateG, `group_members WHERE identity = '${bobPerson}' AND approved_at IS NULL`) === 1));

// --- Getting help (step 3) ----------------------------------------------------------------------------------------------

await ann.goto(`${A}/`);
await ann.click("details.me > summary");
await Promise.all([ann.waitForNavigation(), ann.click('details.me .menu a[href="/help"]')]);
const helpWords = await text(ann);
await ann.screenshot({ path: `${OUT}/help.png`, fullPage: true });
check("Getting help is behind Ann's picture, with where to turn", helpWords.includes("Getting help") && helpWords.includes("tell the police too")
  && helpWords.includes("116 123") && helpWords.includes("0345 6000 459") && helpWords.includes("0300 323 0169"));
check("…and says who looks after what on afterwrd", helpWords.includes("afterwrd has no company behind it"));

check("no errors in the pages", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
