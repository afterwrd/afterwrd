// Small things several suites share.

/**
 * Waits for a form sent by a click: in place (ui.js fires "afterwrd-inplace" when it's done) or the old way, with a
 * new page, whichever happens. Resolves with whether it went (a new page counts as having gone). Start it before the
 * click: `await Promise.all([settled(page), page.click(…)])`.
 * @param {import("puppeteer-core").Page} page
 * @param {import("puppeteer-core").WaitForOptions} [options] for the new page, if there is one
 * @returns {Promise<boolean>}
 */
export const settled = (page, options) => Promise.race([
  page.waitForNavigation(options).then(() => true),
  page.evaluate(() => new Promise((resolve) => document.addEventListener("afterwrd-inplace", (e) => resolve(e.detail.sent), { once: true })))
    .catch(() => new Promise(() => {})), // the page went away: the new page is the answer
]);

/**
 * A page that's opened again if Chrome drops it. A long suite on a busy Mac sometimes loses every tab at once, with no
 * crash and nothing navigating (the pages' frames are just gone), and the next goto then fails with "Attempted to use
 * detached Frame". The same browser context keeps the cookies, so a new page there is still signed in: `prepare` sets
 * it up as the first was (listeners, request interception). Everything else is passed straight to the page.
 * @param {import("puppeteer-core").Page} page
 * @param {(page: import("puppeteer-core").Page) => Promise<void>} prepare
 * @returns {import("puppeteer-core").Page}
 */
export function steady(page, prepare) {
  let current = page;
  async function reopen() {
    const next = await current.browserContext().newPage();
    await prepare(next);
    await current.close().catch(() => {});
    current = next;
    console.log("(Chrome dropped a tab: opened it again)");
  }
  return /** @type {any} */ (new Proxy({}, {
    get(_, key) {
      const value = current[key];
      if (typeof value !== "function") return value;
      // Answered there and then, or setting things up: no waiting.
      if (["url", "on", "off", "once", "mainFrame", "browserContext", "isClosed"].includes(String(key))) return value.bind(current);
      return async (...args) => {
        if (current.mainFrame().detached) await reopen();
        return current[key](...args);
      };
    },
  }));
}

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { signCall } from "../../src/signedcalls.js";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The SQLite file behind a local test site's D1 database (the one that isn't Miniflare's metadata), or null. With
 * AFTERWRD_SELFHOST set (the only site's data folder), the sites are self-hosted ones (selfhost/), whose database is
 * in <data folder>/database.
 */
function databaseFile(state) {
  const selfhost = process.env.AFTERWRD_SELFHOST;
  // In the site's object (src/sqlite.js), or, for a site from before that (the upgrade test), D1 or the Database object.
  const inObject = objectFile(selfhost ? join(state ?? selfhost, "outbox") : join(state ?? join(WORKER, ".wrangler", "state"), "v3", "do"));
  if (inObject) return inObject;
  const dir = selfhost ? join(state ?? selfhost, "database")
    : join(state ?? join(WORKER, ".wrangler", "state"), "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  return name ? join(dir, name) : null;
}

/**
 * The SQLite file of the site's object (src/sqlite.js): the Outbox object that has the site's tables (the others hold
 * the outbox and the vault), or null if it hasn't made them yet. Exported for scripts/owner.mjs.
 * @param {string} dir a local site's v3/do folder (its objects are in *-Outbox), or a self-hosted site's outbox folder
 */
export function objectFile(dir) {
  if (!existsSync(dir)) return null;
  const folders = [".", ...readdirSync(dir).filter((f) => f.endsWith("-Outbox"))];
  for (const folder of folders) {
    for (const name of readdirSync(join(dir, folder)).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")) {
      const db = new DatabaseSync(join(dir, folder, name), { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 5000"); // a site writing just then: wait for it, as siteSql does
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get()) return join(dir, folder, name);
      } finally {
        db.close();
      }
    }
  }
  return null;
}

/**
 * Rows from a local test site's database: `state`, its --persist-to folder (each site in a multi-site suite has one),
 * or null for a suite's only site. Read straight from its SQLite file, alongside the running site (as wrangler d1
 * execute does, but without starting a Workers runtime for every query: dozens of those at once, polling, took the
 * Mac short of memory, and Chrome threw the tests' tabs away). Several statements at once run, returning nothing.
 * Only before a site has made its database is wrangler asked, as it used to be for every query.
 * @param {string | null} state
 * @param {string} query
 * @returns {any[]}
 */
export function siteSql(state, query) {
  const file = databaseFile(state);
  if (!file) return wranglerSql(state, query);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (/;\s*\S/.test(query.trim().replace(/;\s*$/, ""))) {
      db.exec(query);
      return [];
    }
    return db.prepare(query).all().map((row) => ({ ...row })); // a change runs, and returns no rows
  } finally {
    db.close();
  }
}

function wranglerSql(state, query) {
  const args = ["d1", "execute", "afterwrd", "--local", ...(state ? ["--persist-to", state] : []), "--json", "--command", query];
  const run = () => JSON.parse(execFileSync("./node_modules/.bin/wrangler", args, { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
  try {
    return run();
  } catch {
    execFileSync("sleep", ["1"]);
    return run();
  }
}

/** Rows from a suite's only test site. */
export const sql = (query) => siteSql(null, query);

/** How many rows `from` (a table, and perhaps WHERE …) has on the site at `state`. */
export const count = (state, from) => siteSql(state, `SELECT COUNT(*) AS n FROM ${from}`)[0].n;

/**
 * afterwrd 2: after a site's first passkey comes the recovery code (src/keys.js, views/pages.js keysPage): ticked as
 * kept, then one passkey prompt signs the owner's identity and this browser's key. `waitFor` is what that leads to.
 */
export async function setUpSigning(page, waitFor = () => page.waitForNavigation({ timeout: 30_000 })) {
  await page.waitForFunction(() => /^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/.test(document.getElementById("code")?.textContent ?? ""), { timeout: 15_000 });
  const code = await page.$eval("#code", (c) => c.textContent);
  await page.click("#kept");
  await Promise.all([waitFor(), page.click("#go")]);
  return code;
}

/** What this browser keeps of its key (public/static/browserkey.js), as the page sees it; null if none. */
export const browserKeyOf = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open("afterwrd-keys", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("keys");
  open.onerror = () => resolve(null);
  open.onsuccess = () => {
    const get = open.result.transaction("keys").objectStore("keys").get("browser");
    get.onerror = () => resolve(null);
    get.onsuccess = () => { const k = get.result; open.result.close();
      resolve(k ? { extractable: k.privateKey.extractable, publicKey: k.publicKey, person: k.person, expires: k.expires } : null); };
  };
}));

/**
 * A call from the site whose database is at `state` (its address `from`) to `url`, signed with that site's hosting
 * key, as its own code would make it (src/calls.js callFriend): what friends' sites say to each other. `body` (an
 * object) makes it a POST. `headers` adds or replaces any. Returns the Response.
 */
export async function siteCall(state, from, url, body = null, { headers = {}, at } = {}) {
  const person = siteSql(state, "SELECT person FROM own_identity")[0].person;
  const privateKey = await crypto.subtle.importKey("pkcs8",
    Buffer.from(siteSql(state, "SELECT value FROM settings WHERE key = 'hosting_key'")[0].value, "base64url"), { name: "Ed25519" }, false, ["sign"]);
  const text = body === null ? null : JSON.stringify(body);
  const signed = await signCall({ method: text === null ? "GET" : "POST", url, body: text, person, from, privateKey, ...(at && { at }) });
  return fetch(url, { method: text === null ? "GET" : "POST", redirect: "manual",
    headers: { ...signed, ...(text !== null && { "Content-Type": "application/json" }), ...headers }, body: text });
}

/**
 * A signed group (docs/signed-conversations.md, step 6), started from `page`'s site (`site`) on a group's site already
 * running at `origin` (as /_groups/create/local does on a self-hosted server, or here), claimed, and its identity signed
 * by the owner's passkey, as the page does after claiming. Returns its id on the owner's site.
 * @param {import("puppeteer-core").Page} page
 */
export async function startSignedGroup(page, { origin, setup, name, about = "" }) {
  return page.evaluate(async (o) => {
    const send = async (path, body) => {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${path}: ${data.error ?? r.status}`);
      return data;
    };
    const waiting = await send("/_groups/create/local", { origin: o.origin, setup: o.setup, name: o.name, about: o.about });
    const id = (await send("/_groups/create/claim", { id: waiting.id })).id;
    const [S, { passkeySigns }] = await Promise.all([import("/static/signed.js"), import("/static/passkey.js")]);
    const start = await send(`/_groups/${id}/identity/start`, {});
    const response = await passkeySigns(start.nonce, [await S.fingerprintOf("identity", S.fromB64url(start.doc))], start.allow);
    await send(`/_groups/${id}/identity/finish`, { doc: start.doc, response });
    return id;
  }, { origin, setup, name, about });
}

/**
 * Lets `member` (their page, on their site `memberSite`) into the owner's group `id`, the way people do: the owner
 * makes an invite link, the member pastes it into Groups on their own site and asks (their browser signs a `join`), and
 * the owner lets them in (signed). Returns the group's id on the member's site.
 */
export async function letInto(owner, ownerSite, id, member, memberSite, state) {
  await owner.goto(`${ownerSite}/groups/${id}/members`);
  await owner.click("#make");
  await owner.waitForSelector("#link:not([hidden])");
  const link = await owner.$eval("#link-url", (i) => i.value);
  await member.goto(`${memberSite}/groups`);
  await member.type("#join input[name=link]", link);
  await Promise.all([member.waitForNavigation(), member.click("#join button:not([type=button])")]);
  await Promise.all([member.waitForNavigation({ timeout: 30_000 }), member.click("#go")]);
  await owner.goto(`${ownerSite}/groups/${id}/members`);
  await Promise.all([owner.waitForNavigation(), owner.click('.requests button[data-group-record="approve"]')]);
  return siteSql(state, `SELECT id FROM groups WHERE origin = (SELECT origin FROM groups ORDER BY id DESC LIMIT 1) ORDER BY id DESC LIMIT 1`)[0].id;
}

/**
 * A new post in a signed group, signed in `page`'s browser with `content` ({type: "post", text, …}) and sent through
 * its own site, as the composer would: {status, ...its answer}.
 */
export const signedGroupPost = (page, groupId, host, content) => page.evaluate(async (g, h, c) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const made = await makeRecord({ kind: "item", author: key.person, host: h }, { photos: [], ...c }, key);
  const res = await fetch(`/_groups/${g}/items`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sent: made.sent, photos: [], files: [] }) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, groupId, host, content);

/**
 * A record on a signed group's post, signed in `page`'s browser and passed on by its site, as a form would be: the
 * status (0 for the redirect when the group took it, 400 when it didn't).
 */
export const signedGroupRecord = (page, groupId, fields, content = null) => page.evaluate(async (g, f, c) => {
  const [{ makeRecord }, { savedKey }] = await Promise.all([import("/static/records.js"), import("/static/browserkey.js")]);
  const key = await savedKey();
  const made = await makeRecord({ author: key.person, ...f }, c ?? undefined, key);
  const body = new FormData();
  body.set("sent", JSON.stringify(made.sent));
  body.set("back", "/");
  return (await fetch(`/_groups/${g}/items/${f.item}/records`, { method: "POST", body, redirect: "manual" })).status;
}, groupId, fields, content);
