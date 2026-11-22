// Groups from afterwrd 1, carried over in place (afterwrd 2, step 10d: docs/signed-conversations.md, "10d in detail").
// Before, on an older release: Ann (8787) starts "Book club" on a group's own Worker (8790), Bob (8788) and Cat (8789)
// join it with its invite link, and Ann lets them in and makes Bob an admin. After, everyone on this code with the same
// databases: Ann brings the group over (one passkey prompt); Bob's and Cat's sites join again at their next visit,
// signed by their browsers with nothing to tap, and Ann's browser lets them back in at hers. Bob comes back a member.
//   node crossover.mjs before|after <A state> <B state> <C state> <G state>
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { setUpSigning, siteCall, siteSql as sql } from "./helpers.mjs";
const OUT = process.env.OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [stage, stateA, stateB, stateC, stateG] = process.argv.slice(2);
const [A, B, C, G] = ["http://localhost:8787", "http://localhost:8788", "http://localhost:8789", "http://localhost:8790"];
const SAVED = `${OUT}/crossover-state.json`;
const CODE = "local-test-setup-code";
const GROUP_KEY = "local-test-group-key";
const AUTHENTICATOR = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  [${stage}] ${name}${extra ? `  (${extra})` : ""}`); };
const errors = [];
const waitFor = async (test, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 400))) if (await test()) return true;
  return false;
};
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

/** A page for one person's site, with its own virtual passkey authenticator (and its passkeys, if given). */
async function pageFor(site, credentials = null) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${site}: ${e.message}`));
  page.on("dialog", (d) => { errors.push(`a browser dialog: ${d.message()}`); d.dismiss(); });
  await page.evaluateOnNewDocument(() => new MutationObserver(() => document.querySelector("dialog.ask[open] .chip.danger")?.click())
    .observe(document, { childList: true, subtree: true }));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
  for (const credential of credentials ?? []) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  return { page, keep: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials };
}
const post = (page, path, body) => page.evaluate(async (p, b) => {
  const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}, path, body);

if (stage === "before") {
  const people = {};
  for (const [site, name] of [[A, "Ann Example"], [B, "Bob Example"], [C, "Cat Example"]]) {
    const p = await pageFor(site);
    await p.page.goto(`${site}/_auth/setup?code=${CODE}`);
    await p.page.type("#name", name);
    await Promise.all([p.page.waitForNavigation(), p.page.click("#go")]);
    await Promise.all([p.page.waitForNavigation(), p.page.click("#go")]);
    people[site] = p;
  }
  const [ann, bob, cat] = [people[A].page, people[B].page, people[C].page];
  // Ann starts the group (locally, her site claims a group Worker that's already running), and makes an invite link.
  const waiting = await post(ann, "/_groups/create/local", { origin: G, setup: GROUP_KEY, name: "Book club", about: "One book a month" });
  const claimed = await post(ann, "/_groups/create/claim", { id: waiting.id });
  check("Ann starts Book club on the old release", claimed.status === 200, JSON.stringify(claimed));
  await ann.goto(`${A}/groups/${claimed.id}/members`);
  await ann.click("#make");
  await ann.waitForSelector("#link:not([hidden])");
  const link = await ann.$eval("#link-url", (i) => i.value);
  // Bob and Cat paste it into Groups on their own sites, and confirm.
  for (const [page, site] of [[bob, B], [cat, C]]) {
    await page.goto(`${site}/groups`);
    await page.type("#join input[name=link]", link);
    await Promise.all([page.waitForNavigation(), page.click("#join button:not([type=button])")]);
    await Promise.all([page.waitForNavigation({ timeout: 30_000 }), page.click("#go")]);
  }
  await ann.goto(`${A}/groups/${claimed.id}/members`);
  await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
  await Promise.all([ann.waitForNavigation(), ann.click('.requests button[formaction$="/approve"]')]);
  const bobMember = sql(stateG, `SELECT id FROM group_members WHERE origin = '${B}'`)[0].id;
  await Promise.all([ann.waitForNavigation(), ann.click(`button[formaction$="/members/${bobMember}/admin"]`)]);
  check("Bob and Cat are in it, and Bob's an admin", sql(stateG, "SELECT COUNT(*) AS n FROM group_members WHERE approved_at IS NOT NULL")[0].n === 3
    && sql(stateG, `SELECT role FROM group_members WHERE id = ${bobMember}`)[0].role === "admin");
  const saved = {};
  for (const site of [A, B, C]) {
    const { page, keep } = people[site];
    saved[site] = { cookie: (await page.cookies()).find((c) => c.name === "__Host-session").value, credentials: await keep(),
      group: sql({ [A]: stateA, [B]: stateB, [C]: stateC }[site], "SELECT id FROM groups")[0].id };
  }
  writeFileSync(SAVED, JSON.stringify(saved));
} else {
  const saved = JSON.parse(readFileSync(SAVED, "utf8"));
  const state = { [A]: stateA, [B]: stateB, [C]: stateC };
  // Each signs in where they left off, and sets up signing first, as the update asks (step 10a).
  const people = {};
  for (const site of [A, B, C]) {
    const p = await pageFor(site, saved[site].credentials);
    await p.page.setCookie({ name: "__Host-session", value: saved[site].cookie, domain: "localhost", path: "/", secure: true, httpOnly: true });
    await p.page.goto(`${site}/`);
    await setUpSigning(p.page);
    people[site] = p.page;
  }
  const [ann, bob, cat] = [people[A], people[B], people[C]];
  const asked = (site) => sql(state[site], "UPDATE groups SET before_asked_at = NULL");
  const groupOf = (site) => sql(state[site], `SELECT * FROM groups WHERE id = ${saved[site].group}`)[0];

  // Before Ann brings it over, nothing happens on Bob's side: the group has no identity yet.
  await bob.goto(`${B}/`);
  check("Bob's site waits while the group hasn't come over", await waitFor(() => groupOf(B).before_asked_at > 0) && groupOf(B).identity === null);
  await ann.goto(`${A}/`);
  const offer = await ann.$eval("p.bring-group", (p) => p.textContent.replace(/\s+/g, " ")).catch(() => "");
  check("Ann's Home says Book club is from before afterwrd 2, and offers to bring it over", offer.includes("Book club") && offer.includes("Bring it over"), offer);

  // Ann brings it over: one passkey prompt signs the group's identity as hers.
  await ann.goto(`${A}/groups/${saved[A].group}`);
  await Promise.all([ann.waitForNavigation({ timeout: 30_000 }), ann.click("#bring")]);
  check("Ann brings it over, with one passkey prompt", Boolean(groupOf(A).identity) && groupOf(A).brought_at > 0
    && sql(stateG, "SELECT COUNT(*) AS n FROM own_identity")[0].n === 1, await ann.$eval("#error", (e) => e.textContent).catch(() => ""));
  check("…at the same address, with the same name", groupOf(A).origin === G && groupOf(A).name === "Book club");
  const before = sql(stateG, "SELECT origin, role FROM group_members_before ORDER BY origin");
  check("its members from before wait to re-join, and aren't members of it meanwhile", before.map((m) => `${m.origin}:${m.role}`).join() === `${B}:admin,${C}:member`
    && sql(stateG, "SELECT COUNT(*) AS n FROM group_members")[0].n === 1, JSON.stringify(before));
  check("someone who wasn't in it can't re-join that way", (await siteCall(stateA, A, `${G}/_group/rejoin/point`, {})).status === 403);

  // Bob's next visit: his browser signs a join, with nothing to tap.
  asked(B);
  await bob.goto(`${B}/`);
  check("Bob's site joins again at his next visit, signed by his browser", await waitFor(() =>
    sql(stateG, `SELECT identity, approved_at FROM group_members WHERE origin = '${B}'`)[0]?.identity === sql(stateB, "SELECT person FROM own_identity")[0].person),
    JSON.stringify(sql(stateG, "SELECT origin, identity, approved_at FROM group_members")));
  check("…and knows the group by its identity now", groupOf(B).identity === groupOf(A).identity && groupOf(B).brought_at > 0);
  check("…waiting to be let back in", sql(stateG, `SELECT approved_at FROM group_members WHERE origin = '${B}'`)[0].approved_at === null);

  // Ann's next visit: her browser lets him back in.
  asked(A);
  await ann.goto(`${A}/`);
  check("Ann's browser lets him back in at her next visit", await waitFor(() =>
    sql(stateG, `SELECT approved_at FROM group_members WHERE origin = '${B}'`)[0]?.approved_at > 0),
    JSON.stringify(sql(stateG, "SELECT origin, approved_at FROM group_members")));
  check("…as a member, not the admin he was", sql(stateG, `SELECT role FROM group_members WHERE origin = '${B}'`)[0].role === "member");

  // Cat, too late (as if her 30 days were up): nothing; then in time.
  sql(stateG, `UPDATE group_members_before SET since = 1 WHERE origin = '${C}'`);
  asked(C);
  await cat.goto(`${C}/`);
  check("too late, Cat's site can't re-join that way", await waitFor(() => groupOf(C).before_asked_at > 0) && groupOf(C).identity === null
    && !sql(stateG, `SELECT 1 FROM group_members WHERE origin = '${C}'`).length);
  sql(stateG, `UPDATE group_members_before SET since = CAST(strftime('%s', 'now') AS INTEGER) WHERE origin = '${C}'`);
  asked(C);
  await cat.goto(`${C}/`);
  check("in time, she does", await waitFor(() => Boolean(sql(stateG, `SELECT identity FROM group_members WHERE origin = '${C}'`)[0]?.identity)));
  asked(A);
  await ann.goto(`${A}/`);
  check("…and Ann's browser lets her back in", await waitFor(() => sql(stateG, `SELECT approved_at FROM group_members WHERE origin = '${C}'`)[0]?.approved_at > 0));

  // A signed group now, for everyone in it.
  await bob.goto(`${B}/groups/${saved[B].group}`);
  check("Bob's page for it is a signed group's, not one from before", !(await bob.$eval("main", (m) => m.textContent)).includes("from before signing")
    && Boolean(await bob.$("#composer")));
  await bob.type("#composer textarea", "Back in Book club");
  await Promise.all([bob.waitForNavigation({ timeout: 60_000 }), bob.click("#composer button.post")]);
  check("…and he can post in it", sql(stateG, `SELECT COUNT(*) AS n FROM items WHERE type = 'post' AND author = '${sql(stateB, "SELECT person FROM own_identity")[0].person}'`)[0].n === 1);
  await ann.goto(`${A}/`);
  check("Ann's Home says no more about it", !(await ann.$("p.bring-group")));
}
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
