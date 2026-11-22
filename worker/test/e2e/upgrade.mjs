// Before: on an older release (0.17.0 or later; earlier ones started a different database), set up, import the tiny
// Facebook download, post two photos with a comment, a poll with an answer (where the release has polls), an album, a
// profile picture, and comments on an imported post and photo. After: on the new code, with the same database,
// everything made on afterwrd is still there at the same addresses, the comments on imported things are gone (only
// what's made on afterwrd takes comments now), and the album tools work.
//   node upgrade.mjs before|after <fixtures> <zip>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { settled, setUpSigning } from "./helpers.mjs";
import { MOVED } from "../../src/sitecopy.js";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stage, fixtures, zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const SAVED = `${OUT}/upgrade-state.json`;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  [${stage}] ${name}${extra ? `  (${extra})` : ""}`); if (!ok) process.exitCode = 1; };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
// afterwrd asks in its own box (ui.js): say yes, as a person would.
await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
  .observe(document, { childList: true, subtree: true }));
const say = async (scope, text) => {
  await page.type(`${scope} .say textarea`, text);
  await Promise.all([settled(page), page.click(`${scope} .say button`)]);
};
const said = (scope) => page.$$eval(`${scope} .comment .said`, (l) => l.map((c) => c.textContent));
const own = "main article.card.own";
const AUTHENTICATOR = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };

if (stage === "before") {
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
  await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
  await page.type("#name", "Upgrader");
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);

  // The Facebook download, with comments on one of its posts and one of its photos (allowed until now).
  await page.goto(`${BASE}/_admin/import`);
  await (await page.$("#zips")).uploadFile(zipPath);
  await page.$$eval("input[name=section]", (boxes) => boxes.forEach((b) => { b.checked = ["posts", "photos"].includes(b.value); }));
  await page.click("#go");
  await page.waitForFunction(() => /Done\./.test(document.getElementById("status").textContent)
    || document.getElementById("error").textContent, { timeout: 180_000, polling: 500 });
  check("imported on the old release", !(await page.$eval("#error", (e) => e.textContent)));
  // (From 0.41.0, imported posts and photos take no comments: nothing to say there.)
  await page.goto(`${BASE}/posts`);
  if (await page.$("main article.card:last-of-type .say")) await say("main article.card:last-of-type", "On an imported post");
  await page.goto(`${BASE}/photos/album/other`);
  const importedPhoto = await page.$eval(".justified a.tile", (a) => a.getAttribute("href"));
  await page.goto(BASE + importedPhoto);
  if (await page.$(".info .say")) await say(".info", "On an imported photo");

  // Posted here: two photos with a comment, and a poll with an answer.
  await page.goto(`${BASE}/posts`);
  await page.type("#composer textarea", "Before the upgrade");
  await (await page.$("#composer input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#composer button.post")]);
  await say(`${own}:first-of-type`, "Still here?");
  const address = await page.$eval(`${own}:first-of-type a.when`, (a) => a.getAttribute("href"));
  const photo = await page.$eval(`${own}:first-of-type .collage a.tile`, (a) => a.getAttribute("href"));
  await page.goto(BASE + photo);
  await say(".info", "Nice photo");
  check("posted on the old release", (await page.$eval(".info article.card", (a) => a.querySelectorAll(".collage .tile").length)) === 2);
  await page.evaluate(() => fetch("/_admin/posts", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Tea or coffee?", poll: { options: ["Tea", "Coffee"], multiple: false } }) }));
  await page.goto(`${BASE}/posts`);
  const poll = Boolean(await page.$(`${own}:first-of-type .poll-form`));
  if (poll) await Promise.all([settled(page), page.click(`${own}:first-of-type .poll-form button.poll-option`)]);

  // An album of their own, and a profile picture.
  await page.goto(`${BASE}/_admin/photos/add`);
  await page.type("input[name=name]", "Summer");
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  const album = new URL(page.url()).pathname;
  await page.goto(`${BASE}/_admin/photos/add?for=profile`);
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/big.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);

  // The passkey too (this browser's virtual one), so after the update the same owner can set up signing with it.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  writeFileSync(SAVED, JSON.stringify({ cookie: (await page.cookies()).find((c) => c.name === "__Host-session").value,
    address, photo, poll, album, importedPhoto, credentials }));
} else {
  const was = JSON.parse(readFileSync(SAVED, "utf8"));
  await page.setCookie({ name: "__Host-session", value: was.cookie, domain: "localhost", path: "/", secure: true, httpOnly: true });
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
  for (const credential of was.credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });

  // afterwrd 2 (step 10a): nothing works until signing is set up, so the first page after the update is the recovery
  // code, with no "Not now", and then the page the owner was going to. Download everything still opens first.
  await page.goto(BASE + was.address);
  const keys = new URL(page.url());
  check("after the update, the first page is setting up signing", keys.pathname === "/_admin/keys" && keys.searchParams.get("next") === was.address, page.url());
  check("…with no way to put it off", !(await page.$("#later")) && !(await page.content()).includes("Not now"));
  await page.goto(`${BASE}/_admin/export`);
  check("Download everything still opens before it's done", new URL(page.url()).pathname === "/_admin/export");
  await page.goto(BASE + was.address);
  await setUpSigning(page);
  check("…and once it's done, on to where the owner was going", new URL(page.url()).pathname === was.address, page.url());

  await page.goto(BASE + was.address);
  const card = await page.$eval("main article.card", (a) => ({ text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
    comments: [...a.querySelectorAll(".comment .said")].map((c) => c.textContent) }));
  check("the post keeps its address, with both photos and its comment", card.text === "Before the upgrade" && card.photos === 2
    && card.comments.join() === "Still here?", JSON.stringify(card));
  // Written before signing: the owner's alone, read-only, until migration turns it into a signed post.
  check("…only the owner's now, and read-only", (await page.$eval("main article.card", (a) => a.textContent)).includes("Only you can see this for now")
    && !(await page.$("main article.card form")) && !(await page.$("main article.card details.more")));
  // On its own (from 0.45.0, a post's photos link to themselves "in" the post, which names the post instead).
  await page.goto(BASE + was.photo.split("?")[0]);
  check("its photo keeps its comment, in Posted on afterwrd", (await said(".info")).join() === "Nice photo"
    && (await page.$eval(".info .album-link", (a) => a.textContent)) === "Posted on afterwrd");

  await page.goto(`${BASE}/posts`);
  check("imported posts are still there, with no comments or comment box", (await page.$$("main article.card:not(.own)")).length === 2
    && !(await page.$("main article.card:not(.own) .say")) && !(await page.content()).includes("On an imported post"));
  await page.goto(BASE + was.importedPhoto);
  check("…and imported photos too", Boolean(await page.$(".stage img")) && !(await page.$(".info .say"))
    && !(await page.content()).includes("On an imported photo"));
  await page.goto(`${BASE}/activity`);
  const notes = await page.$$eval(".activity .text", (l) => l.map((t) => t.textContent));
  check("Notifications keep the comments that are still there", notes.length === 2 && notes.includes("Still here?") && notes.includes("Nice photo"), notes.join("|"));

  if (was.poll) {
    await page.goto(`${BASE}/posts`);
    const poll = await page.$$eval(`${own} .poll-option`, (l) => l.map((o) => ({ text: o.textContent.trim(), chosen: o.classList.contains("chosen") })));
    check("the poll keeps its answer", poll.length === 2 && poll[0].chosen && poll[0].text.startsWith("Tea"), JSON.stringify(poll));
    check("…read-only now", !(await page.$(`${own} .poll-form`)));
  } else console.log(`SKIP  [${stage}] no polls on that release`);

  await page.goto(BASE + was.album);
  check("the album made before is still there", (await page.$eval("h1", (h) => h.textContent)) === "Summer"
    && (await page.$$eval(".justified a.tile", (l) => l.length)) === 1);
  await page.goto(`${BASE}/_admin/photos/add?for=profile`);
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  await page.goto(`${BASE}/photos`);
  const albums = await page.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
  check("a new profile picture joins the same Profile pictures album", albums.filter((a) => a === "Profile pictures").length === 1, albums.join());

  await page.goto(`${BASE}/_admin/photos/add`);
  await page.type("input[name=name]", "After");
  await (await page.$("#add input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click("#add button.post")]);
  check("new albums work on the upgraded site", (await page.$$eval(".justified a.tile", (l) => l.length)) === 1);
  await page.goto(`${BASE}/posts`);
  await page.type("#composer textarea", "After the upgrade");
  await Promise.all([page.waitForNavigation(), page.click("#composer button.post")]);
  check("new posts work too", (await page.$eval(`${own}:first-of-type .text`, (t) => t.textContent)) === "After the upgrade");
  // Comments made before the upgrade stay as they were, until migration turns them into signed comments.
  await page.goto(BASE + was.address);
  check("a comment from before the upgrade stays as it was, with no way to change it", (await said("main article.card")).join() === "Still here?"
    && !(await page.$("main article.card .comment details.more")));

  // The site moved into its own object (src/sitecopy.js): its old D1 database is kept, marked moved, so an older
  // version would say the site is being updated rather than carry on with it.
  const d1 = join(OUT, "stateU", "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(d1).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const old = new DatabaseSync(join(d1, file), { readOnly: true });
  try {
    // A site begun on 0.57.0 or later kept everything in its object from the start: its D1 database was never used.
    const usedD1 = Boolean(old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get());
    if (usedD1) {
      check("the old database is kept, marked moved, with the posts from before still in it",
        Boolean(old.prepare(`SELECT 1 FROM d1_migrations WHERE name = '${MOVED}'`).get())
        && Boolean(old.prepare("SELECT 1 FROM posts WHERE text = 'Before the upgrade'").get()));
    } else {
      check("a site begun in its own object never used D1", !old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get());
    }
  } finally {
    old.close();
  }
}
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
