// Moving a whole site (src/move.js): Ann's site A (a Facebook import, posts with photos, her comment and her friend
// Bob's, an edit, a poll and an event) is downloaded with Download everything and taken in by a new site, C, as it
// would be when she moves to a server of her own. Downloads from another version, without photos, or tampered with
// are refused with nothing changed; a site that already has things on it can't take a move.
//   node move.mjs <zip> <fixtures dir> <A state dir> <B state dir> <C state dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { count, settled, siteSql as sql } from "./helpers.mjs";
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
async function owner(site, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
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
  await (await page.$("#zip")).uploadFile(file);
  await page.click("#go");
  await page.waitForFunction(() => /Done/.test(document.getElementById("status").textContent) || document.getElementById("error").textContent,
    { timeout: 180_000, polling: 500 });
  return page.$eval("#error", (e) => e.textContent);
}

// Ann's site, with a bit of everything.
const ann = await owner(A, "Ann Example");
const bob = await owner(B, "Bob Example");
check("Ann's site imports her Facebook archive", !(await importZip(ann, A)));
await compose(ann, A, "Moving day soon", [`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`]);
await compose(ann, A, "Which cake?");
await compose(ann, A, "Picnic in the park");
await befriend(ann, A, bob, B);
for (const end = Date.now() + 20_000; Date.now() < end && !(await bob.$("article.from-friend .say textarea")); await new Promise((r) => setTimeout(r, 500))) {
  await bob.goto(`${B}/`);
}
await bob.type("article.from-friend .say textarea", "Good luck with the move!");
await Promise.all([settled(bob), bob.click("article.from-friend .say button")]);
await ann.goto(`${A}/posts`);
const card = await ann.evaluateHandle(() => [...document.querySelectorAll("article.own")].find((a) => a.innerText.includes("Moving day soon")));
await (await card.$(".say textarea")).type("Thanks, all!");
await Promise.all([settled(ann), (await card.$(".say button")).click()]);
const own = (text) => sql(stateA, `SELECT id, key FROM posts WHERE source = 'afterwrd' AND text = '${text}'`)[0];
const cake = own("Which cake?");
const picnic = own("Picnic in the park");
const photo = sql(stateA, "SELECT hash, thumb_hash FROM media WHERE source = 'afterwrd' AND thumb_hash IS NOT NULL LIMIT 1")[0];
sql(stateA, `INSERT INTO polls (post_id, options, multiple) VALUES (${cake.id}, '["Lemon","Chocolate"]', 0);
  INSERT INTO poll_votes (post_id, voter, name, choices, voted_at) VALUES (${cake.id}, '${B}', 'Bob Example', 2, 1700000000);
  INSERT INTO events (post_id, title, starts_at, all_day, time_zone, place) VALUES (${picnic.id}, 'Picnic', 1900000000, 0, 'Europe/London', 'The park');
  INSERT INTO post_versions (post_id, text, replaced_at) VALUES (${picnic.id}, 'Picnic somewhere', 1700000000);
  UPDATE posts SET edited_at = 1700000000 WHERE id = ${picnic.id};
  INSERT OR REPLACE INTO settings (key, value) VALUES ('profile_hash', '${photo.hash}')`);
check("Ann's site has a friend's comment and her own", count(stateA, "comments WHERE origin = 'site'") === 1
  && count(stateA, `comments WHERE origin = '${B}'`) === 1);

// Download everything carries the rows and thumbnails, and still no keys.
const zip = await download(ann, A, "ann");
check("the download finishes", !zip.problem, zip.problem);
const about = zip.json("site/about.json");
check("it says which site and database it's from", about.site === A && /^\d{4}_/.test(about.database) && about.media === true, JSON.stringify(about));
check("it has the rows of every table that moves", ["posts", "media", "albums", "comments", "polls", "events", "settings", "facebook_people"]
  .every((t) => zip.list.some((f) => f.endsWith(`/site/${t}.json`))));
check("…and the thumbnails", zip.list.some((f) => f.endsWith(`/site/thumbs/${photo.thumb_hash}.jpg`)));
const rowsText = zip.list.filter((f) => f.includes("/site/") && f.endsWith(".json")).map((f) => zip.read(f.slice(f.indexOf("/") + 1)).toString()).join("");
const keys = sql(stateA, "SELECT their_key, key_hash FROM connections")[0];
check("no keys in the site's rows", !rowsText.includes(keys.their_key) && !rowsText.includes(keys.key_hash) && !rowsText.includes("key_hash")
  && !rowsText.includes("challenge_key") && !rowsText.includes("media_key"));

// The new site.
const ann2 = await owner(C, "Ann Example");
await ann2.goto(`${C}/_admin/import`);
check("Import offers to bring everything over from another site", Boolean(await ann2.$('a[href="/_admin/import/move"]')));
const nothingMoved = () => count(stateC, "posts") === 0 && count(stateC, "media") === 0 && count(stateC, "comments") === 0;

const older = altered(zip, "older", "site/about.json", (a) => ({ ...a, database: "0001_schema.sql", version: "0.17.0" }));
const olderProblem = await move(ann2, older);
check("a download from another version is refused, saying to update", olderProblem.includes("same version") && nothingMoved(), olderProblem);

const bare = await download(ann, A, "bare", { media: false });
const bareProblem = await move(ann2, bare.file);
check("a download without photos is refused, saying how to make one", bareProblem.includes("Include photos and videos") && nothingMoved(), bareProblem);

const sly = altered(zip, "sly", "site/comments.json", (rows) => rows.map((c, i) => (i ? c : { ...c, origin: "javascript:alert(1)" })));
const slyProblem = await move(ann2, sly);
check("a tampered download is refused, with nothing moved", slyProblem.includes("comments.origin") && nothingMoved(), slyProblem);

const sneaky = altered(zip, "sneaky", "site/settings.json", (rows) => [...rows, { key: "media_key", value: "chosen-by-someone-else" }]);
const sneakyProblem = await move(ann2, sneaky);
check("a download can't set the site's own keys", sneakyProblem.includes("settings.key") && nothingMoved()
  && !sql(stateC, "SELECT value FROM settings WHERE key = 'media_key'").some((s) => s.value === "chosen-by-someone-else"), sneakyProblem);

const later = altered(zip, "later", "site/comments.json", (rows) => rows.map((c, i) => (i ? c : { ...c, created_at: 4102444800 })));
const laterProblem = await move(ann2, later);
check("a comment dated in the future is refused (it would use up a friend's allowance)", laterProblem.includes("comments.created_at")
  && nothingMoved(), laterProblem);

const wordy = altered(zip, "wordy", "site/comments.json", (rows) => rows.map((c, i) => (i ? c : { ...c, text: "x".repeat(5000) })));
const wordyProblem = await move(ann2, wordy);
check("a comment longer than afterwrd allows is refused", wordyProblem.includes("comments.text") && nothingMoved(), wordyProblem);

// The real move, with an edit history planted for a post that isn't in the download: it mustn't attach itself to the
// next post made here.
const planted = altered(zip, "planted", "site/post_versions.json", (rows) => [...rows, { ...rows[0], id: 99999, post_id: 999999 }]);
const problem = await move(ann2, planted);
check("the move finishes", !problem, problem);
await ann2.screenshot({ path: `${OUT}/move-done.png` });
const same = (table, columns = "*") => JSON.stringify(sql(stateA, `SELECT ${columns} FROM ${table} ORDER BY 1, 2`))
  === JSON.stringify(sql(stateC, `SELECT ${columns} FROM ${table} ORDER BY 1, 2`));
for (const table of ["posts", "media", "albums", "polls", "poll_votes", "events", "post_versions", "facebook_people"]) {
  check(`${table} came over as they were`, count(stateA, table) > 0 && same(table), `${count(stateA, table)} on A, ${count(stateC, table)} here`);
}
check("comments came over, Ann's as hers here", same("comments", "id, target, author_name, text, created_at, origin")
  && sql(stateC, "SELECT author_id FROM comments WHERE origin = 'site'")[0]?.author_id === sql(stateC, "SELECT id FROM users")[0].id);
check("her profile picture and Facebook sections came too", same("settings WHERE key IN ('profile_hash', 'sections')"));
check("the new site remembers where it came from", sql(stateC, "SELECT value FROM settings WHERE key = 'moved_from'")[0]?.value === A);
check("friends and groups don't come (no keys)", count(stateC, "connections") === 0 && count(stateC, "groups") === 0);
check("nothing is left half-way", sql(stateC, "SELECT name FROM sqlite_master WHERE name LIKE '%_move'").length === 0);
check("rows pointing at what didn't come are dropped (the planted edit history)", count(stateC, "post_versions WHERE post_id = 999999") === 0);
const highest = sql(stateA, "SELECT COALESCE(MAX(id), 0) AS n FROM comments")[0].n;
check("comment numbers carry on 1000 past the highest moved", (sql(stateC, "SELECT seq FROM sqlite_sequence WHERE name = 'comments'")[0]?.seq ?? 0)
  >= highest + 1000 && count(stateC, "comments WHERE target = ''") === 0);

const files = await ann2.evaluate(async (hashes) => Promise.all(hashes.map(async (h) => {
  const r = await fetch(`/files/${h}`);
  return [r.status, [...new Uint8Array(await crypto.subtle.digest("SHA-256", await r.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("")];
})), [photo.hash, photo.thumb_hash]);
check("photos and thumbnails are stored, intact", files.every(([status, hash], i) => status === 200 && hash === [photo.hash, photo.thumb_hash][i]));
await ann2.goto(`${C}/posts`);
const posts = await ann2.$eval("main", (m) => m.innerText);
const missing = ["Moving day soon", "Which cake?", "Good luck with the move!", "Thanks, all!"].filter((t) => !posts.includes(t));
check("Ann's posts show on the new site, with both comments", !missing.length, missing.join(", "));
// Photos further down load lazily, as they're scrolled to: scroll to each, and give them a moment.
await ann2.$$eval("main article.card img", (l) => l.forEach((i) => i.scrollIntoView()));
await ann2.waitForFunction(() => [...document.querySelectorAll("main article.card img")].every((i) => i.complete), { timeout: 10_000 }).catch(() => {});
const notLoaded = await ann2.$$eval("main article.card img", (l) => l.length ? l.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")) : ["no images"]);
check("…photos load", !notLoaded.length, notLoaded.join(" "));
await ann2.goto(`${C}/posts/${picnic.key}`);
check("an event shows", (await ann2.$eval("main", (m) => m.innerText)).includes("The park"));
await ann2.goto(`${C}/posts/${cake.key}`);
check("a poll shows", (await ann2.$eval("main", (m) => m.innerText)).includes("Chocolate"));
await ann2.goto(`${C}/`);
check("Home opens", (await ann2.$("main")) !== null);

const again = await move(ann2, zip.file);
check("a site that has things on it can't take a move", again.includes("already has"), again);
check("no errors in the pages", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
