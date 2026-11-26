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
import { settled, setUpSigning, siteSql } from "./helpers.mjs";
import { MOVED } from "../../src/sitecopy.js";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stage, fixtures, zipPath] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const STATE = `${OUT}/stateU`;
const SAVED = `${OUT}/upgrade-state.json`;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  [${stage}] ${name}${extra ? `  (${extra})` : ""}`); if (!ok) process.exitCode = 1; };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|'integrity'/.test(m.text())) errors.push(m.text()); }); // blocked by the page's policy
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

  // Step 10b: Home brings the posts from before over as signed posts, signed by this browser with no prompt, each saying
  // when it was first written. Their own old rows go. Then (10c) the comments on them, all the owner's own here: signed
  // by this browser too, dated as first written, and in their posts' lists in the order they were written.
  const sql = (q) => siteSql(STATE, q);
  check("friends still see what was published from Facebook, now a choice of its own (migration 0059)",
    sql("SELECT value FROM settings WHERE key = 'friends_see'")[0]?.value === '["posts","photos"]', JSON.stringify(sql("SELECT value FROM settings WHERE key = 'friends_see'")));
  const written = Object.fromEntries(sql("SELECT key, created_at FROM posts WHERE source = 'afterwrd'").map((r) => [r.key, r.created_at]));
  const oldKey = was.address.split("/").pop();
  await page.goto(`${BASE}/`);
  const left = Object.keys(written).length;
  check("Home says it's bringing the posts from before over", /Bringing your (\d+ )?posts from\s+before afterwrd 2 over/.test(await page.$eval("#bring-over", (p) => p.textContent).catch(() => ""))
    || sql("SELECT COUNT(*) AS n FROM brought")[0].n > 0, `${left} to bring`);
  const waited = Date.now();
  const brought = () => sql("SELECT COUNT(*) AS n FROM posts WHERE source = 'afterwrd'")[0].n === 0
    && sql("SELECT COUNT(*) AS n FROM before_comments")[0].n === 0 && sql("SELECT COUNT(*) AS n FROM items WHERE before_until IS NOT NULL")[0].n === 0;
  while (!brought() && Date.now() - waited < 30_000) await new Promise((r) => setTimeout(r, 300));
  await settled(page).catch(() => {});
  await page.goto(`${BASE}/`);
  check("…and once they and their comments are signed, it says nothing more", brought() && !(await page.$("#bring-over")));
  const item = sql(`SELECT item FROM brought WHERE old = '${oldKey}'`)[0]?.item;
  const noted = new Set(sql("SELECT old FROM brought").map((r) => r.old));
  check("every post from before is noted as brought over, and each photo's address", Boolean(item) && Object.keys(written).every((k) => noted.has(k))
    && sql("SELECT COUNT(*) AS n FROM media WHERE post_id IS NOT NULL AND source = 'afterwrd'")[0].n === 0
    && sql("SELECT hash FROM media WHERE item_id IS NOT NULL AND source = 'afterwrd'").every((m) => noted.has(`photo-${m.hash}`)), [...noted].join(" "));
  const first = JSON.parse(sql(`SELECT entries FROM list_pages WHERE list = '${item}' ORDER BY page LIMIT 1`)[0]?.entries ?? "[]")[0];
  const signed = first?.sent?.record ? JSON.parse(Buffer.from(first.sent.record, "base64url").toString()) : {};
  check("…keeping when it was first written, as its signed record says", signed.before === written[oldKey]
    && sql(`SELECT created_at FROM items WHERE id = '${item}'`)[0]?.created_at === written[oldKey], JSON.stringify({ before: signed.before, was: written[oldKey] }));
  await page.goto(BASE + was.address);
  check("its old address leads to the signed post", new URL(page.url()).pathname === `/posts/${item}`, page.url());
  const card = await page.$eval("main article.card", (a) => ({ text: a.querySelector(".text")?.textContent, photos: a.querySelectorAll(".collage .tile").length,
    whole: a.textContent }));
  check("…with its words and both photos, no longer only the owner's", card.text === "Before the upgrade" && card.photos === 2
    && !card.whole.includes("Only you can see this for now"), JSON.stringify(card));
  check("…with its comment from before, signed, and the box to add more", (await said("main .thread")).join() === "Still here?"
    && Boolean(await page.$("main .thread form.say")) && !(await page.$("main .thread .frozen")));
  const comment = JSON.parse(sql(`SELECT entries FROM list_pages WHERE list = '${item}' ORDER BY page LIMIT 1`)[0].entries)[1];
  check("…dated as first written, in its signed record", JSON.parse(Buffer.from(comment.sent.record, "base64url").toString()).before > 0
    && JSON.parse(Buffer.from(comment.sent.record, "base64url").toString()).before < comment.taken);
  // Its photo, an item of its own now, at the same address, with its own comment from before.
  await page.goto(BASE + was.photo.split("?")[0]);
  check("its photo is still at its address, a signed photo now, with its comment", Boolean(await page.$(".stage img"))
    && (await said(".info .thread")).join() === "Nice photo" && Boolean(await page.$(".info .thread form.say")));

  await page.goto(`${BASE}/posts`);
  check("imported posts are still there, with no comments or comment box", (await page.$$("main article.card:not(.own)")).length === 2
    && !(await page.$("main article.card:not(.own) .say")) && !(await page.content()).includes("On an imported post"));
  await page.goto(BASE + was.importedPhoto);
  check("…and imported photos too", Boolean(await page.$(".stage img")) && !(await page.$(".info .say"))
    && !(await page.content()).includes("On an imported photo"));

  if (was.poll) {
    // Votes aren't brought over (only the host kept them): the poll comes over open, and anyone can vote again.
    await page.goto(`${BASE}/posts`);
    const poll = await page.$$eval(`${own} .poll-option`, (l) => l.map((o) => ({ text: o.textContent.trim(), chosen: o.classList.contains("chosen") })));
    check("the poll comes over with its options, and no votes", poll.length === 2 && poll[0].text.startsWith("Tea") && !poll.some((o) => o.chosen), JSON.stringify(poll));
    check("…open to vote on again", Boolean(await page.$(`${own} .poll-form`)));
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
  check("the old comments' rows are gone, now they're signed", sql("SELECT COUNT(*) AS n FROM comments")[0].n === 0);

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
