// Groups from afterwrd 1, carried over in place (afterwrd 2, step 10d: docs/signed-conversations.md, "10d in detail").
// Before, on an older release: Ann (8787) starts "Book club" on a group's own Worker (8790), Bob (8788) and Cat (8789)
// join it with its invite link, and Ann lets them in and makes Bob an admin. After, everyone on this code with the same
// databases: Ann brings the group over (one passkey prompt); Bob's and Cat's sites join again at their next visit,
// signed by their browsers with nothing to tap, and Ann's browser lets them back in at hers. Bob comes back a member.
// Its history (step 10e): before, Ann posts a photo and a poll she closes by hand, Bob a weekly event with one date
// called off and a second post, Cat a post, with comments both ways. After, each writer's browser signs their own from
// their own copy: posts come back dated as written, then the comments on them, in order. Bob's second post, changed on
// the group's site, stays behind; Cat's copy is gone, so nothing of hers comes, and once the group's 30 days are up
// Ann's photo opens with the comments that came. Then (step 10f) the group's site clears out what's left from before:
// Cat's post and its photo's file, and the members it had; not Ann's photo, nor where old posts went.
//   node crossover.mjs before|after <A state> <B state> <C state> <G state>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const PHOTO = fileURLToPath(new URL("./fixtures/photos/photo1.jpg", import.meta.url));
const CAT_PHOTO = fileURLToPath(new URL("./fixtures/photos/big.jpg", import.meta.url));
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
/** A form sent from `page` (it lands back on a page: only whether it went through matters). */
const form = (page, path, fields) => page.evaluate(async (p, f) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(f)) data.append(k, v);
  return (await fetch(p, { method: "POST", body: data })).status;
}, path, fields);
/** Whether a site's media store (its objects' SQLite files) has a file. */
const hasFile = (state, hash) => {
  const dir = join(state, "v3", "do");
  return existsSync(dir) && readdirSync(dir).filter((f) => f.endsWith("-MediaStore")).some((folder) =>
    readdirSync(join(dir, folder)).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").some((name) => {
      const db = new DatabaseSync(join(dir, folder, name), { readOnly: true });
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'files'").get() && db.prepare("SELECT 1 FROM files WHERE hash = ?").get(hash));
      } finally { db.close(); }
    }));
};
const day = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

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
  // Its history (step 10e), each by its writer from their own site.
  const groupHere = { [A]: claimed.id, [B]: sql(stateB, "SELECT id FROM groups")[0].id, [C]: sql(stateC, "SELECT id FROM groups")[0].id };
  const lastPost = () => sql(stateG, "SELECT id FROM group_posts ORDER BY id DESC LIMIT 1")[0].id;
  await ann.goto(`${A}/groups/${claimed.id}`);
  await ann.type("#composer textarea", "Our first book");
  await (await ann.$("#composer input[type=file]")).uploadFile(PHOTO);
  await Promise.all([ann.waitForNavigation({ timeout: 60_000 }), ann.click("#composer button.post")]);
  const photoPost = lastPost();
  await post(ann, `/_groups/${claimed.id}/posts`, { text: "Which book next?", poll: { options: ["Emma", "Persuasion"], multiple: false } });
  const pollPost = lastPost();
  await form(ann, `/_groups/${claimed.id}/polls/${pollPost}/close`, { back: `/groups/${claimed.id}` });
  const [d0, d1, d3] = [day(7), day(14), day(28)];
  await form(bob, `/_groups/${groupHere[B]}/events`, { text: "Bring the book", title: "Book club meets", start_date: d0, start_time: "19:00",
    zone: "Europe/London", repeat: "weekly", repeat_until: d3 });
  const eventPost = lastPost();
  await form(bob, `/_groups/${groupHere[B]}/events/${eventPost}/cancel`, { date: d1, back: `/groups/${groupHere[B]}` });
  await post(bob, `/_groups/${groupHere[B]}/posts`, { text: "A second thought" });
  const bobSecond = lastPost();
  await cat.goto(`${C}/groups/${groupHere[C]}`);
  await cat.type("#composer textarea", "My pick");
  await (await cat.$("#composer input[type=file]")).uploadFile(CAT_PHOTO);
  await Promise.all([cat.waitForNavigation({ timeout: 60_000 }), cat.click("#composer button.post")]);
  const catPost = lastPost();
  for (const [page, site, n, text] of [[ann, A, photoPost, "Lovely cover"], [bob, B, photoPost, "Agreed"], [cat, C, photoPost, "Me too"],
    [ann, A, eventPost, "See you there"], [bob, B, catPost, "Good choice"]]) {
    await form(page, `/_groups/${groupHere[site]}/comments`, { post: String(n), text, back: `/groups/${groupHere[site]}` });
  }
  const history = { photoPost, pollPost, eventPost, bobSecond, catPost, d1, catHash: sql(stateG, `SELECT hash FROM group_photos WHERE post_id = ${catPost}`)[0]?.hash ?? null, posts: sql(stateG, "SELECT id, created_at FROM group_posts"),
    closedAt: sql(stateG, `SELECT closed_at FROM group_polls WHERE post_id = ${pollPost}`)[0]?.closed_at ?? null };
  check("…with posts, photos, a poll closed by hand, an event with a date called off, and comments both ways",
    history.posts.length === 5 && sql(stateG, "SELECT COUNT(*) AS n FROM group_comments")[0].n === 5 && sql(stateG, "SELECT COUNT(*) AS n FROM group_photos")[0].n === 2
    && history.closedAt > 0 && sql(stateG, `SELECT date FROM group_event_skips WHERE post_id = ${eventPost}`)[0]?.date === d1
    && sql(stateA, "SELECT COUNT(*) AS n FROM group_mine")[0].n === 4 && sql(stateB, "SELECT COUNT(*) AS n FROM group_mine")[0].n === 4,
  JSON.stringify({ posts: history.posts.length, mineA: sql(stateA, "SELECT kind, remote_id FROM group_mine"), mineB: sql(stateB, "SELECT kind, remote_id FROM group_mine") }));
  const saved = { history };
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
  const h = saved.history;
  // Bob's second post changed on the group's site since: his copy doesn't say that. Cat's copy of what she wrote there
  // is gone: she never brings any of it over (step 10e, below).
  sql(stateG, `UPDATE group_posts SET text = 'Words Bob never wrote' WHERE id = ${h.bobSecond}`);
  sql(stateC, "DELETE FROM group_mine");
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
  check("…and his site can't ask to come back again meanwhile", (await siteCall(stateB, B, `${G}/_group/rejoin`, {})).status === 409);

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
  check("…and he can post in it", sql(stateG, `SELECT COUNT(*) AS n FROM items WHERE type = 'post' AND json_extract(content, '$.text') = 'Back in Book club'
    AND author = '${sql(stateB, "SELECT person FROM own_identity")[0].person}'`)[0].n === 1);
  await ann.goto(`${A}/`);
  check("Ann's Home says no more about it", !(await ann.$("p.bring-group")));

  // --- its history (step 10e) ---
  const ask = (site) => sql(state[site], "UPDATE group_mine SET asked_at = NULL");
  const broughtAs = (n) => sql(stateG, `SELECT item FROM brought WHERE old = 'gpost-${n}'`)[0]?.item ?? null;
  const itemRow = (id) => sql(stateG, `SELECT * FROM items WHERE id = '${id}'`)[0];
  const writtenThen = (n) => h.posts.find((p) => p.id === n).created_at;
  ask(B);
  await bob.goto(`${B}/`);
  check("Bob's event comes over at his next visit, signed by his browser", await waitFor(() => Boolean(broughtAs(h.eventPost))),
    JSON.stringify(sql(stateB, "SELECT kind, remote_id, offer IS NOT NULL AS offered, item FROM group_mine")));
  const event = itemRow(broughtAs(h.eventPost));
  const eventContent = JSON.parse(event.content);
  check("…dated as first written, repeating, with the date he called off still off", event.created_at === writtenThen(h.eventPost) && eventContent.type === "event"
    && Boolean(eventContent.event?.rrule) && Boolean(JSON.parse(event.tally ?? "{}").dates?.[h.d1]?.off), JSON.stringify({ created: event.created_at, tally: event.tally }));
  check("…but not the post the group changed since: his copy doesn't say that", await waitFor(() =>
    !sql(stateB, `SELECT 1 FROM group_mine WHERE kind = 'post' AND remote_id = ${h.bobSecond}`).length) && !broughtAs(h.bobSecond));
  check("…and his comment on Ann's photo waits for her photo to come", sql(stateB, `SELECT item FROM group_mine WHERE kind = 'comment'`).every((r) => r.item === null));

  ask(A);
  await ann.goto(`${A}/`);
  check("Ann's photo and poll come over at her next visit", await waitFor(() => Boolean(broughtAs(h.photoPost) && broughtAs(h.pollPost))));
  check("…then her comments, on her own photo and on Bob's event", await waitFor(() => !sql(stateA, "SELECT 1 FROM group_mine").length),
    JSON.stringify(sql(stateA, "SELECT kind, remote_id, offer IS NOT NULL AS offered, item FROM group_mine")));
  const photoItem = broughtAs(h.photoPost);
  const photoContent = JSON.parse(itemRow(photoItem).content);
  check("…her photo an item of its own, its file kept", photoContent.photos?.length === 1 && Boolean(photoContent.photos[0].item)
    && sql(stateG, `SELECT 1 FROM media WHERE item_id = '${photoContent.photos[0].item}'`).length === 1 && !sql(stateG, `SELECT 1 FROM group_photos WHERE post_id = ${h.photoPost}`).length);
  const poll = JSON.parse(itemRow(broughtAs(h.pollPost)).content).poll;
  check("…her poll closed when she closed it, with nothing waiting on it", poll?.closes_at === Math.max(h.closedAt, writtenThen(h.pollPost) + 1) && itemRow(broughtAs(h.pollPost)).before_until === null,
    JSON.stringify(poll));
  check("Bob's event takes comments again with Ann's in it, the only one made there", await waitFor(() => itemRow(broughtAs(h.eventPost)).before_until === null)
    && sql(stateG, `SELECT n FROM lists WHERE id = '${broughtAs(h.eventPost)}'`)[0].n === 2);

  // First the group's site says Bob's comment is on his event now, not Ann's photo: the event's own signed record names
  // another post from before, so his site signs nothing, and keeps its copy to ask again.
  const bobsOld = sql(stateG, `SELECT id FROM before_comments WHERE item = '${photoItem}' AND origin = '${B}'`)[0].id;
  sql(stateG, `UPDATE before_comments SET item = '${broughtAs(h.eventPost)}' WHERE id = ${bobsOld}`);
  ask(B);
  await bob.goto(`${B}/`);
  await new Promise((r) => setTimeout(r, 3000));
  check("a group saying an old comment is on another post now gets nothing signed there", sql(stateG, `SELECT state FROM before_comments WHERE id = ${bobsOld}`)[0]?.state === "waiting"
    && sql(stateB, "SELECT COUNT(*) AS n FROM group_mine WHERE kind = 'comment' AND item IS NOT NULL")[0].n === 0);
  sql(stateG, `UPDATE before_comments SET item = '${photoItem}' WHERE id = ${bobsOld}`);
  ask(B);
  await bob.goto(`${B}/`);
  check("Bob's comment on Ann's photo comes over at his next visit", await waitFor(() =>
    sql(stateG, `SELECT state FROM before_comments WHERE item = '${photoItem}' AND origin = '${B}'`)[0]?.state === "signed"));
  check("…while her photo still waits for Cat's, which never comes", sql(stateG, `SELECT state FROM before_comments WHERE item = '${photoItem}' AND origin = '${C}'`)[0]?.state === "waiting"
    && itemRow(photoItem).before_until > 0);
  await bob.goto(`${B}/groups/${saved[B].group}/posts/${photoItem}`);
  check("Bob's page for it says so, with no comment box", Boolean(await bob.$("p.frozen")) && !(await bob.$("form.say")));
  await bob.goto(`${B}/groups/${saved[B].group}`);
  check("the group's page says posts from before are coming back", Boolean(await bob.$("p.bringing")));
  check("…and Bob's copies are dated as first written", sql(stateB, `SELECT created_at FROM copies WHERE id = '${photoItem}'`)[0]?.created_at === writtenThen(h.photoPost));
  await bob.goto(`${B}/groups/${saved[B].group}/posts/${h.pollPost}`);
  check("an old link to Ann's poll leads to it", bob.url().endsWith(`/posts/${broughtAs(h.pollPost)}`), bob.url());
  check("Bob's site can't bring over a post of Cat's", (await siteCall(stateB, B, `${G}/_group/before`, { post: h.catPost, sent: {}, photos: [], calloffs: [] })).status === 404);

  // The group's 30 days are up (as if): Ann's photo goes into its list with the comments that came, in written order.
  sql(stateG, "UPDATE settings SET value = '1' WHERE key = 'group_brought_at'");
  sql(stateG, "UPDATE items SET before_until = 1 WHERE before_until IS NOT NULL");
  await bob.goto(`${B}/groups/${saved[B].group}`);
  check("once the group's 30 days are up, Ann's photo takes comments again", await waitFor(() => itemRow(photoItem).before_until === null));
  await bob.goto(`${B}/groups/${saved[B].group}/posts/${photoItem}`);
  const thread = await bob.$eval("main", (m) => m.textContent);
  check("…with Ann's comment, then Bob's, as written; Cat's left behind", thread.includes("Lovely cover") && thread.includes("Agreed")
    && thread.indexOf("Lovely cover") < thread.indexOf("Agreed") && !thread.includes("Me too") && Boolean(await bob.$("form.say")));
  check("…and its old comments are gone from the group's site", !sql(stateG, `SELECT 1 FROM group_comments WHERE post_id = ${h.photoPost}`).length
    && !sql(stateG, `SELECT 1 FROM before_comments WHERE item = '${photoItem}'`).length);
  ask(B);
  await bob.goto(`${B}/`);
  check("Bob's comment on Cat's post, which never came, is left behind too", await waitFor(() => !sql(stateB, "SELECT 1 FROM group_mine").length),
    JSON.stringify(sql(stateB, "SELECT kind, remote_id, item FROM group_mine")));
  // Bob's changed post: his site said it isn't his (his copy doesn't have it as it is there), so it's gone from there.
  check("Bob's changed post is gone from the group's old rows", !sql(stateG, `SELECT 1 FROM group_posts WHERE id = ${h.bobSecond}`).length);

  // Cat leaves: she can't come back as a member from before, only with an invite link like anyone.
  await cat.goto(`${C}/groups/${saved[C].group}/members`);
  await Promise.all([cat.waitForNavigation(), cat.click('button[data-group-record="leave"]')]);
  check("Cat leaves", !sql(stateG, `SELECT 1 FROM group_members WHERE origin = '${C}'`).length);
  check("…and can't come back as a member from before", !sql(stateG, `SELECT 1 FROM group_members_before WHERE origin = '${C}'`).length
    && (await siteCall(stateC, C, `${G}/_group/rejoin/point`, {})).status === 403);

  // --- the clear-out (step 10f): the group's 30 days are up, so at a member's next pull what's left from before goes ---
  const annPhoto = photoContent.photos[0];
  await bob.goto(`${B}/groups/${saved[B].group}`);
  check("the group's site clears out what's left from before", await waitFor(() => Boolean(sql(stateG, "SELECT value FROM settings WHERE key = 'before_cleared_at'")[0])));
  const left = sql(stateG, `SELECT (SELECT COUNT(*) FROM group_posts) + (SELECT COUNT(*) FROM group_comments) + (SELECT COUNT(*) FROM group_photos)
    + (SELECT COUNT(*) FROM group_polls) + (SELECT COUNT(*) FROM group_events) + (SELECT COUNT(*) FROM group_event_skips)
    + (SELECT COUNT(*) FROM group_members_before) + (SELECT COUNT(*) FROM before_comments) AS n`)[0].n;
  check("…Cat's post never brought over, its comment, and the members it had", left === 0);
  check("…and her photo's file, which no signed post uses", Boolean(h.catHash) && !hasFile(stateG, h.catHash), h.catHash);
  check("…but not Ann's photo, brought over", hasFile(stateG, annPhoto.hash) && sql(stateG, `SELECT 1 FROM media WHERE item_id = '${annPhoto.item}'`).length === 1);
  await bob.goto(`${B}/groups/${saved[B].group}/posts/${h.pollPost}`);
  check("…nor where old posts went: an old link still leads to its post", bob.url().endsWith(`/posts/${broughtAs(h.pollPost)}`), bob.url());
}
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
