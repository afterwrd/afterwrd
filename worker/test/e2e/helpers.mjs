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
