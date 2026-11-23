// What a hostile friend's site might send, through the real parsing code, bundled by run.sh (with a stand-in
// for Cloudflare's runtime) into $OUT/bundle.mjs. (Friends' signed posts and comments are checked against their
// signatures and lists: lists.mjs, and between real sites in feed.mjs.)
import { pathToFileURL } from "node:url";
const { linkify, callSite, icsFile, loadRelease, parseEvent, parseMedia, readEventForm, serveStatic, signedLink, siteOrigin, findOrCreateDatabase, findWorker, CLIENT_ID, EARLIER_CLIENTS, grantClient } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
const B = "https://bob.example";
const A = "https://ann.example";
const hash = "a".repeat(64);
let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const media = (fetch) => ({ type: "Image", url: `${B}/files/${hash}`, "afterwrd:fetch": fetch, width: 10, height: 10 });

check("a proper signed link is accepted", parseMedia(media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}`), B)?.src.endsWith("x".repeat(43)));
check("a link with styling tacked on is refused", parseMedia(media(`${B}/files/${hash}?exp=1'); position:fixed; inset:0; background:url('https://evil.example/x.png`), B) === null);
check("a link with anything after the signature is refused", parseMedia(media(`${B}/files/${hash}?exp=1800000000&sig=${"x".repeat(43)}&x=')`), B) === null);
check("a link to another site is refused", parseMedia(media(`https://evil.example/files/${hash}?exp=1&sig=${"x".repeat(43)}`), B) === null);
// A file's hash comes from what they sent too, and ends up in style="…" with the link (a thumbnail): only a hash.
const tacked = "x');position:fixed;inset:0";
check("a signed link whose \"hash\" carries styling is refused", signedLink(B, `${B}/files/${tacked}?exp=1&sig=${"x".repeat(43)}`, tacked) === null);
check("…while one with a real hash is taken", signedLink(B, `${B}/files/${hash}?exp=1&sig=${"x".repeat(43)}`, hash) !== null);

// Mentions: only names listed are highlighted, escaped.
check("highlighting escapes names, and only highlights those listed", String(linkify("<b>@Bob & co</b> @Ann", [{ name: "Bob & co" }]))
  === "&lt;b&gt;<strong class=\"mention\">@Bob &amp; co</strong>&lt;/b&gt; @Ann");

check("an address with a trailing dot isn't taken as a site", siteOrigin("https://ann.example./") === null && siteOrigin("https://ann.example/") === A);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("null", { status: 200 });
check("a site answering null counts as saying nothing", JSON.stringify(await callSite(B, "/x")) === "{}");
globalThis.fetch = async () => new Response("[1]", { status: 500 });
check("…and an error answer that isn't an object doesn't crash", await callSite(B, "/x").then(() => false, (e) => /answered 500/.test(e.message)));
globalThis.fetch = realFetch;

// Events, as a group (or a member's site) might send them.
const event = { type: "Event", name: "Quiz", startTime: "2027-06-12T19:00:00Z", "afterwrd:timeZone": "Europe/London" };
check("an event is read", parseEvent(event)?.title === "Quiz");
check("a time zone that isn't one is refused", parseEvent({ ...event, "afterwrd:timeZone": "../../etc/passwd" }) === null
  && parseEvent({ ...event, "afterwrd:timeZone": { toString: () => "Europe/London" } }) === null);
check("an end before the start, or weeks later, is refused", parseEvent({ ...event, endTime: "2027-06-12T18:00:00Z" }) === null
  && parseEvent({ ...event, endTime: "2027-09-12T18:00:00Z" }) === null);
check("an end that isn't a time is refused, not dropped", parseEvent({ ...event, endTime: "soon" }) === null);
check("a date in another age is refused", parseEvent({ ...event, startTime: "1066-10-14T09:00:00Z" }) === null);
check("a long title is cut, and line breaks flattened", parseEvent({ ...event, name: `a\nb${"x".repeat(500)}` })?.title.length === 200
  && !parseEvent({ ...event, name: "a\nb" }).title.includes("\n"));
const sneaky = parseEvent({ ...event, name: "Quiz\r\nATTENDEE:mailto:evil@example.com", location: { name: "Pub;\r\nBEGIN:VALARM" } });
const file = icsFile({ ...sneaky, about: "" }, { uid: "x\r\nX-EVIL:1", url: "https://a.example/", about: "Hi\r\nEND:VEVENT\u2028BEGIN:VEVENT" });
const lines = file.split("\r\n").filter((l) => !l.startsWith(" "));
check("nothing in an event can add lines to a calendar file", !lines.some((l) => /^(ATTENDEE|BEGIN:VALARM|X-EVIL)/.test(l))
  && lines.filter((l) => l === "BEGIN:VEVENT").length === 1 && lines.filter((l) => l === "END:VEVENT").length === 1);
const form = (o) => ({ get: (k) => o[k] ?? null });
check("a form's date that doesn't exist is refused", readEventForm(form({ title: "x", start_date: "2027-02-30" })).error !== undefined);
check("a form's time zone that isn't one falls back", readEventForm(form({ title: "x", start_date: "2027-02-03", zone: "Nowhere/Place" }), "Europe/Paris").event?.time_zone === "Europe/Paris");
// Downloading a release when GitHub has a moment: a stand-in that fails as told, then answers.
const { createServer } = await import("node:http");
const plan = { "/flaky/manifest.json": [504], "/down/manifest.json": [503, 503, 503, 503], "/missing/manifest.json": [404, 404] };
const asked = {};
const github = createServer((req, res) => {
  asked[req.url] = (asked[req.url] ?? 0) + 1;
  const status = plan[req.url]?.shift() ?? 200;
  res.statusCode = status;
  res.end(status === 200 ? JSON.stringify({ assets: [], modules: [] }) : "no");
});
await new Promise((r) => github.listen(0, "127.0.0.1", r));
const at = `http://127.0.0.1:${github.address().port}`;
const outcome = (base) => loadRelease(`${at}/${base}`).then(() => "ok", (e) => e.message);
check("a release still downloads after GitHub answers 504 once", await outcome("flaky") === "ok" && asked["/flaky/manifest.json"] === 2);
check("…but gives up after three tries", await outcome("down") === "Couldn't download the release (503)." && asked["/down/manifest.json"] === 3);
check("…and doesn't try again when it isn't there", await outcome("missing") === "Couldn't download the release (404)." && asked["/missing/manifest.json"] === 1);
github.close();

// Static files are checked against the hashes built into the code before they're sent (src/static.js).
{
  const { createHash } = await import("node:crypto");
  const real = Buffer.from("body { color: green; }");
  const hashes = { "/static/style.css": createHash("sha256").update(real).digest("hex") };
  let stored = real;
  let reads = 0;
  const env = { ASSETS: { fetch: async () => { reads++; return new Response(stored, { headers: { "Content-Type": "text/css" } }); } } };
  const get = (path, headers = {}, method = "GET") => serveStatic(new Request(`https://site.example${path}`, { method, headers }), env, hashes);
  const ok = await get("/static/style.css?v=1");
  const etag = ok.headers.get("ETag");
  check("a static file matching the release is sent, with its hash as ETag", ok.status === 200 && (await ok.text()) === real.toString()
    && etag === `"${hashes["/static/style.css"]}"` && ok.headers.get("Content-Type") === "text/css");
  reads = 0;
  const again = await get("/static/style.css", { "If-None-Match": `W/${etag}` });
  check("…and a browser's checked copy is confirmed without reading the file again", again.status === 304 && reads === 0);
  check("HEAD sends no body", (await (await get("/static/style.css", {}, "HEAD")).text()) === "");
  stored = Buffer.from("body { color: green; } @import url(https://evil.example/x.css);");
  const changed = await get("/static/style.css");
  check("a changed static file is refused", changed.status === 500 && !(await changed.text()).includes("evil"));
  check("…even when the browser offers another ETag", (await get("/static/style.css", { "If-None-Match": '"0000"' })).status === 500);
  check("a file not in the release isn't sent", (await get("/static/extra.js")).status === 404 && (await get("/static/constructor")).status === 404);
}
// A new site's database: a leftover one with things in it is never taken over (src/deploy.js).
{
  const fake = (databases) => {
    const calls = [];
    const call = async (token, path, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      if (path.includes("/d1/database?name=")) return databases.map(({ uuid, name }) => ({ uuid, name }));
      if (path.endsWith("/query")) return databases[0].tables === "odd" ? [{ meta: {} }] : [{ results: [{ n: databases[0].tables }], success: true }];
      if (init.method === "POST") return { uuid: "new", name: "afterwrd" };
      throw new Error(`unexpected ${path}`);
    };
    return { call, calls };
  };
  const none = fake([]);
  check("with no database of that name, a new one is made", (await findOrCreateDatabase("t", "a", "afterwrd", none.call)).uuid === "new");
  const empty = fake([{ uuid: "left", name: "afterwrd", tables: 0 }]);
  check("an empty one, left by an install that stopped partway, is used", (await findOrCreateDatabase("t", "a", "afterwrd", empty.call)).uuid === "left"
    && !empty.calls.some((c) => c === "POST /accounts/a/d1/database"));
  const used = fake([{ uuid: "old", name: "afterwrd", tables: 12 }]);
  const refused = await findOrCreateDatabase("t", "a", "afterwrd", used.call).then(() => null, (e) => e.message);
  const odd = fake([{ uuid: "odd", name: "afterwrd", tables: "odd" }]);
  check("an answer in an unexpected shape counts as having things in it", await findOrCreateDatabase("t", "a", "afterwrd", odd.call).then(() => false, () => true));
  check("one with things in it is refused, and nothing is made or deleted", /already a database called "afterwrd"/.test(refused ?? "")
    && used.calls.every((c) => c.startsWith("GET ") || c.endsWith("/query")));
}

// Updating finds the Worker that serves the site, not just one with the right name: two accounts allowed, each with
// a Worker called afterwrd (every install's is), and only the second is this site's (its workers.dev name is ann).
{
  const realFetch = globalThis.fetch;
  const asked = [];
  const answer = (result, status = 200) => new Response(JSON.stringify({ success: status === 200, errors: [], result }), { status });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace("/client/v4", "");
    asked.push(path);
    if (path === "/accounts") return answer([{ id: "test-account" }, { id: "own-account" }]);
    if (path === "/accounts/test-account/workers/subdomain") return answer({ subdomain: "ann-test" });
    if (path === "/accounts/own-account/workers/subdomain") return answer({ subdomain: "ann" });
    if (/^\/accounts\/(test|own)-account\/workers\/scripts\/afterwrd\/settings$/.test(path)) return answer({ bindings: [] });
    return answer(null, 404);
  };
  try {
    const found = await findWorker("t", "afterwrd.ann.workers.dev");
    check("updating picks the account whose workers.dev name is the site's, not the first with a Worker of that name",
      found.account === "own-account" && !asked.includes("/accounts/test-account/workers/scripts/afterwrd/settings"));
    check("…and refuses if none of the accounts allowed has the site", await findWorker("t", "afterwrd.bob.workers.dev")
      .then(() => false, (e) => e.message.includes("allow the account this site is in")));
  } finally {
    globalThis.fetch = realFetch;
  }
}
// --- which sign-in app a lasting permission is renewed with (cloudflare.js) -------------------------------------------
const first = EARLIER_CLIENTS[0] ?? CLIENT_ID;
check("a permission given through this release's sign-in app is renewed with it", grantClient(CLIENT_ID) === CLIENT_ID);
check("one given through an earlier app is renewed with that app", EARLIER_CLIENTS.every((c) => grantClient(c) === c));
check("one from before the app was noted is renewed with the first app afterwrd had", grantClient(null) === first && grantClient(undefined) === first);
check("an app nobody knows is never used", grantClient("evil-client") === first);
process.exit(failed ? 1 : 0);
