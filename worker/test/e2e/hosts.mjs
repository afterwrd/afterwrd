// Hosts that misbehave (docs/signed-conversations.md, step 9a), between real sites: Ann (8787), Bob (8788) and Cat
// (8789), all friends, and Ann's group (G, 8790) with Bob and Cat in it. Each bad host is its database edited by hand
// between reads, as whoever runs a site could, and where a bad version needs the host's signature it gets it: the site
// signs whatever its lists table says (hosted.js readList), just as a modified site would. Made-up people are a
// stand-in on 8781–8785 that answers for five identities made here, as a group's owner could make them.
//   node hosts.mjs <zip> <fixtures dir> <A state> <B state> <C state> <G state>
// Cat's site checks what she sent with a "day" of 8 seconds (run.sh: TEST_SENT_SECONDS).
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { makeRecord } from "../../public/static/records.js";
import { b64url, concat, encode, fingerprintOf, fromB64url, newKeyPair, newRecoveryCode, publicKeyText, recoveryKey, sha256, signAs,
  statementsChallenge, utf8 } from "../../public/static/signed.js";
import { headOf, PAGE, signHead } from "../../src/lists.js";
import { signCall } from "../../src/signedcalls.js";
import { count as n, letInto, settled, siteCall, siteSql as sql, setUpSigning, startSignedGroup } from "./helpers.mjs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await test()) return true;
  return false;
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// --- people, friends, a group ----------------------------------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("console", (m) => { if (m.text().includes("Content Security Policy")) errors.push(`${site}: ${m.text()}`); }); // blocked by the page's policy
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
async function compose(page, site, words, path = "/posts") {
  await page.goto(`${site}${path}`);
  await page.type("#composer textarea", words);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
}

const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
const cat = await owner(C, "Cat Example");
await befriend(ann, A, bob, B);
await befriend(ann, A, cat, C);
await befriend(bob, B, cat, C);
check("Ann, Bob and Cat are all friends", n(stateA, "connections WHERE approved_at IS NOT NULL") === 2 && n(stateC, "connections WHERE approved_at IS NOT NULL") === 2);
const person = (state) => sql(state, "SELECT person FROM own_identity")[0].person;
const annPerson = person(stateA), bobPerson = person(stateB), catPerson = person(stateC);
const friendId = (state, who) => sql(state, `SELECT id FROM connections WHERE identity = ${q(who)}`)[0].id;
const bobOnA = friendId(stateA, bobPerson), bobOnC = friendId(stateC, bobPerson);

// --- the host's database, as whoever runs it could change it ---------------------------------------------------------

/** A list as it's kept: its row and its pages, to put back later. */
const snapshot = (state, list) => ({ row: sql(state, `SELECT n, head FROM lists WHERE id = ${q(list)}`)[0],
  pages: sql(state, `SELECT page, entries FROM list_pages WHERE list = ${q(list)} ORDER BY page`) });
function restore(state, list, { row, pages }) {
  sql(state, `DELETE FROM list_pages WHERE list = ${q(list)}; ${pages.map((p) => `INSERT INTO list_pages (list, page, entries) VALUES (${q(list)}, ${p.page}, ${q(p.entries)});`).join(" ")}
    UPDATE lists SET n = ${row.n}, head = ${q(row.head)} WHERE id = ${q(list)};`);
}
const entriesOf = (state, list) => sql(state, `SELECT entries FROM list_pages WHERE list = ${q(list)} ORDER BY page`).flatMap((p) => JSON.parse(p.entries));
/**
 * Puts `entries` (in this order) in place of host `host`'s list `list`, numbered and chained again as a host would: its
 * site then signs the new end whenever it's read, as a modified site would.
 */
async function relist(state, host, list, entries) {
  const heads = new Map([[0, ""]]); // as lists.js Rules starts
  const out = [];
  for (const [i, e] of entries.entries()) {
    const nth = i + 1;
    const head = await headOf({ host, list, prev: heads.get(nth - 1), n: nth, fp: e.fp, taken: e.taken });
    heads.set(nth, head);
    out.push({ ...e, n: nth, head });
  }
  const pages = new Map();
  for (const e of out) pages.set(Math.floor((e.n - 1) / PAGE), [...(pages.get(Math.floor((e.n - 1) / PAGE)) ?? []), e]);
  restore(state, list, { row: { n: out.length, head: out.at(-1).head }, pages: [...pages].map(([page, es]) => ({ page, entries: JSON.stringify(es) })) });
  return out;
}

// What Ann's or Cat's page shows of a friend's post: the notice above its conversation, and its comments.
const postPage = (page, site, friend, id) => page.goto(`${site}/friend/${friend}/posts/${id}`);
const alertOn = (page, kind = "from-friend") => text(page, `article.${kind} .notice.alert`);
const commentsOn = (page, kind = "from-friend") => page.$$eval(`article.${kind} .comment:not(.gone)`, (l) => l.map((c) => c.querySelector(".said")?.textContent ?? ""));
async function say(page, site, friend, id, words) {
  await postPage(page, site, friend, id);
  if (!(await page.$("article.from-friend details.comments[open]"))) await page.click("article.from-friend details.comments summary").catch(() => {});
  await page.waitForSelector("article.from-friend .say textarea", { timeout: 15_000 });
  await page.type("article.from-friend .say textarea", words);
  await Promise.all([settled(page), page.click("article.from-friend .say button")]);
  const state = page === ann ? stateA : stateC;
  return sql(state, "SELECT fp FROM sent WHERE kind = 'comment' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0].fp;
}
/** A post of Bob's, once Ann's and Cat's sites both have it. */
async function bobPosts(words) {
  await compose(bob, B, words);
  const id = sql(stateB, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0].id;
  const arrived = await waitFor(() => n(stateA, `copies WHERE id = ${q(id)}`) === 1 && n(stateC, `copies WHERE id = ${q(id)}`) === 1);
  if (!arrived) errors.push(`Bob's post "${words}" didn't reach Ann's and Cat's sites`);
  return id;
}

// --- 1. reordering ------------------------------------------------------------------------------------------------------

const p1 = await bobPosts("Walk on Saturday?");
const annFirst = await say(ann, A, bobOnA, p1, "Count me in");
const catSecond = await say(cat, C, bobOnC, p1, "Me too, after Ann");
await postPage(ann, A, bobOnA, p1);
check("an honest conversation shows clean", !(await alertOn(ann)) && (await commentsOn(ann)).join("|") === "Count me in|Me too, after Ann",
  (await commentsOn(ann)).join("|"));
const p1Kept = snapshot(stateB, p1);
const p1Entries = entriesOf(stateB, p1);
await relist(stateB, bobPerson, p1, [p1Entries[0], p1Entries[2], p1Entries[1]]);
await postPage(ann, A, bobOnA, p1);
check("1. two comments swapped, and signed again by Bob's site: Ann's says it doesn't add up", (await alertOn(ann)).includes("doesn't add up"), await alertOn(ann));
check("…and doesn't show what's after the break as if all were well", !(await commentsOn(ann)).includes("Count me in"), (await commentsOn(ann)).join("|"));
restore(stateB, p1, p1Kept);
await postPage(ann, A, bobOnA, p1);
check("…put back, all's well again", !(await alertOn(ann)) && (await commentsOn(ann)).length === 2);

// --- 2. going back to an old version --------------------------------------------------------------------------------------

const p2 = await bobPosts("Pub quiz on Thursday?");
await say(ann, A, bobOnA, p2, "Yes please");
await say(cat, C, bobOnC, p2, "I'll bring pens");
const p2Old = snapshot(stateB, p2);
await say(ann, A, bobOnA, p2, "Shall we be the Owls?");
await postPage(ann, A, bobOnA, p2);
check("Ann's site has checked the conversation up to her latest", sql(stateA, `SELECT checked_n FROM copies WHERE id = ${q(p2)}`)[0].checked_n === 4);
const p2Now = snapshot(stateB, p2);
restore(stateB, p2, p2Old);
await postPage(ann, A, bobOnA, p2);
check("2. Bob's site goes back to how it was before Ann's last comment: Ann's says it's changed since she last saw it",
  (await alertOn(ann)).includes("has changed this conversation since you last saw it"), await alertOn(ann));
restore(stateB, p2, p2Now);
await postPage(ann, A, bobOnA, p2);
check("…put back as it was, no notice", !(await alertOn(ann)) && (await commentsOn(ann)).length === 3);

// --- 3. separate versions -----------------------------------------------------------------------------------------------

const p3 = await bobPosts("Anyone for tennis?");
await say(ann, A, bobOnA, p3, "Love to");
await say(cat, C, bobOnC, p3, "Who else?");
const catThird = await say(cat, C, bobOnC, p3, "Only if it's sunny");
await postPage(ann, A, bobOnA, p3);
check("Ann has seen all three comments", (await commentsOn(ann)).length === 3);
const p3Kept = snapshot(stateB, p3);
await relist(stateB, bobPerson, p3, entriesOf(stateB, p3).filter((e) => e.fp !== catThird));
await postPage(ann, A, bobOnA, p3);
check("3. Bob's site rebuilds the conversation without Cat's newest comment, signed: Ann (who saw it) is told it's changed",
  (await alertOn(ann)).includes("has changed this conversation"), await alertOn(ann));
sql(stateA, `UPDATE copies SET checked_n = NULL, checked_head = NULL WHERE id = ${q(p3)}`);
await postPage(ann, A, bobOnA, p3);
check("…someone reading it for the first time sees a clean conversation (section 10: this can't be caught)",
  !(await alertOn(ann)) && (await commentsOn(ann)).join("|") === "Love to|Who else?", (await commentsOn(ann)).join("|"));
await sleep(1100); // her comment taken a second before she asks (sentchecks.js compareThread: askedAt)
await postPage(cat, C, bobOnC, p3);
check("…but Cat, opening it, finds her comment missing", await waitFor(() => sql(stateC, `SELECT state FROM sent WHERE fp = ${q(catThird)}`)[0]?.state === "missing"));
await cat.goto(`${C}/activity`);
check("…and her Notifications say so", (await text(cat)).includes("Your comment on Bob Example's post is missing"), (await text(cat)).slice(0, 200));
restore(stateB, p3, p3Kept);

// --- 4. a post's words changed by its host, with nothing signed ------------------------------------------------------------

const p4 = await bobPosts("Bob's own words");
const bobContent = sql(stateB, `SELECT content FROM items WHERE id = ${q(p4)}`)[0].content;
sql(stateB, `UPDATE items SET content = ${q(bobContent.replace("Bob's own words", "Words Bob never signed"))}, changed_at = changed_at + 5 WHERE id = ${q(p4)}`);
sql(stateA, `UPDATE connections SET items_checked_at = NULL WHERE id = ${bobOnA}`);
await ann.goto(`${A}/`);
await waitFor(() => sql(stateA, `SELECT changed_at FROM copies WHERE id = ${q(p4)}`)[0]?.changed_at
  === sql(stateB, `SELECT changed_at FROM items WHERE id = ${q(p4)}`)[0].changed_at, 15_000);
await ann.goto(`${A}/`);
const p4Card = (await ann.$$eval("article.from-friend", (l) => l.map((a) => a.innerText))).find((t) => t.includes("words")) ?? "";
check("4. Bob's site changes his post's words without his signature: Ann's Home shows them as he signed them",
  p4Card.includes("Bob's own words") && !p4Card.includes("Words Bob never signed"), p4Card.slice(0, 120));
await postPage(ann, A, bobOnA, p4);
const p4Page = await text(ann, "article.from-friend");
check("…and so does the post's own page", p4Page.includes("Bob's own words") && !p4Page.includes("Words Bob never signed"), p4Page.slice(0, 120));
sql(stateB, `UPDATE items SET content = ${q(bobContent)} WHERE id = ${q(p4)}`);

// --- 7. an old note sent again ---------------------------------------------------------------------------------------------

await bob.goto(`${B}/posts/${p1}`);
await bob.type("article.card .say textarea", "See you both there");
await Promise.all([settled(bob), bob.click("article.card .say button")]);
const reply = entriesOf(stateB, p1).at(-1);
check("Bob's reply reaches Ann's Notifications once", await waitFor(() => n(stateA, `notices WHERE kind = 'comment' AND fp = ${q(reply.fp)}`) === 1));
/** The note Bob's site sent about entry `fp` on its list `list`, made again from its database (notes.js noteFor). */
async function noteAgain(list, fp) {
  const entries = entriesOf(stateB, list);
  const at = entries.findIndex((e) => e.fp === fp);
  const entry = entries[at];
  const hostingKey = await crypto.subtle.importKey("pkcs8", Buffer.from(sql(stateB, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"),
    { name: "Ed25519" }, false, ["sign"]);
  const own = sql(stateB, "SELECT person, chain, profile FROM own_identity")[0];
  const delegations = Object.fromEntries(sql(stateB, "SELECT key, bytes, proof FROM delegations").map((d) => [d.key, { bytes: d.bytes, proof: JSON.parse(d.proof) }]));
  return { v: 2, kind: "comment", item: list, entry: { n: entry.n, fp: entry.fp, taken: entry.taken, prev: at > 0 ? entries[at - 1].head : "", sent: entry.sent },
    receipt: await signHead(hostingKey, { host: own.person, list, n: entry.n, head: entry.head }), delegations,
    people: { [own.person]: { chain: JSON.parse(own.chain), ...(own.profile && { profile: JSON.parse(own.profile) }) } } };
}
const again = await siteCall(stateB, B, `${A}/_p/notes`, await noteAgain(p1, reply.fp));
check("7. the same note sent again is taken quietly", again.status === 202, String(again.status));
check("…and tells Ann nothing new", n(stateA, `notices WHERE kind = 'comment' AND fp = ${q(reply.fp)}`) === 1);
const later = await siteCall(stateB, B, `${A}/_p/notes`, await noteAgain(p1, reply.fp));
check("…however often", later.status === 202 && n(stateA, `notices WHERE fp = ${q(reply.fp)}`) === 1);

// --- 6. a removal no one could sign ------------------------------------------------------------------------------------------

await postPage(ann, A, bobOnA, p1);
const madeRemoval = await ann.evaluate(async (about) => {
  const [{ makeRecord: make }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const d = document.querySelector("form.say").dataset;
  const key = await savedKey();
  return make({ kind: "remove", author: key.person, host: d.signHost, item: d.signItem, seen: { n: Number(d.signSeenN), h: d.signSeenH },
    prev: d.signPrev || null, about }, undefined, key);
}, catSecond);
const honest = await siteCall(stateA, A, `${B}/_p/records`, { sent: madeRemoval.sent,
  delegation: (({ bytes, proof }) => ({ bytes, proof: JSON.parse(proof) }))(sql(stateA, "SELECT bytes, proof FROM delegations ORDER BY expires_at DESC LIMIT 1")[0]) });
check("Ann can't remove Cat's comment on Bob's post: Bob's site refuses it", honest.status >= 400, String(honest.status));
const p1Before = snapshot(stateB, p1);
const p1Now = entriesOf(stateB, p1);
const removedAt = p1Now.length + 1;
const withRemoval = p1Now.map((e) => (e.fp === catSecond ? { n: e.n, fp: e.fp, taken: e.taken, head: e.head, by: madeRemoval.fp, by_n: removedAt } : e));
withRemoval.push({ n: removedAt, fp: madeRemoval.fp, taken: Math.floor(Date.now() / 1000), sent: madeRemoval.sent });
await relist(stateB, bobPerson, p1, withRemoval);
sql(stateB, `UPDATE authored SET author = NULL WHERE fp = ${q(catSecond)}`);
await postPage(ann, A, bobOnA, p1);
check("6. Bob's site takes it anyway and says Cat's comment was removed by Ann: readers' sites say it doesn't add up",
  (await alertOn(ann)).includes("doesn't add up"), await alertOn(ann));
// Cat's background check, from her Home (8-second days: run.sh).
sql(stateC, `UPDATE sent SET next_at = 0 WHERE fp = ${q(catSecond)}`);
const catChecked = await waitFor(async () => {
  await cat.goto(`${C}/`);
  await sleep(1500);
  return sql(stateC, `SELECT state FROM sent WHERE fp = ${q(catSecond)}`)[0]?.state !== null;
}, 40_000);
const catState = sql(stateC, `SELECT state, removed_by FROM sent WHERE fp = ${q(catSecond)}`)[0];
check("…and Cat's check isn't fooled: her comment is missing, not removed by Ann", catChecked && catState.state === "missing" && catState.removed_by === null,
  JSON.stringify(catState));
await cat.goto(`${C}/activity`);
check("…which her Notifications say", (await text(cat)).includes("Your comment on Bob Example's post is missing")
  && !(await text(cat)).includes("Ann Example removed your comment"), (await text(cat)).slice(0, 300));
restore(stateB, p1, p1Before);

// --- 8. someone else's conversation, passed off as Bob's ---------------------------------------------------------------------

await compose(ann, A, "Ann's own news");
const annPost = sql(stateA, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0].id;
check("Cat's site has Ann's post, from Ann", await waitFor(() => n(stateC, `copies WHERE id = ${q(annPost)}`) === 1));
const annOnC = friendId(stateC, annPerson);
const copyRows = (table, where) => {
  for (const row of sql(stateA, `SELECT * FROM ${table} WHERE ${where}`)) {
    const cols = Object.keys(row);
    sql(stateB, `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => (row[c] === null ? "NULL" : typeof row[c] === "number" ? row[c] : q(row[c]))).join(", ")})`);
  }
};
copyRows("items", `id = ${q(annPost)}`);
copyRows("lists", `id = ${q(annPost)}`);
copyRows("list_pages", `list = ${q(annPost)}`);
sql(stateB, `UPDATE items SET changed_at = ${Math.floor(Date.now() / 1000) + 5} WHERE id = ${q(annPost)}`);
const offered = await (await siteCall(stateC, C, `${B}/_p/items?since=0`)).json().catch(() => ({}));
check("8. Bob's site offers Ann's post as one of its own", (offered.items ?? []).some((i) => i.id === annPost), JSON.stringify(Object.keys(offered)));
sql(stateC, `UPDATE connections SET items_checked_at = NULL WHERE id = ${bobOnC}`);
await cat.goto(`${C}/`);
await sleep(3000);
await cat.goto(`${C}/`);
check("…Cat's site doesn't take it as Bob's", n(stateC, `copies WHERE id = ${q(annPost)} AND connection_id = ${bobOnC}`) === 0
  && n(stateC, `copies WHERE id = ${q(annPost)} AND connection_id = ${annOnC}`) === 1);
await postPage(cat, C, bobOnC, annPost);
check("…nor shows it under Bob's name", !(await text(cat)).includes("Ann's own news") || (await text(cat)).includes("Not found"), (await text(cat)).slice(0, 120));
sql(stateB, `DELETE FROM list_pages WHERE list = ${q(annPost)}; DELETE FROM lists WHERE id = ${q(annPost)}; DELETE FROM items WHERE id = ${q(annPost)};`);

// --- 5. made-up voters ------------------------------------------------------------------------------------------------------

// Five made-up people, each with a real identity, passkey, browser key and signed name, at an address of their own.
function der(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(new Uint8Array([0]), b) : b; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  const body = concat(new Uint8Array([0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}
async function madeUp(origin, name) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = concat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x), new Uint8Array([0x22, 0x58, 0x20]), fromB64url(jwk.y));
  const credential = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const passkeySigns = async (statements) => {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge: await statementsChallenge(nonce, statements), origin, crossOrigin: false }));
    const authData = concat(await sha256(utf8(new URL(origin).hostname)), new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 0]));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, concat(authData, await sha256(clientData))));
    return { credential, nonce, statements, response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(der(raw)) } };
  };
  const hosting = await newKeyPair();
  const doc = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin, passkeys: [{ id: credential, key: b64url(cose), origin }],
    recovery: (await recoveryKey(newRecoveryCode())).publicKey, hosting: await publicKeyText(hosting.publicKey) });
  const id = await fingerprintOf("identity", doc);
  const browserKey = await newKeyPair();
  const key = await publicKeyText(browserKey.publicKey);
  const at = Math.floor(Date.now() / 1000);
  const delegationBytes = encode({ v: 2, kind: "delegation", person: id, key, origin, expires: at + 30 * 86400 });
  const delegation = { bytes: b64url(delegationBytes), proof: await passkeySigns([id, await fingerprintOf("delegation", delegationBytes)]) };
  const chain = [{ bytes: b64url(doc), sig: { passkey: await passkeySigns([id]) } }];
  const profileBytes = encode({ v: 2, kind: "profile", person: id, name, at });
  const profile = { bytes: b64url(profileBytes), key, signature: await signAs("profile", browserKey.privateKey, profileBytes), delegation };
  const call = async (url, body) => {
    const text_ = JSON.stringify(body);
    const headers = await signCall({ method: "POST", url, body: text_, person: id, from: origin, privateKey: hosting.privateKey });
    return fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: text_ });
  };
  // A delegation from this made-up person for any key at all, and a record that names any key (signed by their own).
  const delegate = async (other) => {
    const b = encode({ v: 2, kind: "delegation", person: id, key: other, origin, expires: at + 30 * 86400 });
    return { bytes: b64url(b), proof: await passkeySigns([await fingerprintOf("delegation", b)]) };
  };
  const forge = (fields, content, asKey) => makeRecord({ author: id, ...fields }, content, { privateKey: browserKey.privateKey, publicKey: asKey });
  return { id, origin, name, chain, delegation, profile, call, delegate, forge,
    sign: (fields, content) => makeRecord({ author: id, ...fields }, content, { privateKey: browserKey.privateKey, publicKey: key }) };
}
const fakes = [];
for (const [i, name] of ["Pat Madeup", "Lee Madeup", "Sol Madeup", "Kit Madeup", "Ray Madeup"].entries()) fakes.push(await madeUp(`http://localhost:${8781 + i}`, name));
// Their "sites": each answers with its identity, and takes whatever it's sent. How often each was asked for its identity.
const identityAsked = fakes.map(() => 0);
const slowIdentity = fakes.map(() => 0); // ms each takes to answer for its identity
const standIns = fakes.map((f, i) => createServer((req, res) => {
  req.resume();
  if (req.url === "/.well-known/afterwrd") {
    identityAsked[i]++;
    setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ v: 2, chain: f.chain })), slowIdentity[i]);
  }
  else res.writeHead(202, { "Content-Type": "application/json" }).end("{}");
}).listen(8781 + i));

const annGroup = await startSignedGroup(ann, { origin: G, setup: GROUP_KEY, name: "Walkers" });
const bobGroup = await letInto(ann, A, annGroup, bob, B, stateB);
const catGroup = await letInto(ann, A, annGroup, cat, C, stateC);
check("the group has Ann, Bob and Cat", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 3);
const groupPerson = person(stateG);
// The made-up people ask to join, through invite links Ann makes, as anyone's site would.
async function inviteLink() {
  await ann.goto(`${A}/groups/${annGroup}/members`);
  await ann.click("#make");
  await ann.waitForSelector("#link:not([hidden])");
  return ann.$eval("#link-url", (i) => i.value);
}
const asked = [];
for (const f of fakes) {
  const token = (await inviteLink()).split("/_join/")[1];
  const info = await (await fetch(`${G}/_join/${token}/info`)).json();
  const made = await f.sign({ kind: "join", host: groupPerson, item: groupPerson, seen: info.members ?? null, prev: null }, { name: f.name });
  f.join = made.fp;
  asked.push((await f.call(`${G}/_join/${token}/accept`, { sent: made.sent, delegation: f.delegation, profile: f.profile })).status);
}
check("five made-up people ask to join, and wait", asked.every((s) => s === 200) && n(stateG, "group_members WHERE approved_at IS NULL") === 5, asked.join(","));
// Ann asks a poll; Bob answers.
await ann.goto(`${A}/groups/${annGroup}`);
await ann.type("#composer textarea", "Which day for the walk?");
await ann.click("#composer .add-poll");
const boxes = await ann.$$("#composer .poll-options input");
await boxes[0].type("Saturday");
await boxes[1].type("Sunday");
await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
const poll = sql(stateG, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0].id;
await bob.goto(`${B}/groups/${bobGroup}/posts/${poll}`);
await Promise.all([settled(bob, { timeout: 30_000 }), bob.click(`#poll-${poll} button[value="0"]`)]);
check("Bob answers Ann's poll", await waitFor(() => n(stateG, `authored WHERE list = ${q(poll)} AND author = ${q(bobPerson)}`) === 1));
const pollPoint = () => { const r = sql(stateG, `SELECT n, head FROM lists WHERE id = ${q(poll)}`)[0]; return { n: r.n, h: r.head }; };
const vote = (f) => f.sign({ kind: "vote", host: groupPerson, item: poll, seen: pollPoint(), prev: null, version: poll }, { choices: [1] });
// (a) The group's site alone: votes from people nobody let in.
const refused = await fakes[0].call(`${G}/_p/records`, { sent: (await vote(fakes[0])).sent, delegation: fakes[0].delegation });
check("5. an honest group refuses a vote from someone not let in", refused.status >= 400, String(refused.status));
const pollKept = snapshot(stateG, poll);
const pollNow = entriesOf(stateG, poll);
const taken = Math.floor(Date.now() / 1000);
const fakeVotes = [];
for (const f of fakes) { const v = await vote(f); fakeVotes.push({ fp: v.fp, taken, sent: v.sent }); }
await relist(stateG, groupPerson, poll, [...pollNow, ...fakeVotes]);
sql(stateG, `UPDATE items SET tally = ${q(JSON.stringify({ votes: Object.fromEntries([[bobPerson, 1], ...fakes.map((f) => [f.id, 2])]), ended_at: null }))},
  changed_at = changed_at + 5 WHERE id = ${q(poll)}`);
await bob.goto(`${B}/groups/${bobGroup}/posts/${poll}`);
const bobMeta = await text(bob, `#poll-${poll} .meta`);
const bobWho = await bob.$eval(`#poll-${poll} .poll-who`, (d) => d.textContent).catch(() => "");
// Readers don't check that voters were let in (section 10, "Made-up people"): what they promise is that made-up people
// are counted apart from people you know, and shown as strangers.
check("(a) the group's site puts in five made-up votes from people nobody let in: Bob's site counts them apart, as people he doesn't know",
  bobMeta.includes("6 people answered") && bobMeta.includes("1 you know"), bobMeta);
check("…and shows them by the names they gave themselves, not as anyone he knows", bobWho.includes("Pat Madeup") && !/Pat Madeup[^,]*friend/.test(bobWho), bobWho.slice(0, 200));
restore(stateG, poll, pollKept);
sql(stateG, `UPDATE items SET tally = ${q(JSON.stringify({ votes: { [bobPerson]: 1 }, ended_at: null }))}, changed_at = changed_at + 5 WHERE id = ${q(poll)}`);
// (b) The group's owner lets them in: she can, and then their votes count, as strangers.
await ann.goto(`${A}/groups/${annGroup}/members`);
for (let i = 0; i < 5; i++) {
  const button = await ann.$('.requests button[data-group-record="approve"]');
  if (!button) break;
  await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), button.click()]);
}
check("(b) Ann, the group's owner, lets the five made-up people in", n(stateG, "group_members WHERE approved_at IS NOT NULL") === 8);
const voted = [];
for (const f of fakes) voted.push((await f.call(`${G}/_p/records`, { sent: (await vote(f)).sent, delegation: f.delegation, profile: f.profile })).status);
check("…and they vote, each signed", voted.every((s) => s === 200), voted.join(","));
await cat.goto(`${C}/groups/${catGroup}/posts/${poll}`);
const meta = await text(cat, `#poll-${poll} .meta`);
check("…Cat's site counts them, but says how many she knows", !(await alertOn(cat, "in-group")) && meta.includes("6 people answered") && meta.includes("1 you know"), meta);
const who = await cat.$eval(`#poll-${poll} .poll-who`, (d) => d.textContent).catch(() => "");
check("…and doesn't pass them off as friends", who.includes("Bob Example") && !/Pat Madeup[^,]*your friend/.test(who), who.slice(0, 200));

// --- a pull sends only who's new to the group since (step 9, option 1A) -------------------------------------------------------

// Cat's site has pulled before. With every delegation it keeps gone, and Bob posting with the key the group learnt
// long ago (so a pull since then doesn't send it), her site asks the group for it (POST /_p/people).
const bobKey = sql(stateB, "SELECT key FROM delegations ORDER BY expires_at DESC LIMIT 1")[0].key;
sql(stateC, "DELETE FROM known_delegations");
await compose(bob, B, "A walk on the coast next?", `/groups/${bobGroup}`);
const coast = sql(stateG, "SELECT id FROM items WHERE type = 'post' ORDER BY created_at DESC, rowid DESC LIMIT 1")[0].id;
check("Cat's site had pulled from the group before", sql(stateC, `SELECT items_since FROM groups WHERE id = ${catGroup}`)[0].items_since > 0);
sql(stateC, `UPDATE groups SET items_checked_at = 0 WHERE id = ${catGroup}`);
await cat.goto(`${C}/groups/${catGroup}`);
check("…a pull sends only who's new, and her site asks for the delegation it's missing: Bob's post is kept",
  await waitFor(() => n(stateC, `copies WHERE id = ${q(coast)}`) === 1), "");
check("…and her site keeps it again", n(stateC, `known_delegations WHERE key = ${q(bobKey)}`) === 1);

// --- someone claiming another person's browser key -------------------------------------------------------------------------

// Pat signs a delegation naming Ann's browser key, and sends it with a join that names that key too. Nothing Pat sends can
// be signed by Ann's key, so the group's site mustn't start saying the key is Pat's.
const annKey = sql(stateG, `SELECT key FROM known_delegations WHERE person = ${q(person(stateA))} LIMIT 1`)[0]?.key;
check("(the group's site knows a browser key of Ann's)", Boolean(annKey));
const patToken = (await inviteLink()).split("/_join/")[1];
const patInfo = await (await fetch(`${G}/_join/${patToken}/info`)).json();
const claimed = await fakes[0].forge({ kind: "join", host: groupPerson, item: groupPerson, seen: patInfo.members ?? null, prev: fakes[0].join }, { name: fakes[0].name }, annKey);
const claim = await fakes[0].call(`${G}/_join/${patToken}/accept`, { sent: claimed.sent, delegation: await fakes[0].delegate(annKey), profile: fakes[0].profile });
check("a join signed with someone else's browser key isn't taken", claim.status >= 400, String(claim.status));
check("…and the group's site still says that key is Ann's", sql(stateG, `SELECT person FROM known_delegations WHERE key = ${q(annKey)}`)[0]?.person === person(stateA));

// --- how long a refused call takes says nothing ---------------------------------------------------------------------------

// A call from Lee's address, as Lee, with a signature that doesn't check: the group's site may look Lee's identity up
// again in case her key changed, but its answer doesn't wait for that, so it comes as fast as it would for a stranger.
// (Lee's site is slow to say who she is here: an answer that waited would take 3 seconds.)
sql(stateG, `UPDATE identities SET updated_at = 0 WHERE person = ${q(fakes[1].id)}`);
const leeBefore = identityAsked[1];
slowIdentity[1] = 3000;
{
  const url = `${G}/_group/records`;
  const body = JSON.stringify({});
  const headers = await signCall({ method: "POST", url, body, person: fakes[1].id, from: fakes[1].origin, privateKey: (await newKeyPair()).privateKey });
  const started = Date.now();
  const answer = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body });
  const took = Date.now() - started;
  check("a call that doesn't check is refused without waiting for the caller's identity to be looked up again", answer.status === 401 && took < 2000,
    `${answer.status} in ${took} ms`);
  check("…which it is, meanwhile", await waitFor(() => identityAsked[1] > leeBefore, 6000));
  slowIdentity[1] = 0;
}

// --- someone else's identity, given by a site that isn't theirs -----------------------------------------------------------

// Zed's identity is at another address; a site at 8786 hands it out as if it were its own, and calls the group as Zed.
// The group's site fetches from 8786 to check the call, and must not learn Zed's identity from there.
const zed = await madeUp("http://localhost:8791", "Zed Madeup");
const MAL = "http://localhost:8786";
const malHits = { n: 0 };
const mal = createServer((req, res) => {
  req.resume();
  if (req.url === "/.well-known/afterwrd") malHits.n++;
  if (req.url === "/.well-known/afterwrd") res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ v: 2, chain: zed.chain }));
  else res.writeHead(404).end();
}).listen(8786);
const malKey = await newKeyPair();
for (const path of ["/_group/rejoin/point", "/_join/x/accept"]) {
  const url = `${G}${path}`;
  const body = JSON.stringify({});
  const headers = await signCall({ method: "POST", url, body, person: zed.id, from: MAL, privateKey: malKey.privateKey });
  await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body }).catch(() => null);
}
check("a site handing out someone else's identity as its own doesn't get it learnt", n(stateG, `identities WHERE person = ${q(zed.id)}`) === 0);
// A "mention" sent to Ann's site by a stranger, about a post of her friend Bob's: nothing is fetched to check it, so the
// stranger can't tell from it whom Ann knows.
const malAsked = malHits.n;
{
  const item = "i".repeat(43);
  const made = await zed.sign({ kind: "comment", host: person(stateB), item, seen: { n: 1, h: "h".repeat(43) }, prev: null, mentions: [person(stateA)] }, { text: "Hello" });
  const url = `${A}/_p/mention`;
  const body = JSON.stringify({ v: 2, kind: "receipt", host: person(stateB), item, sent: made.sent });
  const headers = await signCall({ method: "POST", url, body, person: zed.id, from: MAL, privateKey: malKey.privateKey });
  await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body });
}
check("a mention from someone Ann's site doesn't know makes it fetch nothing", malHits.n === malAsked && n(stateA, `identities WHERE person = ${q(zed.id)}`) === 0);
mal.close();

// --- the end -----------------------------------------------------------------------------------------------------------------

for (const s of standIns) s.close();
await browser.close();
for (const e of errors) console.log(`NOTE  ${e}`);
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
