// Checking a site's code and setup from what Cloudflare hands over (src/checks.js checkSite), the heart of friends'
// automatic checks (friendchecks.js, tested end to end in friendchecks.mjs), through the real code bundled by run.sh,
// with a stand-in for Cloudflare's API, GitHub's release downloads and the site itself (checkSite takes the fetch it
// calls them with). Each kind of account below is one way a site can be set up wrong, or tampered with.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const { checkSite, siteIn } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);

let failed = 0;
let total = 0;
const check = (name, ok, extra = "") => { total++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? `  (${extra})` : ""}`); };
const sha = (text) => createHash("sha256").update(text).digest("hex");

const SITE = "https://afterwrd.ann.workers.dev"; // the site checked: its Worker is "afterwrd", its account's name "ann"
const HERE = "https://afterwrd.sam.workers.dev"; // the site checking it
const ENV = {}; // not on this computer: the real addresses, all answered by the stand-in below
const API = "https://api.cloudflare.com/client/v4";
const RELEASES = "https://github.com/afterwrd/afterwrd/releases/download";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const AT = `${API}/accounts/${ACCOUNT}/workers/scripts/afterwrd`;

// --- the stand-in ------------------------------------------------------------------------------------------------
const INDEX = `// package.json\nvar package_default = {\n  name: "afterwrd-worker",\n  version: "9.9.9",\n  private: true\n};\nexport default {};\n`;
const SQL = "CREATE TABLE t (x);";
const MANIFEST = JSON.stringify({ version: "9.9.9", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  modules: [{ name: "index.js", sha256: sha(INDEX) }, { name: "0001_schema.sql", sha256: sha(SQL) }],
  assets: [{ path: "/static/style.css" }, { path: "/static/fonts/nunito.woff2" }, { path: "/static/app/manifest.webmanifest" }] });
const BINDINGS = [{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", id: "db-x" },
  { type: "durable_object_namespace", name: "MEDIA", class_name: "MediaStore", namespace_id: "ns-media" },
  { type: "durable_object_namespace", name: "OUTBOX", class_name: "Outbox", namespace_id: "ns-outbox" },
  { type: "secret_text", name: "SETUP_CODE" }, { type: "secret_text", name: "OUTBOX_KEY" }, { type: "version_metadata", name: "VERSION" }];
const ok = (result) => Response.json({ success: true, result });

/**
 * Cloudflare as it would answer for an account set up the way `how` says (a set of words), with everything else as
 * afterwrd sets it up. Every call is noted in `calls`, with the token it carried.
 */
function standIn(how = new Set(), calls = []) {
  return async (input, init = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("Authorization");
    calls.push({ url, auth, method: init.method ?? "GET" });
    // GitHub's release downloads.
    if (url === `${RELEASES}/v9.9.9/manifest.json`) return how.has("no-release") ? new Response("Not found", { status: 404 }) : new Response(MANIFEST);
    if (url.startsWith(RELEASES)) return new Response("Not found", { status: 404 });
    // The site itself: which upload it is, and its files, which only its code hands out (the sign-in redirect).
    if (url === `${SITE}/_version`) return Response.json({ id: how.has("unversioned") ? null : "v-1" });
    if (url.startsWith(`${SITE}/static/`)) {
      if (how.has("files-direct") && url === `${SITE}/static/style.css`) return new Response("body {}", { status: 200 });
      return new Response(null, { status: 302, headers: { Location: "/_auth/login" } });
    }
    if (!url.startsWith(API)) return new Response("Not found", { status: 404 });
    if (auth !== "Bearer the-token") return Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 });
    const api = url.slice(API.length);
    if (api === "/accounts") {
      return ok([{ id: ACCOUNT, name: "someone@example.com's Account" }, ...(how.has("several") ? [{ id: "f".repeat(32) }] : []), { id: "not-an-account-id" }]);
    }
    if (api === `/accounts/${"f".repeat(32)}/workers/scripts`) return ok([{ id: "afterwrd", created_on: "2026-11-01T00:00:00Z", modified_on: "2026-11-01T00:00:00Z" }]);
    if (api === `/accounts/${ACCOUNT}/workers/scripts`) {
      const list = [{ id: "other", created_on: "2026-11-01T00:00:00Z", modified_on: "2026-11-01T00:00:00Z" }];
      if (how.has("crowded")) for (let i = 0; i < 9; i++) list.push({ id: `extra-${i}` });
      if (!how.has("missing")) list.push({ id: "afterwrd", created_on: "2026-11-07T18:02:00Z", modified_on: "2026-11-07T18:02:30Z" });
      return ok(list);
    }
    if (api === `/accounts/${ACCOUNT}/workers/subdomain`) {
      if (how.has("name-unsaid")) return Response.json({ success: false, errors: [{ message: "No" }] }, { status: 403 });
      return ok({ subdomain: how.has("other-account") ? "someone" : "ann" });
    }
    if (url === `${AT}/subdomain`) return ok({ enabled: !how.has("address-off"), previews_enabled: false });
    if (url === AT) {
      if (how.has("unreadable")) return Response.json({ success: false }, { status: 500 });
      const form = new FormData();
      form.set("index.js", new Blob([how.has("tampered") ? INDEX.replace("export default {};", "export default { evil: true };") : how.has("no-version") ? "export default {};" : INDEX]), "index.js");
      if (!how.has("file-missing")) form.set("0001_schema.sql", new Blob([SQL]), "0001_schema.sql");
      if (how.has("file-extra")) form.set("evil.js", new Blob(["steal()"]), "evil.js");
      return new Response(form);
    }
    if (url === `${AT}/script-settings`) {
      return ok({ logpush: how.has("logpush"), observability: { enabled: false, logs: { destinations: how.has("log-elsewhere") ? ["somewhere"] : [] } },
        tail_consumers: how.has("tail") ? [{ service: "copy-everything" }] : [] });
    }
    if (url === `${AT}/deployments`) {
      const versions = how.has("split") ? [{ version_id: "v-1", percentage: 50 }, { version_id: "v-2", percentage: 50 }]
        : [{ version_id: how.has("elsewhere") ? "v-2" : "v-1", percentage: 100 }];
      return ok({ deployments: [{ id: "d1", versions }] });
    }
    if (url === `${AT}/versions/v-1` || url === `${AT}/versions/v-2`) {
      let bindings = BINDINGS;
      if (how.has("plain-setting")) bindings = [...bindings, { type: "plain_text", name: "OAUTH_TOKEN_URL", text: "https://evil.example/token" }];
      if (how.has("unversioned")) bindings = bindings.filter((b) => b.type !== "version_metadata");
      if (how.has("no-d1")) bindings = bindings.filter((b) => b.type !== "d1");
      if (how.has("no-media")) bindings = bindings.filter((b) => b.name !== "MEDIA");
      // The signed code, its storage wired to another Worker's objects (security review 2026-11 H4).
      if (how.has("wired")) bindings = bindings.map((b) => (b.name === "OUTBOX" ? { ...b, script_name: "copy-everything" } : b));
      const assets = how.has("served-directly") ? { serve_directly: true, raw_run_worker_first: ["/*", "!/static/signed.js"] }
        : { serve_directly: false, raw_run_worker_first: true };
      return ok({ id: "v-1", resources: { bindings, script: { etag: how.has("other-etag") ? sha("something else") : sha("the etag") },
        script_runtime: { compatibility_date: how.has("old-compat") ? "2025-01-01" : "2026-10-01", compatibility_flags: ["nodejs_compat"], assets } } });
    }
    // Another Worker in the account: its own database and objects, unless `how` says it reaches the site's.
    if (api === `/accounts/${ACCOUNT}/workers/scripts/other/deployments`) {
      if (how.has("other-unreadable")) return Response.json({ success: false }, { status: 500 });
      return ok({ deployments: [{ versions: [{ version_id: "v-other", percentage: 100 }] }] });
    }
    if (api === `/accounts/${ACCOUNT}/workers/scripts/other/versions/v-other`) {
      const bindings = [{ type: "d1", name: "DB", id: how.has("backdoor-d1") ? "db-x" : "its-own" },
        { type: "durable_object_namespace", name: "MINE", class_name: "Thing", namespace_id: "ns-its-own" }];
      // By naming the site's Worker, as Cloudflare allows, or as Cloudflare lists it, by the objects' namespace.
      if (how.has("backdoor-named")) bindings.push({ type: "durable_object_namespace", name: "SITE", class_name: "Outbox", script_name: "afterwrd", namespace_id: "ns-outbox" });
      if (how.has("backdoor-namespace")) bindings.push({ type: "durable_object_namespace", name: "SITE", class_name: "MediaStore", namespace_id: "ns-media" });
      return ok({ id: "v-other", resources: { bindings } });
    }
    if (/\/workers\/scripts\/extra-\d\/deployments$/.test(api)) return ok({ deployments: [] });
    return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
  };
}

/** A check of the site, its account set up as `how` says (words, space-separated), with checkSite's `options`. */
async function checked(how = "", options = {}) {
  const calls = [];
  const result = await checkSite("the-token", SITE, ENV, HERE, options, standIn(new Set(how.split(" ").filter(Boolean)), calls));
  return { result, problems: (result.problems ?? []).join(" | "), calls };
}
const has = (r, words) => r.problems.includes(words);

// --- a genuine site ------------------------------------------------------------------------------------------------
const good = await checked();
check("a genuine site is exactly the release, with nothing that needs a look", good.result.code === "matches" && good.result.version === "9.9.9"
  && good.result.problems?.length === 0 && !good.result.problem, JSON.stringify(good.result));
check("…naming its Worker and only the end of the account's id, never the account's name", good.result.script === "afterwrd"
  && good.result.account === ACCOUNT.slice(-6) && !JSON.stringify(good.result).includes(ACCOUNT) && !JSON.stringify(good.result).includes("someone@example.com"));
check("…when it was made and last changed, and which version is live", good.result.created === Date.parse("2026-11-07T18:02:00Z") / 1000
  && good.result.modified === Date.parse("2026-11-07T18:02:30Z") / 1000 && good.result.liveVersion === "v-1");
check("…and nothing kept for reading the account's log of changes (check links, which read it, are gone)", !("audit" in good.result) && !("database" in good.result),
  Object.keys(good.result).join());
check("the token goes only to Cloudflare's API, never to the site or GitHub", good.calls.every((c) => (c.auth !== null) === c.url.startsWith(API)),
  good.calls.filter((c) => c.auth && !c.url.startsWith(API)).map((c) => c.url).join());
check("…and only reads", good.calls.every((c) => c.method === "GET" || c.method === "HEAD"));
check("its files are asked for without signing in, except the ones anyone gets (fonts, the home-screen app's)",
  good.calls.some((c) => c.url === `${SITE}/static/style.css` && c.method === "HEAD")
  && !good.calls.some((c) => c.url.includes("/static/fonts/") || c.url.includes("/static/app/")));
check("…but not when friends' checks look at them in a step of their own", !(await checked("", { files: false })).calls.some((c) => c.url.includes("/static/")));

// --- the wrong Worker, or none ---------------------------------------------------------------------------------------
check("a Worker that isn't in the account allowed is reported", (await checked("missing")).result.problem === "missing");
check("…as is one in several of the accounts allowed", (await checked("several")).result.problem === "several");
check("code Cloudflare won't hand over is reported", (await checked("unreadable")).result.problem === "unreadable");
const off = await checked("address-off");
check("a Worker whose workers.dev address is off isn't the one answering there", has(off, "workers.dev address is switched off"), off.problems);
const elsewhere = await checked("elsewhere");
check("a Worker that isn't the upload answering at the address is reported", has(elsewhere, "isn't the Worker that was checked"), elsewhere.problems);
const unversioned = await checked("unversioned");
check("a site missing its version piece gets one plain explanation, saying how to put it back", has(unversioned, "missing the piece Cloudflare uses")
  && has(unversioned, "Updating the site from its Update page puts it back") && !has(unversioned, "isn't the Worker that was checked")
  && !has(unversioned, "version_metadata"), unversioned.problems);

// --- tied to the account at the site's address -----------------------------------------------------------------------
const other = await checked("other-account", { tie: true });
check("with the tie, a token for an account that isn't the one at the site's address is found out", other.result.tieFailed === true
  && has(other, "isn't the one at the site's address"), other.problems);
const unsaid = await checked("name-unsaid", { tie: true });
check("…as is one whose account won't say its workers.dev name", unsaid.result.tieFailed === true && has(unsaid, "wouldn't say its workers.dev name"), unsaid.problems);
const tied = await checked("", { tie: true });
check("…while the right account passes, its id kept for the next step", !tied.result.tieFailed && tied.result.problems.length === 0 && tied.result.accountId === ACCOUNT);
check("without the tie, the account's name isn't asked", !good.calls.some((c) => c.url.endsWith("/workers/subdomain")));

// --- its code --------------------------------------------------------------------------------------------------------
const tampered = await checked("tampered");
check("tampered code is reported, file by file", tampered.result.code === "different"
  && JSON.stringify(tampered.result.files) === JSON.stringify([{ name: "index.js", why: "different" }]), JSON.stringify(tampered.result.files));
const shuffled = await checked("file-missing file-extra");
check("…as are files added and files missing", shuffled.result.code === "different"
  && shuffled.result.files.some((f) => f.name === "evil.js" && f.why === "extra") && shuffled.result.files.some((f) => f.name === "0001_schema.sql" && f.why === "missing"));
check("code that doesn't say which afterwrd it is can't be compared", (await checked("no-version")).result.code === "unknown");
check("a release that isn't on GitHub is said so", (await checked("no-release")).result.code === "no-release");

// --- the signed list ---------------------------------------------------------------------------------------------------
const list = (entry) => ({ releases: new Map(entry ? [["9.9.9", entry]] : []) });
const signedRight = { manifestSha256: sha(MANIFEST), etag: sha("the etag") };
check("a release in the signed list, serving the signed code, passes", (await checked("", { signed: list(signedRight) })).result.problems.length === 0);
const unsigned = await checked("", { signed: list(null) });
check("a release that isn't in the signed list is reported", unsigned.result.unsigned === true && has(unsigned, "isn't a release signed with afterwrd's own key"), unsigned.problems);
const notAsSigned = await checked("", { signed: list({ ...signedRight, manifestSha256: sha("another manifest") }) });
check("a release on GitHub that isn't the one signed is compared with nothing", has(notAsSigned, "isn't the release that was signed")
  && notAsSigned.result.code === "release-unavailable", notAsSigned.problems);
const serving = await checked("other-etag", { signed: list(signedRight) });
check("code serving visitors that isn't the signed release is found, even when the code handed over is", serving.result.servingMismatch === true
  && serving.result.code === "matches" && has(serving, "isn't afterwrd 9.9.9 as signed"), serving.problems);
const noEtag = await checked("", { signed: list({ manifestSha256: sha(MANIFEST) }) });
check("…and a release signed without a fingerprint can't be confirmed", noEtag.result.servingUnconfirmed === true, noEtag.problems);

// --- how it's set up -----------------------------------------------------------------------------------------------
const tail = await checked("tail logpush log-elsewhere");
check("a Worker whose requests or logs go elsewhere is reported", has(tail, "copied to another Worker") && has(tail, "Logpush")
  && has(tail, "logs are sent to another destination"), tail.problems);
const setting = await checked("plain-setting");
check("a setting afterwrd doesn't use is named, but its value not kept", has(setting, "plain_text OAUTH_TOKEN_URL")
  && !JSON.stringify(setting.result).includes("evil.example"), setting.problems);
const wired = await checked("wired");
check("storage wired to another Worker is reported, though the code is the signed release's", has(wired, "Its storage is wired to another Worker")
  && has(wired, "OUTBOX → copy-everything") && wired.result.code === "matches", wired.problems);
const noMedia = await checked("no-media");
check("a part afterwrd needs that's missing is reported", has(noMedia, "missing parts afterwrd needs: durable_object_namespace MEDIA MediaStore"), noMedia.problems);
check("a site without the D1 database it used before moving into its own object is missing nothing", (await checked("no-d1")).result.problems.length === 0);
check("more than one version serving visitors is reported", has(await checked("split"), "More than one version of it is serving visitors"));
check("compatibility settings that aren't the release's are reported", has(await checked("old-compat"), "compatibility settings aren't the release's"));
const direct = await checked("served-directly");
check("Cloudflare sending files without the code checking them first is reported", has(direct, "sends some of its files without its code checking them first"), direct.problems);
const handed = await checked("files-direct");
check("…as is a file the site hands out without the code's sign-in", has(handed, "without its code checking them first (/static/style.css)"), handed.problems);

// --- other Workers in the account -------------------------------------------------------------------------------------
for (const [how, words] of [["backdoor-d1", "its D1 database"], ["backdoor-named", "its objects, by naming its Worker"], ["backdoor-namespace", "its objects, by their namespace"]]) {
  const reached = await checked(how);
  check(`another Worker connected to ${words} is reported, whatever it's called`,
    has(reached, "Another Worker in the account is connected to its database") && has(reached, ": other."), reached.problems);
}
const unreadOther = await checked("other-unreadable");
check("another Worker that can't be read is said so, not passed", has(unreadOther, "other (couldn't be read)"), unreadOther.problems);
const crowded = await checked("crowded");
check("an account with more Workers than a check looks at says it couldn't make sure", has(crowded, "more Workers than this check looks at (10)"), crowded.problems);

// --- out of date ------------------------------------------------------------------------------------------------------
const old = await checked("", { latest: { version: "10.0.0", securityFix: "10.0.0" } });
check("a site older than a security fix needs updating", has(old, "older than afterwrd 10.0.0, which fixed a security problem"), old.problems);
const behind = await checked("", { latest: { version: "10.0.0" } });
check("…while one only behind the latest says so, without a problem", behind.result.newer === "10.0.0" && behind.result.problems.length === 0);

// --- which site a message names (friends' sites are added by address) ------------------------------------------------
check("an address in a message is found", siteIn("It's at afterwrd.bob-example.workers.dev. Thanks!", ENV, HERE) === "https://afterwrd.bob-example.workers.dev");
check("…but not a preview or a look-alike", siteIn("v2.afterwrd.bob.workers.dev or afterwrd.bob.workers.dev.evil.example", ENV, HERE) === null);
check("…nor a local address, except when testing on this computer", siteIn("http://localhost:8788", ENV, HERE) === null
  && siteIn("http://localhost:8788", { ALLOW_LOCAL_SITES: "1" }, "http://localhost:8787") === "http://localhost:8788");

console.log(failed ? `${failed} of ${total} checks failed` : `All ${total} checks passed`);
process.exit(failed ? 1 : 0);
