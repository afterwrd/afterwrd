// Moving a whole site with its identity (src/move.js, src/movein.js, src/keys.js; docs/signed-conversations.md "4f in
// detail"): Ann's site A (a Facebook import, signed posts with photos, her comment and her friend Bob's) moves to a new
// site, C. C's passkey asks; Ann agrees on A (once cancelled, then again); the change of address waits 7 days (moved
// on in the databases here), while Bob's site hears of it; then A's Download everything goes into C, every list
// checked; Bob's site follows Ann to C, and A only says where she's gone. Requests and downloads that are forged,
// tampered with, from another version or too early are refused with nothing changed.
//   node move.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count, settled, siteSql as sql, setUpSigning, siteCall } from "./helpers.mjs";
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function owner(site, name, { signing = true } = {}) {
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
  if (signing) await setUpSigning(page);
  return page;
}
async function importZip(page, site) {
  await page.goto(`${site}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes) => boxes.forEach((b) => { b.checked = ["posts", "photos"].includes(b.value); }));
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
const openThread = async (page, card) => {
  if (!(await page.$(`${card} details.comments[open]`))) await page.click(`${card} details.comments summary`);
  await page.waitForSelector(`${card} .say textarea`, { timeout: 15_000 });
};
async function comment(page, card, text) {
  await openThread(page, card);
  await page.type(`${card} .say textarea`, text);
  await Promise.all([settled(page), page.click(`${card} .say button`)]);
}
// Headless Chrome never finishes saving downloads, so keep the zip the page hands to the browser.
async function download(page, site, label, { media = true } = {}) {
  await page.evaluateOnNewDocument(() => {
    if (window.__keeping) return;
    window.__keeping = true;
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__download = blob; return make(blob); };
  });
  await page.goto(`${site}/_admin/export`);
  if (!media) await page.click("input[name=media]");
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
  const dir = `${OUT}/move/${label}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/download.zip`;
  writeFileSync(file, Buffer.from(base64, "base64"));
  const list = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
  const read = (name) => execFileSync("unzip", ["-p", file, list.find((f) => f.endsWith(`/${name}`))], { maxBuffer: 1e9 });
  return { problem, file, list, read, json: (name) => JSON.parse(read(name).toString()) };
}
// A copy of a download with something changed in one of its files.
function altered(original, label, name, change) {
  const dir = `${OUT}/move/${label}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-q", original.file, "-d", dir]);
  const path = `${dir}/${original.list.find((f) => f.endsWith(`/${name}`))}`;
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))));
  const top = original.list[0].split("/")[0];
  execFileSync("zip", ["-q", "-r", "-0", `${dir}/altered.zip`, top], { cwd: dir });
  return `${dir}/altered.zip`;
}
async function move(page, file) {
  await page.goto(`${C}/_admin/import/move`);
  if (!(await page.$("#zip"))) return `(no zip picker: ${await page.$eval("#identity", (s) => s.innerText).catch(() => "")})`;
  await (await page.$("#zip")).uploadFile(file);
  await page.click("#go");
  await page.waitForFunction(() => /Done/.test(document.getElementById("status").textContent) || document.getElementById("error").textContent,
    { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}
const text = async (page, url, selector = "main") => { await page.goto(url); return page.$eval(selector, (m) => m.innerText).catch(() => ""); };
const notices = async (page, site) => { await page.goto(`${site}/`); return page.$$eval(".stream > .notice", (n) => n.map((x) => x.textContent.replace(/\s+/g, " ").trim())); };
// The 7 days are 90 seconds on these test sites (run.sh: TEST_SLOW_SECONDS), each counted from when that site first saw
// the change: waiting for the last of them (Bob's site, which hears at its next ask) is "a week later".
const SLOW_SECONDS = 90;
async function weekLater() {
  const last = Math.max(...[stateA, stateB, stateC].map((s) => Number(sql(s, "SELECT MAX(first_seen) AS t FROM identity_seen")[0]?.t ?? 0)));
  const wait = (last + SLOW_SECONDS + 2) * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
// A call signed with C's hosting key, claiming to be Ann at C: what C's own code sends once she's moved.
async function callFromC(url) {
  const person = sql(stateA, "SELECT person FROM own_identity")[0].person;
  const privateKey = await crypto.subtle.importKey("pkcs8",
    Buffer.from(sql(stateC, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"), { name: "Ed25519" }, false, ["sign"]);
  return fetch(url, { redirect: "manual", headers: await signCall({ method: "GET", url, body: null, person, from: C, privateKey }) });
}
const chainOf = (state, table = "own_identity") => JSON.parse(sql(state, `SELECT chain FROM ${table}`)[0]?.chain ?? "[]");
const docs = (state) => chainOf(state).map((d) => JSON.parse(Buffer.from(d.bytes, "base64url").toString()));

// --- Ann's site, with a bit of everything, and her friend Bob ---------------------------------------------------------
const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
check("Ann's site imports her Facebook archive", !(await importZip(ann, A)));
await compose(ann, A, "Moving day soon", [`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`]);
await compose(ann, A, "Picnic in the park");
await befriend(ann, A, bob, B);
for (const end = Date.now() + 20_000; Date.now() < end && !(await bob.$("article.from-friend")); await new Promise((r) => setTimeout(r, 500))) {
  await bob.goto(`${B}/`);
}
const moving = async (page) => page.evaluateHandle(() => [...document.querySelectorAll("article")].find((a) => a.innerText.includes("Moving day soon")));
await bob.goto(`${B}/`);
await (await moving(bob)).evaluate((a) => { a.id = "moving"; });
await comment(bob, "#moving", "Good luck with the move!");
await ann.goto(`${A}/posts`);
await (await moving(ann)).evaluate((a) => { a.id = "moving"; });
await comment(ann, "#moving", "Thanks, all!");
const movingPost = sql(stateA, "SELECT id FROM items WHERE type = 'post' AND content LIKE '%Moving day soon%'")[0].id;
check("Ann's post has Bob's comment and hers, signed", sql(stateA, `SELECT comments FROM items WHERE id = '${movingPost}'`)[0]?.comments === 2);
const person = sql(stateA, "SELECT person FROM own_identity")[0].person;

// --- The new site, C: no identity of its own ---------------------------------------------------------------------------
const ann2 = await owner(C, "Ann Example", { signing: false });
check("a new site's recovery-code page offers to bring yourself over instead", new URL(ann2.url()).pathname === "/_admin/keys"
  && Boolean(await ann2.$('#moving a[href="/_admin/import/move"]')));
await Promise.all([ann2.waitForNavigation(), ann2.click("#moving a")]);
check("…which asks for the old site's address", Boolean(await ann2.$("#ask #from")));
const early = await download(ann, A, "early");
check("the download says whose identity it has", early.json("site/about.json").person === person, JSON.stringify(early.json("site/about.json")));
const nothingMoved = () => count(stateC, "items") === 0 && count(stateC, "posts") === 0 && count(stateC, "own_identity") === 0;
const tooEarly = await move(ann2, early.file);
check("a download with an identity can't come before the identity has", tooEarly.includes("only come once your identity has moved here") && nothingMoved(), tooEarly);

// Asking, then agreeing on A. (Here Ann's two sites are in two browsers, each with its own passkey: the request link
// goes from one to the other.)
async function ask() {
  await ann2.goto(`${C}/_admin/import/move`);
  await ann2.type("#from", A);
  await Promise.all([ann2.waitForNavigation({ timeout: 30_000 }), ann2.click("#ask button")]);
  const at = new URL(ann2.url());
  return at.pathname === "/_auth/login" ? `${A}${at.searchParams.get("next")}` : at.href;
}
async function agree(link) {
  await ann.goto(link);
  await ann.waitForSelector("#offer:not([hidden]), #error:not(:empty)", { timeout: 15_000 });
  const offered = await ann.$eval("#offer", (o) => (o.hidden ? "" : o.innerText)).catch(() => "");
  if (offered) await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#go")]);
  return { offered, error: await ann.$eval("#error", (e) => e.textContent).catch(() => "") };
}
const link = await ask();
check("C's passkey signs a request to move, and sends Ann to A to agree", link.startsWith(`${A}/_admin/keys/move?move=`)
  && sql(stateC, "SELECT from_origin FROM move_in")[0]?.from_origin === A, link.slice(0, 80));
const asked = JSON.parse(Buffer.from(new URL(link).searchParams.get("move"), "base64url").toString());
const request = JSON.parse(Buffer.from(asked.request, "base64url").toString());
check("…naming C, its hosting key and its passkey", request.kind === "move" && request.from === A && request.to === C
  && request.passkey.origin === C && request.passkey.id === sql(stateC, "SELECT id FROM credentials")[0].id);
// Forged requests: a key swapped in after C's passkey signed (as a dishonest new host might), or a move of another site.
const forge = (changes) => ann.evaluate(async (body) => {
  const r = await fetch("/_admin/keys/move/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return `${r.status} ${(await r.json()).error ?? ""}`;
}, { request: Buffer.from(JSON.stringify({ ...request, ...changes })).toString("base64url"), proof: asked.proof });
const swapped = await forge({ hosting: "x".repeat(43) });
check("A refuses a request with a key C's passkey didn't sign", swapped.startsWith("400") && swapped.includes("didn't sign"), swapped);
const elsewhere = await forge({ from: B });
check("…or a request to move another site", elsewhere.startsWith("400") && elsewhere.includes("isn't a request to move this site"), elsewhere);
const first = await agree(link);
check("A offers to move to C, saying it waits 7 days", first.offered.includes("localhost:8789") && first.offered.includes("7 days"), first.error || first.offered);
const docsA = docs(stateA);
check("A's identity now has a change of address to C: C's hosting key and passkey only", docsA.length === 2 && docsA[1].origin === C
  && docsA[1].hosting === request.hosting && docsA[1].passkeys.length === 1 && docsA[1].passkeys[0].id === request.passkey.id
  && docsA[1].recovery === docsA[0].recovery, JSON.stringify(docsA.at(-1)));
await ann2.goto(`${C}/_admin/import/move`);
await ann2.waitForSelector("#waiting", { timeout: 15_000 }).catch(() => {});
check("C sees it, and waits 7 days", (await ann2.$eval("#identity", (s) => s.innerText).catch(() => "")).includes("Moving here on")
  && sql(stateC, "SELECT person FROM move_in")[0]?.person === person);
check("A's Home says Ann is moving, and how to cancel", (await notices(ann, A)).some((t) => t.includes("you're moving to localhost:8789")
  && t.includes("Cancel")), (await notices(ann, A)).join(" | "));

// Cancelled on A, and C says so; then asked and agreed again.
await ann.goto(`${A}/_admin`);
await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("button[data-sign=cancel]")]);
check("Ann can cancel the move on A", docs(stateA).length === 3 && docs(stateA)[2].cancels && !(await notices(ann, A)).some((t) => t.includes("moving")));
await ann2.goto(`${C}/_admin/import/move`);
await Promise.all([ann2.waitForNavigation({ timeout: 15_000 }), ann2.click("button[data-move=check]")]);
check("C sees it was cancelled", (await ann2.$eval("#identity", (s) => s.innerText)).includes("cancelled"));
await Promise.all([ann2.waitForNavigation({ timeout: 15_000 }), ann2.click("button[data-move=forget]")]);
const again = await agree(await ask());
await ann2.goto(`${C}/_admin/import/move`);
await ann2.waitForSelector("#waiting", { timeout: 15_000 }).catch(() => {});
check("asked and agreed again, C waits again", Boolean(again.offered) && docs(stateA).length === 4 && docs(stateA)[3].origin === C
  && Boolean(await ann2.$("#waiting")));
const waitingZip = await download(ann, A, "waiting");
const tooSoon = await move(ann2, waitingZip.file);
check("the posts can't come during the 7 days", tooSoon.includes("no zip picker") && nothingMoved(), tooSoon);

// Bob's site hears at its next ask (A's identity is longer than it knows), and Home says so.
sql(stateB, "UPDATE connections SET items_checked_at = NULL");
const bobNotices = await notices(bob, B);
check("Bob's site hears Ann is moving, and his Home says so", sql(stateB, "SELECT moving_to FROM identities WHERE moving_to IS NOT NULL")[0]?.moving_to === C
  && bobNotices.some((t) => t.startsWith("Ann Example is moving to localhost:8789")), bobNotices.join(" | "));
const notYet = await callFromC(`${B}/_p/items?since=0`);
check("a call from C as Ann, before the 7 days are up, is 'not yet' (not 'not connected')", notYet.status === 409, String(notYet.status));
const stillA = await siteCall(stateB, B, `${A}/_p/items?since=0`);
check("A carries on as normal meanwhile", stillA.status === 200, String(stillA.status));

// --- A week later -------------------------------------------------------------------------------------------------------
await weekLater();
check("A's Home says Ann has moved, and to bring everything over", (await notices(ann, A)).some((t) => t.startsWith("You've moved to localhost:8789")),
  (await notices(ann, A)).join(" | "));
const gone = await siteCall(stateB, B, `${A}/_p/items?since=0`);
check("A tells friends' sites where Ann has gone", gone.status === 410 && (await gone.json()).moved === C, String(gone.status));
const posting = await ann.evaluate(async () => (await fetch("/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
check("A takes nothing new", posting === 410, String(posting));
const changing = await ann.evaluate(async () => (await fetch("/_admin/keys/change/start", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ change: "allow" }) })).status);
check("…nor any change to Ann's identity (that's C's to make now)", changing === 410, String(changing));
// Bob's site asks A, is told, and follows Ann to C (which isn't ready for it yet: "not yet", not "gone").
sql(stateB, "UPDATE connections SET items_checked_at = NULL");
await bob.goto(`${B}/`);
const followed = sql(stateB, "SELECT origin, said_no, missing_since FROM connections")[0];
check("Bob's site follows Ann to C, and doesn't count her as gone while C waits for her posts", followed?.origin === C
  && followed.said_no === 0 && followed.missing_since === null, JSON.stringify(followed));

// --- Bringing everything over -------------------------------------------------------------------------------------------
const zip = await download(ann, A, "ann");
check("A's download finishes after the move", !zip.problem, zip.problem);
const about = zip.json("site/about.json");
check("it has the signed posts, their lists, friends, identities and browser keys", about.signed > 0
  && ["items", "lists", "list_pages", "sent", "connections", "known_delegations", "identities", "own_identity"].every((t) => zip.list.some((f) => f.endsWith(`/site/${t}.json`))));
const rowsText = zip.list.filter((f) => f.includes("/site/") && f.endsWith(".json")).map((f) => zip.read(f.slice(f.indexOf("/") + 1)).toString()).join("");
const hosting = sql(stateA, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value;
check("no keys in it", !rowsText.includes(hosting) && !rowsText.includes("hosting_key") && !rowsText.includes("challenge_key") && !rowsText.includes("media_key"));
await ann2.goto(`${C}/_admin/import/move`);
check("C says the identity has moved, and offers the zip", Boolean(await ann2.$("#moved-here")) && Boolean(await ann2.$("#zip")));

const older = altered(zip, "older", "site/about.json", (a) => ({ ...a, database: "0001_schema.sql", version: "0.17.0" }));
const olderProblem = await move(ann2, older);
check("a download from another version is refused, saying to update", olderProblem.includes("same version") && nothingMoved(), olderProblem);
const bare = await download(ann, A, "bare", { media: false });
const bareProblem = await move(ann2, bare.file);
check("a download without photos is refused, saying how to make one", bareProblem.includes("Include photos and videos") && nothingMoved(), bareProblem);
const sly = altered(zip, "sly", "site/connections.json", (rows) => rows.map((c) => ({ ...c, origin: "javascript:alert(1)" })));
const slyProblem = await move(ann2, sly);
check("a friend's address that isn't a site's is refused, with nothing moved", slyProblem.includes("connections.origin") && nothingMoved(), slyProblem);
const sneaky = altered(zip, "sneaky", "site/settings.json", (rows) => [...rows, { key: "media_key", value: "chosen-by-someone-else" }]);
const sneakyProblem = await move(ann2, sneaky);
check("a download can't set the site's own keys", sneakyProblem.includes("settings.key") && nothingMoved(), sneakyProblem);
const later = altered(zip, "later", "site/items.json", (rows) => rows.map((r, i) => (i ? r : { ...r, created_at: 4102444800 })));
const laterProblem = await move(ann2, later);
check("a post dated in the future is refused", laterProblem.includes("items.created_at") && nothingMoved(), laterProblem);
const fake = altered(zip, "fake", "site/sent.json", (rows) => [{ fp: "x".repeat(43), host: "y".repeat(43), item: "z".repeat(43), kind: "comment",
  record: JSON.stringify({ record: "e30", sig: "x" }), receipt: null, created_at: 1700000000 }, ...rows]);
const fakeProblem = await move(ann2, fake);
check("a made-up record of something Ann said elsewhere is refused", fakeProblem.includes("sent") && nothingMoved(), fakeProblem);
// A host changing when it took a comment (the running fingerprint no longer adds up), and one adding a comment.
const retimed = altered(zip, "retimed", "site/list_pages.json", (rows) => rows.map((p) => (p.list !== movingPost ? p
  : { ...p, entries: JSON.stringify(JSON.parse(p.entries).map((e, i) => (i === 1 ? { ...e, taken: e.taken - 3600 } : e))) })));
const retimedProblem = await move(ann2, retimed);
check("a list that's been changed doesn't check, and nothing moves", retimedProblem.includes("doesn't check") && nothingMoved(), retimedProblem);
const padded = altered(zip, "padded", "site/lists.json", (rows) => rows.map((l) => (l.id !== movingPost ? l : { ...l, n: l.n + 1 })));
const paddedProblem = await move(ann2, padded);
check("…nor does one that says it's longer than it is", paddedProblem.includes("doesn't check") && nothingMoved(), paddedProblem);

const problem = await move(ann2, zip.file);
check("the move finishes", !problem, problem);
await ann2.screenshot({ path: `${OUT}/move-done.png` });
check("Ann's identity is C's now: the same chain, nothing waiting", JSON.stringify(chainOf(stateC)) === JSON.stringify(chainOf(stateA))
  && sql(stateC, "SELECT person FROM own_identity")[0]?.person === person && count(stateC, "move_in") === 0);
const wellKnown = await (await fetch(`${C}/.well-known/afterwrd`)).json();
check("…and C publishes it", wellKnown.chain?.length === 4);
const same = (state, table, columns) => JSON.stringify(sql(state, `SELECT ${columns} FROM ${table} ORDER BY 1, 2`));
for (const [table, columns] of [["lists", "id, owner, n, head"], ["list_pages", "list, page, entries"], ["items", "id, author, type, comments, others, created_at"],
  // A post's row is worked out again from its list on C (a photo's, never changed on A, gains what that adds).
  ["items WHERE type = 'post'", "id, content, earlier, version, tally"],
  ["item_photos", "*"], ["sent", "*"], ["media", "hash, item_id"], ["posts", "id, text"]]) {
  check(`${table} came over as they were`, (count(stateA, table) > 0 || table === "sent") && same(stateA, table, columns) === same(stateC, table, columns),
    `${count(stateA, table)} on A, ${count(stateC, table)} here`);
}
check("Bob came over as Ann's friend", JSON.stringify(sql(stateC, "SELECT origin, identity, approved_at IS NOT NULL AS approved FROM connections"))
  === JSON.stringify(sql(stateA, "SELECT origin, identity, 1 AS approved FROM connections")));
check("the new site remembers where it came from", sql(stateC, "SELECT value FROM settings WHERE key = 'moved_from'")[0]?.value === A);
check("nothing is left half-way", sql(stateC, "SELECT name FROM sqlite_master WHERE name LIKE '%_move' OR name = 'move_checked'").length === 0);
check("this browser can sign for Ann on C", count(stateC, "delegations") === 1);

const posts = await text(ann2, `${C}/posts`);
check("Ann's posts show on C", ["Moving day soon", "Picnic in the park"].every((t) => posts.includes(t)), posts.slice(0, 200));
await ann2.goto(`${C}/posts/${movingPost}`);
await ann2.$$eval("main article.card img", (l) => l.forEach((i) => i.scrollIntoView()));
await ann2.waitForFunction(() => [...document.querySelectorAll("main article.card img")].every((i) => i.complete), { timeout: 10_000 }).catch(() => {});
const thread = await ann2.$eval("main", (m) => m.innerText);
check("…with both comments, checked", thread.includes("Good luck with the move!") && thread.includes("Thanks, all!"), thread.slice(0, 300));
const notLoaded = await ann2.$$eval("main article.card img", (l) => (l.length ? l.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")) : ["no images"]));
check("…and photos that load", !notLoaded.length, notLoaded.join(" "));

// --- Bob's site at C ----------------------------------------------------------------------------------------------------
sql(stateB, "UPDATE connections SET items_checked_at = NULL");
await bob.goto(`${B}/`);
const bobHome = await bob.$eval("main", (m) => m.innerText);
check("Bob's Home has Ann's posts again, from C", bobHome.includes("Moving day soon") && count(stateB, "copies") >= 2
  && sql(stateB, "SELECT reached_at IS NOT NULL AS ok FROM connections")[0]?.ok === 1, bobHome.slice(0, 200));
check("…and no longer says she's moving", !(await notices(bob, B)).some((t) => t.includes("moving to") || t.includes("moved to")));
await bob.goto(`${B}/`);
await (await moving(bob)).evaluate((a) => { a.id = "moving"; });
const bobThread = await (async () => { await openThread(bob, "#moving"); return bob.$eval("#moving", (a) => a.innerText); })();
check("Bob opens Ann's post at C, and every comment checks", bobThread.includes("Good luck with the move!") && bobThread.includes("Thanks, all!")
  && !bobThread.includes("couldn't be checked"), bobThread.slice(0, 300));
await comment(bob, "#moving", "Lovely new place!");
check("Bob's new comment reaches Ann's post at C", sql(stateC, `SELECT comments FROM items WHERE id = '${movingPost}'`)[0]?.comments === 3);
await compose(ann2, C, "Hello from my new site");
let heard = false;
for (const end = Date.now() + 20_000; Date.now() < end && !heard; await new Promise((r) => setTimeout(r, 500))) {
  heard = count(stateB, "copies WHERE content LIKE '%Hello from my new site%'") === 1;
}
check("Ann posts from C, and Bob's site is told", heard);
const oldAddress = await siteCall(stateB, B, `${A}/_p/items?since=0`);
check("A still only says where Ann has gone", oldAddress.status === 410);

const twice = await move(ann2, zip.file);
check("a site that has things on it can't take a move", Boolean(twice) && count(stateC, "items") === count(stateA, "items") + 1, twice);
check("no errors in the pages", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
