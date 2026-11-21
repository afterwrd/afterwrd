// Polls: three people's sites (Ann on 8787, Bob on 8788, Cat on 8789) and a group's Worker (G, 8790). Ann is friends
// with Bob and with Cat, who aren't friends with each other. Ann asks a poll in a signed post (step 4d): votes are
// signed records, and polls are public, so everyone who can see it sees who chose what. Answers can change, a poll can take several choices and close by
// itself or when its writer closes it; forged answers are refused. Then the same in a group, where only the writer's
// site is told who chose what, and leaving takes a member's answers with them.
//   node polls.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count as n, settled, siteSql as sql, setUpSigning } from "./helpers.mjs";
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
const call = (site, path, key, body) => fetch(site + path, { method: body ? "POST" : "GET", redirect: "manual",
  headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

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

/** Writes a post with a poll in the composer on the page open now. */
async function ask(page, question, options, { multiple = false, closes = null } = {}) {
  await page.type("#composer textarea", question);
  await page.click("#composer .add-poll");
  for (let i = 2; i < options.length; i++) await page.click("#composer .add-option");
  const boxes = await page.$$("#composer .poll-options input");
  for (const [i, option] of options.entries()) await boxes[i].type(option);
  if (multiple) await page.click("#composer input[name=multiple]");
  if (closes) await page.$eval("#composer input[name=closes]", (i, v) => { i.value = v; }, closes);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}
/** The first poll on the page within `card`: its options' names, counts and which are chosen, and what it says. */
const pollIn = (page, card) => page.$eval(`${card} .poll`, (p) => (p.querySelector(".poll-who")?.setAttribute("open", ""), {
  options: [...p.querySelectorAll(".poll-option")].map((o) => ({ name: o.querySelector(".name").textContent,
    count: Number(o.querySelector(".tally").firstChild.textContent), chosen: o.classList.contains("chosen") })),
  facts: p.querySelector(":scope > .meta").textContent, who: p.querySelector(".poll-who")?.innerText ?? null,
  buttons: p.querySelectorAll("button.poll-option").length, ticks: p.querySelectorAll("input[type=checkbox]").length,
  canClose: Boolean([...p.querySelectorAll("button")].find((b) => b.textContent === "Close poll")),
})).catch(() => null);
const counts = (poll) => poll?.options.map((o) => o.count).join(",");
const chosen = (poll) => poll?.options.filter((o) => o.chosen).map((o) => o.name).join(",");
async function choose(page, card, i) {
  await Promise.all([settled(page, { timeout: 30_000 }), page.click(`${card} .poll button.poll-option:nth-of-type(${i + 1})`)]);
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
check("Ann is friends with Bob and Cat, who aren't friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2
  && n(stateB, `connections WHERE origin = '${C}'`) === 0);

// The composer's checks, before anything's sent.
await ann.goto(`${A}/posts`);
check("the composer has a Poll button, its fields folded away", Boolean(await ann.$("#composer .add-poll")) && await ann.$eval("#composer .poll-maker", (f) => f.hidden));
await ann.click("#composer .add-poll");
check("…which opens them, asking for a question", await ann.$eval("#composer textarea", (t) => t.placeholder) === "Ask a question"
  && (await ann.$$("#composer .poll-options input")).length === 2);
await ann.type("#composer .poll-options input", "Only one");
await ann.click("#composer button.post");
check("a poll needs a question", (await text(ann, "#composer .error")) === "Write the question your poll asks.");
await ann.type("#composer textarea", "Is one option enough?");
await ann.click("#composer button.post");
check("…and two options", (await text(ann, "#composer .error")) === "Give your poll at least two options.");
await ann.setViewport({ width: 390, height: 844 });
await ann.screenshot({ path: `${OUT}/poll-composer-phone.png` });
await ann.setViewport({ width: 1280, height: 800 });
check("nothing was posted", n(stateA, "items") === 0);
// What a browser could still sign and send: the site checks every poll as the composer would.
const signPoll = (page, words, poll) => page.evaluate(async (words, poll) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const made = await makeRecord({ kind: "item", author: key.person, host: key.person }, { type: "post", text: words, photos: [], poll }, key);
  const res = await fetch("/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: made.sent, photos: [] }) });
  return res.status;
}, words, poll);
check("the server says the same", (await signPoll(ann, "Q", { options: ["a"], multiple: 0, closes_at: null })) === 400
  && (await signPoll(ann, "", { options: ["a", "b"], multiple: 0, closes_at: null })) === 400
  && (await signPoll(ann, "Q", { options: ["a", "A"], multiple: 0, closes_at: null })) === 400
  && (await signPoll(ann, "Q", { options: [" a", "b"], multiple: 0, closes_at: null })) === 400);

// Ann asks: a signed post with its poll (step 4d: src/itemkinds.js).
const personOf = (state) => sql(state, "SELECT person FROM own_identity")[0].person;
const tallyOf = (state, id) => JSON.parse(sql(state, `SELECT tally FROM items WHERE id = '${id}'`)[0]?.tally ?? "null");
await ann.goto(`${A}/posts`);
await ask(ann, "Which Saturday for the walk?", ["Sat 5th", "Sat 12th", "Sat 19th"]);
let annPoll = await pollIn(ann, "article.own");
check("Ann's post shows her poll: three options, nobody's answered", annPoll?.options.map((o) => o.name).join() === "Sat 5th,Sat 12th,Sat 19th"
  && counts(annPoll) === "0,0,0" && annPoll.facts.includes("Nobody's answered yet") && annPoll.buttons === 3 && annPoll.canClose, JSON.stringify(annPoll));
const pollId = sql(stateA, "SELECT id FROM items WHERE content LIKE '%Which Saturday%'")[0]?.id;
check("…signed, in the post's own record", Boolean(pollId) && JSON.parse(sql(stateA, `SELECT content FROM items WHERE id = '${pollId}'`)[0].content).poll.options.length === 3);
await choose(ann, "article.own", 0);
annPoll = await pollIn(ann, "article.own");
check("one tap answers it, with a signed vote", counts(annPoll) === "1,0,0" && chosen(annPoll) === "Sat 5th" && annPoll.facts.includes("1 person answered")
  && tallyOf(stateA, pollId)?.votes[personOf(stateA)] === 1, JSON.stringify(annPoll));
check("…without a new page", !new URL(ann.url()).hash, ann.url());

// Bob answers from his Home: his browser signs his vote, and his site passes it on to Ann's.
// Home shows friends' signed posts from the copies a site keeps (friendcopies.js). Votes and closing send no note, so
// they reach a friend's Home at its next pull: made due here, so Home asks while it waits.
const copiesOld = (state) => sql(state, "UPDATE connections SET items_checked_at = NULL");
const card = "article.from-friend";
copiesOld(stateB);
await bob.goto(`${B}/`);
let bobPoll = await pollIn(bob, card);
check("Bob's Home shows Ann's poll with its totals", counts(bobPoll) === "1,0,0" && !chosen(bobPoll) && !bobPoll.canClose, JSON.stringify(bobPoll));
await choose(bob, card, 1);
bobPoll = await pollIn(bob, card);
check("Bob answers it from his own site", counts(bobPoll) === "1,1,0" && chosen(bobPoll) === "Sat 12th", JSON.stringify(bobPoll));
check("…Ann's site takes his signed vote", tallyOf(stateA, pollId)?.votes[personOf(stateB)] === 2);
check("…and his site keeps his own copy of it, with her site's receipt", sql(stateB, "SELECT kind, receipt FROM sent").some((r) => r.kind === "vote" && r.receipt));
await cat.goto(`${C}/`);
await choose(cat, card, 1);
copiesOld(stateB);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, card);
check("Bob sees Cat's answer counted", counts(bobPoll) === "1,2,0", JSON.stringify(bobPoll));
await bob.goto(`${B}/friend/${sql(stateB, "SELECT id FROM connections")[0].id}/posts/${pollId}`);
bobPoll = await pollIn(bob, "article.card");
check("polls are public: everyone who can see it sees who chose what, counted from the votes themselves", /Sat 12th\s+You, Cat Example|Sat 12th\s+Cat Example, You/.test(bobPoll.who ?? "")
  && /Sat 5th\s+Ann Example/.test(bobPoll.who ?? "") && bobPoll.who.includes("Everyone who can see this poll"), bobPoll.who);
await bob.goto(`${B}/`);
await choose(bob, card, 2);
bobPoll = await pollIn(bob, card);
check("Bob changes his mind", counts(bobPoll) === "1,1,1" && chosen(bobPoll) === "Sat 19th", JSON.stringify(bobPoll));

await ann.goto(`${A}/`);
annPoll = await pollIn(ann, "article.own");
check("Ann sees who chose what too", /Sat 5th\s+You/.test(annPoll.who ?? "") && /Sat 12th\s+Cat Example/.test(annPoll.who ?? "") && /Sat 19th\s+Bob Example/.test(annPoll.who ?? ""), annPoll.who);

// Forged votes: what Bob's browser could sign, which Ann's site refuses (his site shows why).
const annForBob = sql(stateB, "SELECT id FROM connections")[0].id;
const signVote = (page, path, choices, { version = null, kind = "vote" } = {}) => page.evaluate(async (path, choices, version, kind) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const doc = new DOMParser().parseFromString(await (await fetch(path)).text(), "text/html");
  const form = doc.querySelector("form.say");
  const d = form.dataset;
  const key = await savedKey();
  const mine = doc.querySelector("form.poll-form")?.dataset.signPrev || d.signPrev || null;
  const made = await makeRecord({ kind, author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: mine, ...(kind === "vote" && { version: version ?? doc.querySelector("form.poll-form")?.dataset.signVersion ?? d.signItem }) },
    kind === "vote" ? { choices } : undefined, key);
  const body = new URLSearchParams({ sent: JSON.stringify(made.sent), back: path });
  const res = await fetch(form.getAttribute("action"), { method: "POST", body, redirect: "manual" });
  return res.status === 0 || res.type === "opaqueredirect" ? 303 : res.status;
}, path, choices, version, kind);
const bobsPage = `/friend/${annForBob}/posts/${pollId}`;
check("two choices on a one-choice poll are refused", (await signVote(bob, bobsPage, [0, 1])) === 400);
check("…as are options it doesn't have", (await signVote(bob, bobsPage, [3])) === 400 && (await signVote(bob, bobsPage, ["x"])) === 400);
check("…and a vote on a version it never had", (await signVote(bob, bobsPage, [0], { version: "v".repeat(43) })) === 400);
check("…and only Ann can end her poll", (await signVote(bob, bobsPage, [], { kind: "end" })) === 400);
check("Bob's answer is still his last", tallyOf(stateA, pollId)?.votes[personOf(stateB)] === 4);
check("an answer with nothing chosen takes it back", (await signVote(bob, bobsPage, [])) === 303 && tallyOf(stateA, pollId)?.votes[personOf(stateB)] === undefined);
await signVote(bob, bobsPage, [2]);

// Closing: Ann ends the poll's voting (a signed `end`); comments carry on.
await ann.goto(`${A}/`);
await Promise.all([settled(ann), ann.click("article.own .poll form:not(.poll-form) button")]);
annPoll = await pollIn(ann, "article.own");
check("Ann closes her poll: the totals stay, the buttons go", counts(annPoll) === "1,1,1" && annPoll.buttons === 0 && annPoll.facts.includes("Closed") && !annPoll.canClose, JSON.stringify(annPoll));
check("…and no answer is taken after, or taken back", (await signVote(bob, bobsPage, [0])) === 400 && (await signVote(bob, bobsPage, [])) === 400
  && tallyOf(stateA, pollId)?.votes[personOf(stateB)] === 4);
const commentsBefore = sql(stateA, `SELECT comments FROM items WHERE id = '${pollId}'`)[0].comments;
await bob.goto(`${B}${bobsPage}`);
await bob.type("article.card .say textarea", "Shame I missed it");
await Promise.all([settled(bob), bob.click("article.card .say button")]);
check("…but comments carry on", sql(stateA, `SELECT comments FROM items WHERE id = '${pollId}'`)[0].comments === commentsBefore + 1);
copiesOld(stateB);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, card);
check("Bob sees it closed, his answer still marked", bobPoll.facts.includes("Closed") && bobPoll.buttons === 0 && chosen(bobPoll) === "Sat 19th", JSON.stringify(bobPoll));

// Several choices, closing on a day.
const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
await ann.goto(`${A}/posts`);
await ask(ann, "What shall we bring?", ["Sandwiches", "Cake", "Flask of tea"], { multiple: true, closes: tomorrow });
const multiId = sql(stateA, "SELECT id FROM items WHERE content LIKE '%What shall we bring%'")[0]?.id;
copiesOld(stateB);
await bob.goto(`${B}/`);
const multiCard = `#fi${annForBob}-${multiId}`;
bobPoll = await pollIn(bob, multiCard);
check("a poll that takes several shows ticks, and when it closes", bobPoll?.ticks === 3 && bobPoll.facts.includes("Pick as many as you like")
  && bobPoll.facts.includes("Closes"), JSON.stringify(bobPoll));
await bob.click(`${multiCard} .poll-option:nth-of-type(1) input`);
await bob.click(`${multiCard} .poll-option:nth-of-type(3) input`);
await Promise.all([settled(bob), bob.click(`${multiCard} .poll-form button.chip`)]);
bobPoll = await pollIn(bob, multiCard);
check("Bob picks two", counts(bobPoll) === "1,0,1" && chosen(bobPoll) === "Sandwiches,Flask of tea", JSON.stringify(bobPoll));
// Its closing time passes: Bob's copy shows it closed without asking, and Ann's site takes no more.
const past = Math.floor(Date.now() / 1000) - 1;
sql(stateB, `UPDATE copies SET content = json_set(content, '$.poll.closes_at', ${past}) WHERE id = '${multiId}'`);
await bob.goto(`${B}/`);
bobPoll = await pollIn(bob, multiCard);
check("a copy of a friend's poll shows it closed once its time has passed", bobPoll.facts.includes("Closed") && bobPoll.ticks === 0, JSON.stringify(bobPoll));
sql(stateA, `UPDATE items SET content = json_set(content, '$.poll.closes_at', ${past}) WHERE id = '${multiId}'`);
check("a poll closes by itself at its time", (await signVote(bob, `/friend/${annForBob}/posts/${multiId}`, [1])) === 400);

// In the download; and deleting the post takes the poll and its votes with it.
const rows = await ann.evaluate(() => fetch("/_admin/export/rows?table=items").then((r) => r.json()));
check("Download everything includes signed polls and their votes", rows.rows?.filter((r) => r.content.includes('"poll"') && r.tally?.includes("votes")).length === 2,
  JSON.stringify(rows).slice(0, 200));
await ann.goto(`${A}/posts`);
await ann.click(`#i-${multiId} header details.more summary`);
await Promise.all([settled(ann), ann.click(`#i-${multiId} header .delete`)]);
check("deleting a post deletes its poll and votes", n(stateA, `items WHERE id = '${multiId}'`) === 0 && n(stateA, `list_pages WHERE list = '${multiId}'`) === 0
  && n(stateA, "items WHERE content LIKE '%\"poll\"%'") === 1);

// --- in a group ---------------------------------------------------------------------------------------------------------

const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Walkers", about: "" });
const annGroup = (await post(ann, "/_groups/create/claim", { id: waiting.id })).id;
await ann.goto(`${A}/groups/${annGroup}/members`);
await ann.click("#make");
await ann.waitForSelector("#link:not([hidden])");
const link = await ann.$eval("#link-url", (i) => i.value);
for (const [page, site] of [[bob, B], [cat, C]]) {
  await page.goto(`${site}/groups`);
  await page.type("#join input[name=link]", link);
  await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
}
await ann.goto(`${A}/groups/${annGroup}/members`);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
check("the group has three members", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const bobGroup = sql(stateB, "SELECT id FROM groups")[0].id;
const catGroup = sql(stateC, "SELECT id FROM groups")[0].id;

await bob.goto(`${B}/groups/${bobGroup}`);
await ask(bob, "Which route?", ["Hills", "Canal"]);
const gPost = sql(stateG, "SELECT post_id FROM group_polls")[0]?.post_id;
check("Bob asks a poll in the group, kept by the group", Boolean(gPost) && n(stateB, "group_mine WHERE poll IS NOT NULL") === 1);
await ann.goto(`${A}/groups/${annGroup}`);
await choose(ann, `#gp${gPost}`, 0);
await cat.goto(`${C}/groups/${catGroup}`);
await choose(cat, `#gp${gPost}`, 1);
let catPoll = await pollIn(cat, `#gp${gPost}`);
check("members answer from their own sites, and see the totals", counts(catPoll) === "1,1" && chosen(catPoll) === "Canal" && catPoll.who === null && !catPoll.canClose, JSON.stringify(catPoll));
await ann.goto(`${A}/groups/${annGroup}`);
check("Ann, the group's owner, doesn't see who chose what either", (await pollIn(ann, `#gp${gPost}`)).who === null);
const catKey = sql(stateC, "SELECT their_key FROM groups")[0].their_key;
check("…and the group doesn't tell anyone but its writer", !JSON.stringify(await (await call(G, "/_group/posts", catKey)).json()).includes("afterwrd:voters"));
await bob.goto(`${B}/groups/${bobGroup}`);
check("Bob's group page links to who chose what, without sending names with every page", (await pollIn(bob, `#gp${gPost}`))?.who === null
  && Boolean(await bob.$(`#gp${gPost} .poll a[href$="/posts/${gPost}#poll-g${gPost}"]`)));
const bobKeyG = sql(stateB, "SELECT their_key FROM groups")[0].their_key;
check("…the group's page of posts names no one", !JSON.stringify(await (await call(G, "/_group/posts", bobKeyG)).json()).includes("afterwrd:voters"));
await bob.goto(`${B}/groups/${bobGroup}/posts/${gPost}`);
let bobGPoll = await pollIn(bob, `#gp${gPost}`);
check("Bob, who asked, sees who", /Hills\s+Ann Example/.test(bobGPoll?.who ?? "") && /Canal\s+Cat Example/.test(bobGPoll?.who ?? "") && bobGPoll.canClose, bobGPoll?.who);
// A group can't change what Bob asked.
sql(stateG, `UPDATE group_polls SET options = '["Bob says vote for me","Canal"]' WHERE post_id = ${gPost}`);
await bob.goto(`${B}/groups/${bobGroup}/posts/${gPost}`);
check("a group can't change the options Bob asked", (await pollIn(bob, `#gp${gPost}`))?.options[0].name === "Hills");
check("…and his note says the group's host could still look it up", bobGPoll.who.includes("Whoever hosts the group could still look it up"));
sql(stateG, `UPDATE group_polls SET options = '["Hills","Canal"]' WHERE post_id = ${gPost}`);
check("only its writer can close it", (await call(G, `/_group/polls/${gPost}/close`, catKey, {})).status === 400);
check("forged answers are refused", (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [0, 1] })).status === 400
  && (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [5] })).status === 400);
await bob.goto(`${B}/groups/${bobGroup}`);
await Promise.all([settled(bob), bob.click(`#gp${gPost} .poll form:not(.poll-form) button`)]);
check("Bob closes it", (await pollIn(bob, `#gp${gPost}`))?.facts.includes("Closed"));
check("…and no answer is taken after", (await call(G, `/_group/polls/${gPost}/vote`, catKey, { "afterwrd:choices": [0] })).status === 400);
await cat.goto(`${C}/groups/${catGroup}/members`);
await Promise.all([cat.waitForNavigation(), cat.click('form[action$="/leave"] button')]);
check("leaving a group takes your answers with you", n(stateG, `group_poll_votes WHERE origin = '${C}'`) === 0 && n(stateG, "group_poll_votes") === 1);
await bob.goto(`${B}/groups/${bobGroup}`);
await bob.screenshot({ path: `${OUT}/poll-group.png`, fullPage: true });
await bob.setViewport({ width: 390, height: 844 });
await bob.goto(`${B}/`);
await bob.screenshot({ path: `${OUT}/poll-phone.png`, fullPage: true });

check("no script errors", errors.length === 0, errors.join("; "));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
