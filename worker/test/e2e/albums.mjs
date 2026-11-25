// Albums, photos and profile pictures on a fresh site (SETUP_CODE=local-test-setup-code):
//   node albums.mjs <fixtures dir>
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { siteSql, setUpSigning } from "./helpers.mjs";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [fixtures] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-prefers-reduced-motion"] });
async function person(start) {
  const page = await (await browser.createBrowserContext()).newPage();
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
  await start(page);
  return page;
}
const owner = await person(async (page) => {
  await page.goto(`${BASE}/_auth/setup?code=local-test-setup-code`);
  await page.type("#name", "Alex Owner");
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await Promise.all([page.waitForNavigation(), page.click("#go")]);
  await setUpSigning(page);
});
const cookie = async () => (await owner.cookies()).find((c) => c.name === "__Host-session").value;
const fileStatus = async (hash) => (await fetch(`${BASE}/files/${hash}`, { headers: { Cookie: `__Host-session=${await cookie()}` } })).status;
const tiles = () => owner.$$eval(".justified a.tile", (l) => l.length);

await owner.goto(`${BASE}/posts`);
check("Posts invites the owner to add a picture and cover", (await owner.$eval("main", (m) => m.textContent)).includes("Add a profile picture"));

// A new album. (Adding photos makes no post: friends see them in the album. Only signed posts are on Home.)
await owner.goto(`${BASE}/photos`);
await Promise.all([owner.waitForNavigation(), owner.click('main a[href="/_admin/photos/add"]')]);
check("new album is the default, with name and description", (await owner.$eval("select[name=album]", (s) => s.value)) === "new"
  && !(await owner.$eval(".new-album", (d) => d.hidden)));
await owner.type("input[name=name]", "Summer");
await owner.type(".new-album textarea", "Days out");
await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`, `${fixtures}/big.jpg`);
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
const albumPath = new URL(owner.url()).pathname;
check("there's no choice to share them as a post", !(await owner.$("#add input[name=share]")) && !(await owner.$("#add textarea[name=text]")));
check("lands on the new album with both photos", /^\/photos\/album\/\d+$/.test(albumPath) && (await tiles()) === 2
  && (await owner.$eval("h1", (h) => h.textContent)) === "Summer" && (await owner.$eval(".album-head", (h) => h.textContent)).includes("Days out"), albumPath);
await owner.goto(`${BASE}/posts`);
check("…and no post", (await owner.$$eval("main article.card", (l) => l.length)) === 0 && siteSql(null, "SELECT COUNT(*) AS n FROM posts")[0].n === 0);

// More photos into the same album.
await owner.goto(BASE + albumPath);
await Promise.all([owner.waitForNavigation(), owner.click('.album-tools a[href^="/_admin/photos/add?album="]')]);
check("Add photos from an album picks that album", (await owner.$eval("select[name=album]", (s) => s.options[s.selectedIndex].text)) === "Summer"
  && (await owner.$eval(".new-album", (d) => d.hidden)));
// The album list is a box you can type into (ui.js): typing narrows it, and picking sets the real (hidden) choice.
check("the album choice shows as a search box, with the album chosen", (await owner.$eval("select[name=album]", (s) => s.hidden))
  && (await owner.$eval(".picker-input", (i) => i.value)) === "Summer");
await owner.click(".picker-input");
await owner.type(".picker-input", "new");
const narrowed = await owner.$$eval(".picker-list li", (l) => l.map((li) => li.textContent));
check("…typing narrows the list", narrowed.join() === "New album…", narrowed.join());
await owner.keyboard.press("Enter");
check("…and Enter picks it, as choosing in the list would (the new album's boxes appear)", (await owner.$eval("select[name=album]", (s) => s.value)) === "new"
  && !(await owner.$eval(".new-album", (d) => d.hidden)) && (await owner.$eval(".picker-input", (i) => i.value)) === "New album…");
await owner.click(".picker-input");
await owner.type(".picker-input", "summ");
await owner.keyboard.press("Enter");
check("…and back again", (await owner.$eval("select[name=album]", (s) => s.options[s.selectedIndex].text)) === "Summer" && (await owner.$eval(".new-album", (d) => d.hidden)));

// Asking first happens in afterwrd's own box (ui.js), not the browser's: Cancel leaves things as they were. (A page
// of its own, without the stand-in that says yes.)
const asker = await owner.browserContext().newPage();
asker.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
await asker.goto(BASE + albumPath);
const tilesBefore = await asker.$$eval(".tile", (l) => l.length);
await asker.click(".tile");
await asker.waitForSelector("button.chip.danger");
const photoUrl = asker.url();
await asker.click("main form[data-confirm] button");
await asker.waitForSelector("dialog.ask[open]");
const asked = await asker.$eval("dialog.ask", (d) => ({ words: d.querySelector("p").textContent, buttons: [...d.querySelectorAll("button")].map((b) => b.textContent),
  focused: document.activeElement?.textContent }));
check("deleting a photo asks in afterwrd's own box, with Cancel ready and the button saying what it does", asked.words.startsWith("Delete this photo")
  && asked.buttons.join() === "Cancel,Delete" && asked.focused === "Cancel", JSON.stringify(asked));
await asker.click("dialog.ask button.chip:not(.danger)");
await new Promise((r) => setTimeout(r, 500));
check("…and Cancel leaves the photo be", asker.url() === photoUrl && (await asker.$("dialog.ask")) === null
  && (await asker.goto(BASE + albumPath), (await asker.$$eval(".tile", (l) => l.length)) === tilesBefore));
await asker.close();
await owner.bringToFront(); // a tab left in the background stops answering in headless Chrome

await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/big-secret.jpg`);
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
check("album now has three", (await tiles()) === 3);

// Rename.
await owner.goto(BASE + albumPath);
await owner.click(".edit-album summary");
await owner.$eval(".edit-album input[name=name]", (i) => { i.value = ""; });
await owner.type(".edit-album input[name=name]", "Summer 2026");
await Promise.all([owner.waitForNavigation(), owner.click(".edit-album button")]);
check("album renamed", (await owner.$eval("h1", (h) => h.textContent)) === "Summer 2026");

// Profile picture and cover from existing photos.
await owner.goto(BASE + albumPath);
const photoHrefs = await owner.$$eval(".justified a.tile", (l) => l.map((a) => a.getAttribute("href")));
await owner.goto(BASE + photoHrefs[0]);
await Promise.all([owner.waitForNavigation(), owner.click('.photo-tools form:nth-of-type(2) button')]);
await owner.goto(BASE + photoHrefs[1]);
await Promise.all([owner.waitForNavigation(), owner.click('.photo-tools form:nth-of-type(1) button')]);
await owner.goto(`${BASE}/posts`);
const header = await owner.$eval("section.profile", (s) => ({ cover: s.querySelector(".cover img")?.getAttribute("src"), avatar: s.querySelector(".avatar img")?.getAttribute("src"),
  name: s.querySelector(".name").textContent }));
check("Posts shows the chosen picture and cover, and the name", Boolean(header.cover && header.avatar) && header.name === "Alex Owner", JSON.stringify(header));

// The picture sits on top of the cover where they overlap.
const onTop = await owner.evaluate(() => {
  const r = document.querySelector("section.profile .avatar").getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
  return Boolean(hit?.closest(".avatar"));
});
check("the profile picture is drawn over the cover, not under it", onTop);
await owner.screenshot({ path: `${OUT}/profile-desktop.png` });

// A profile picture uploaded for the purpose goes in "Profile pictures".
await owner.goto(`${BASE}/_admin/photos/add?for=profile`);
check("profile upload page asks for one photo, no album choice", !(await owner.$("select[name=album]")) && !(await owner.$eval("#add input[type=file]", (i) => i.multiple)));
await (await owner.$("#add input[type=file]")).uploadFile(`${fixtures}/photo1.jpg`);
await Promise.all([owner.waitForNavigation({ timeout: 60_000 }), owner.click("#add button.post")]);
check("back on Posts with the new picture", new URL(owner.url()).pathname === "/posts"
  && (await owner.$eval("section.profile .avatar img", (i) => i.getAttribute("src"))) !== header.avatar);
await owner.goto(`${BASE}/photos`);
check("kept in a Profile pictures album", (await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent))).includes("Profile pictures"));

// Nobody signed out can use the tools.
check("photo tools need the owner", ![200, 201].includes((await fetch(`${BASE}/_admin/photos`, { method: "POST", redirect: "manual",
  headers: { Origin: BASE, "Content-Type": "application/json" }, body: "{}" })).status));

// Delete one photo (album-only), then the album.
await owner.goto(BASE + photoHrefs[2]);
const third = await owner.$eval(".stage img", (i) => i.getAttribute("src").split("/files/")[1]);
await Promise.all([owner.waitForNavigation(), owner.click(".photo-tools button.danger")]);
const stillUsed = siteSql(null, `SELECT COUNT(*) AS n FROM media WHERE hash = '${third}'`)[0].n;
check("deleting a photo removes it, and its file unless another photo uses it", (await tiles()) === 2
  && (await fileStatus(third)) === (stillUsed ? 200 : 404), `${stillUsed} other use(s)`);
await owner.goto(BASE + albumPath);
await Promise.all([owner.waitForNavigation(), owner.click(".album-tools button.danger")]);
await owner.goto(`${BASE}/photos`);
const albumsLeft = await owner.$$eval(".albums a.album strong", (l) => l.map((s) => s.textContent));
check("deleting the album deletes it and its photos", !albumsLeft.includes("Summer 2026")
  && siteSql(null, "SELECT COUNT(*) AS n FROM media WHERE album_id NOT IN (SELECT id FROM albums)")[0].n === 0, albumsLeft.join());

// Phone.
await owner.setViewport({ width: 375, height: 800, isMobile: true });
await owner.goto(`${BASE}/posts`);
check("no sideways scrolling on a phone", await owner.evaluate(() => document.documentElement.scrollWidth <= 375));
await owner.screenshot({ path: `${OUT}/profile-phone.png` });
await owner.setViewport({ width: 1100, height: 900 });
await owner.goto(`${BASE}/_admin/photos/add`);
await owner.screenshot({ path: `${OUT}/add-photos.png` });

// The header's tabs work as an app's (ui/tabs.js): the history is only ever Home, a tab, and what was opened from it.
const pathNow = () => new URL(owner.url()).pathname;
async function arrive(path) {
  for (let i = 0; i < 100; i++) {
    try {
      if (pathNow() === path && await owner.evaluate(() => document.readyState === "complete" && !document.documentElement.hasAttribute("data-onward"))) return true;
    } catch {} // between pages
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const tab = async (href) => { await owner.click(`header.site nav.main a[href="${href}"]`); return arrive(href); };
/** The page's history, from the last Home back there: paths, with the one you're on marked. */
const historyNow = () => owner.evaluate(() => {
  const all = navigation.entries().map((e) => new URL(e.url).pathname);
  const at = navigation.currentEntry.index;
  const home = all.lastIndexOf("/", at);
  return all.slice(home, at + 1).join(" → ");
});
const back = async (path) => { await owner.evaluate(() => history.back()); return arrive(path); };
await owner.goto(`${BASE}/`);
await tab("/groups"); await tab("/activity"); await tab("/photos");
check("tab to tab to tab: the history is just Home → the last tab", await historyNow() === "/ → /photos", await historyNow());
check("…so back is Home", await back("/"));
await tab("/photos");
await Promise.all([owner.waitForNavigation(), owner.click('main a[href="/_admin/photos/add"]')]);
check("a page opened from a tab adds a step", await historyNow() === "/ → /photos → /_admin/photos/add", await historyNow());
check("…another tab from there takes the tab's place (passing through without drawing it)", await tab("/activity")
  && await historyNow() === "/ → /activity", await historyNow());
check("…and back is Home", await back("/") && !(await owner.cookies()).some((c) => c.name === "afterwrd_onward"));
await tab("/photos");
await Promise.all([owner.waitForNavigation(), owner.click('main a[href="/_admin/photos/add"]')]);
check("the tab you're in goes back to it, as it was", await tab("/photos") && await historyNow() === "/ → /photos", await historyNow());
await Promise.all([owner.waitForNavigation(), owner.click('main a[href="/_admin/photos/add"]')]);
await owner.click("header.site a.brand");
check("the logo goes back to Home, not on to a new one", await arrive("/") && await historyNow() === "/"
  && await owner.evaluate(() => navigation.currentEntry.index < navigation.entries().length - 1), await historyNow());

check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
