// Checking a friend's site: the code and setup it runs, read from Cloudflare with a token the friend's site handed over
// (friendchecks.js, friends' automatic checks). A site can't vouch for itself, since tampered code could answer from a
// copy of the real code, so the evidence comes from Cloudflare, and the check runs on the checker's site.
//
// What's checked, all read-only:
//   - the Worker named like the site, in the account allowed, with its workers.dev address switched on;
//   - its code, file by file, against the release it says it is (and whether that release is out of date);
//   - what it's connected to: exactly afterwrd's bindings (database, photo store, outbox, site files, its secrets),
//     no settings (plain text variables), no tail Workers or Logpush sending its requests elsewhere, the release's
//     compatibility settings, and one version serving all of its traffic;
//   - that it doesn't hand out its site files without its code checking them (each private file, asked for without signing
//     in, must get the sign-in redirect the code gives, not the file from Cloudflare directly).
// The code carries the hash of every static file (src/static.js), so with the above it covers the whole site. Nothing
// else in the friend's account is read: not its log of changes, which says more about them than a check needs.
// (Check links, a friend's check by hand that read that log too, were removed in 2.4: being sent a link to Cloudflare's
// Allow page was something to be wary of, never something to do; security review 2026-11 M10.)
//
// The owner's side, signed in:
//   POST /_admin/checks/myself?back=       the owner checked their own site (afterwrd.app/check/): a form on Update
// A friend's site saying its check passed (POST /_p/checked) is kept, so Update shows who checked this site last.
import pkg from "../package.json";
import { testingHere } from "./cloudflare.js";
import { API } from "./deploy.js";
import { siteOrigin } from "./sites.js";
import { newer } from "./update.js";
import { failureAway, laterChecks, letOff, lookAfterLater, putAway, setCheckingFriends } from "./friendchecks.js";
import { isPublicStatic } from "./static.js";
import { now } from "./util.js";

const REPO = pkg.afterwrd.releases;
const WORKERS_DEV = /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;
const VERSION_RE = /name: "afterwrd-worker",\s*version: "(\d+\.\d+\.\d+)"/;
const OTHER_WORKERS = 8; // other Workers looked at (two calls each, within the free plan's 50 a request)
// The bindings afterwrd gives a personal site (src/deploy.js deployVersion), and the secrets it may have.
const BINDINGS = ["assets ASSETS", "d1 DB", "durable_object_namespace MEDIA MediaStore", "durable_object_namespace OUTBOX Outbox", "version_metadata VERSION"];
// The D1 database the site used before it moved into its own object (0.57.0: sitecopy.js). Allowed, but no longer
// needed: a site without it isn't missing anything, so a later release can stop connecting it.
const NO_LONGER_NEEDED = new Set(["d1 DB"]);
const SECRETS = new Set(["SETUP_CODE", "UPDATE_TOKEN", "OUTBOX_KEY"]); // OUTBOX_KEY: the key calls to its objects carry (sqlite.js)

// --- the owner's side -------------------------------------------------------------------------------------------

export async function handleCheckAdmin(request, env, url) {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  // The owner checked their own site (afterwrd.app/check/): a form on Update. Their word for it.
  if (url.pathname === "/_admin/checks/myself") {
    await checkedMyself(env);
    const back = url.searchParams.get("back") === "update" ? "/_admin/update#check" : "/";
    return Response.redirect(`${url.origin}${back}`, 303);
  }
  // Friends' automatic checks (friendchecks.js): letting friends' sites check this one, this one checking theirs.
  if (url.pathname === "/_admin/checks/let-later") {
    await laterChecks(env.DB);
    return Response.redirect(`${url.origin}/`, 303);
  }
  const away = /^\/_admin\/checks\/failure\/(\d+)\/away$/.exec(url.pathname);
  if (away) { // "Put it away" on Home's note of a friend's check of an older afterwrd
    await failureAway(env.DB, Number(away[1]));
    return Response.redirect(`${url.origin}/`, 303);
  }
  if (url.pathname === "/_admin/checks/remind-later") { // "Not now" on Home's one reminder to let the site look after itself
    await lookAfterLater(env.DB);
    return Response.redirect(`${url.origin}/`, 303);
  }
  if (url.pathname === "/_admin/checks/let-off") {
    await letOff(env);
    return Response.redirect(`${url.origin}/_admin/update#check`, 303);
  }
  if (url.pathname === "/_admin/checks/checking-off" || url.pathname === "/_admin/checks/checking-on") {
    await setCheckingFriends(env.DB, url.pathname.endsWith("-on"));
    return Response.redirect(`${url.origin}/_admin/update#checking`, 303);
  }
  const seen = /^\/_admin\/checks\/found\/(\d+)\/seen$/.exec(url.pathname);
  if (seen) {
    await putAway(env.DB, Number(seen[1]));
    return Response.redirect(`${url.origin}/${url.searchParams.get("back") === "update" ? "_admin/update#checking" : ""}`, 303);
  }
  return new Response("Not found", { status: 404 });
}

// --- the owner's actions ---------------------------------------------------------------------------------------

/** The owner says they've checked their own site themselves (afterwrd.app/check/). */
export async function checkedMyself(env) {
  await keepChecked(env.DB, null, null, null);
}

/**
 * The afterwrd site an address, link or whole message names: the first something.their-name.workers.dev in it (or,
 * when testing on this computer, an http://localhost address). Null if there isn't one.
 */
export function siteIn(text, env, here) {
  const words = String(text ?? "").trim().slice(0, 2000);
  const found = /(?<![\w.-])([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)(?![\w-]|\.[\w-])/i.exec(words)?.[1];
  if (found && WORKERS_DEV.test(found.toLowerCase())) return `https://${found.toLowerCase()}`;
  if (testingHere(env, here)) {
    const local = siteOrigin(words, env);
    if (local?.startsWith("http://")) return local;
  }
  return null;
}

// --- the check ---------------------------------------------------------------------------------------------------

const text = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : "");
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const apiBase = (env, here) => (testingHere(env, here) && env.CLOUDFLARE_API_URL) || API;

/** Reading Cloudflare's API with a token someone allowed: {call, getJSON}. */
export const cloudflareReader = (token, env, here, fetcher = fetch) => client(token, env, here, fetcher);

function client(token, env, here, fetcher) {
  const base = apiBase(env, here);
  const call = (path) => fetcher(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const getJSON = async (path) => {
    const response = await call(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(`Cloudflare said: ${data.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`}.`);
    }
    return data;
  };
  return { call, getJSON };
}

/**
 * What a token allowed for someone's account shows about their site. `here` is this site's own origin; `fetcher` is for
 * tests. Friends' automatic checks (friendchecks.js) give `signed` (the signed list: the release must be in it, its manifest exactly as signed), `tie` (the
 * account's workers.dev name must be the address's, so a token for some other account can't stand in), and
 * `files: false` (the site files are looked at in a step of their own, siteFiles()).
 * @param {string} token
 * @param {string} site
 * @param {any} env
 * @param {string} here
 * @param {{ latest?: ReleaseInfo, signed?: any, tie?: boolean, files?: boolean }} [options]
 * @param {typeof fetch} [fetcher] what calls Cloudflare (a stand-in, in the tests)
 */
export async function checkSite(token, site, env, here, { latest = {}, signed = null, tie = false, files: lookAtFiles = true } = {}, fetcher = fetch) {
  const { call, getJSON } = client(token, env, here, fetcher);
  const releases = (testingHere(env, here) && env.RELEASES_URL) || `https://github.com/${REPO}/releases/download`;
  const script = new URL(site).hostname.split(".")[0];
  const result = { site, script, checkedAt: now() };
  const problems = []; // things that need a look, in words

  // The Worker: named like the site, in the account(s) the person allowed.
  const found = [];
  for (const account of ((await getJSON("/accounts")).result ?? []).slice(0, 5)) {
    if (typeof account?.id !== "string" || !/^[0-9a-f]{32}$/.test(account.id)) continue;
    const workers = (await getJSON(`/accounts/${account.id}/workers/scripts`)).result ?? [];
    const worker = workers.find((w) => w?.id === script);
    if (worker) found.push({ account: account.id, worker, others: workers.filter((w) => typeof w?.id === "string" && w.id !== script) });
  }
  if (found.length !== 1) return { ...result, problem: found.length ? "several" : "missing" };
  const { account, worker, others } = found[0];
  const at = `/accounts/${account}/workers/scripts/${script}`;
  result.account = account.slice(-6);
  if (tie) {
    result.accountId = account; // for the automatic check's next step; not kept
    const read = await getJSON(`/accounts/${account}/workers/subdomain`).then((d) => d, () => null);
    const name = read?.result?.subdomain;
    // (On this computer a test says what the stand-in account's name is.)
    const expected = testingHere(env, here) && env.TEST_SUBDOMAIN ? env.TEST_SUBDOMAIN : new URL(site).hostname.split(".")[1];
    if (!read || typeof name !== "string") {
      result.tieFailed = true;
      problems.push("Couldn't confirm the Cloudflare account that was allowed is the one at the site's address: Cloudflare wouldn't say its workers.dev name.");
    } else if (name !== expected) {
      result.tieFailed = true;
      problems.push("The Cloudflare account that was allowed isn't the one at the site's address (its workers.dev name is different).");
    }
  }
  result.created = Math.floor(Date.parse(worker.created_on) / 1000) || null;
  result.modified = Math.floor(Date.parse(worker.modified_on) / 1000) || null;
  try {
    if (!(await getJSON(`${at}/subdomain`)).result?.enabled) problems.push("Its workers.dev address is switched off, so this Worker isn't the one answering there.");
  } catch {
    problems.push("Couldn't see whether its workers.dev address is switched on.");
  }

  // Its code, file by file, against the release it says it is.
  const code = await call(at);
  if (!code.ok || !(code.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return { ...result, problem: "unreadable" };
  const files = new Map();
  let version = null;
  for (const [name, value] of (await code.formData()).entries()) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
    files.set(name, await hex(bytes));
    if (name === "index.js") version = VERSION_RE.exec(new TextDecoder().decode(bytes))?.[1] ?? null;
  }
  result.version = version;
  let manifest = null;
  if (!version) {
    result.code = "unknown";
  } else {
    const response = await fetcher(`${releases}/v${version}/manifest.json`, { headers: { "User-Agent": "afterwrd" } });
    const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    manifest = bytes ? (() => { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; } })() : null;
    if (manifest && signed) {
      const entry = signed.releases.get(version);
      if (!entry) {
        result.unsigned = true;
        problems.push(`afterwrd ${version} isn't a release signed with afterwrd's own key.`);
      }
      else if (entry.manifestSha256 !== await hex(bytes)) {
        problems.push(`afterwrd ${version} on GitHub isn't the release that was signed, so it was compared with nothing.`);
        manifest = null;
      }
    }
    if (!manifest || !Array.isArray(manifest.modules)) {
      result.code = response.status === 404 ? "no-release" : "release-unavailable";
      manifest = null;
    } else {
      const expected = new Map(manifest.modules.map((m) => [m.name, m.sha256]));
      const odd = [];
      for (const [name, hash] of files) if (expected.get(name) !== hash) odd.push({ name: text(name, 100), why: expected.has(name) ? "different" : "extra" });
      for (const name of expected.keys()) if (!files.has(name)) odd.push({ name: text(name, 100), why: "missing" });
      result.code = odd.length ? "different" : "matches";
      result.files = odd.slice(0, 20);
    }
    if (latest.securityFix && newer(latest.securityFix, version)) {
      problems.push(`It's older than afterwrd ${latest.securityFix}, which fixed a security problem: it needs updating.`);
    } else if (latest.version && newer(latest.version, version)) {
      result.newer = latest.version;
    }
  }

  // What it's connected to, and where its requests and logs go.
  try {
    const settings = (await getJSON(`${at}/script-settings`)).result ?? {};
    if ((settings.tail_consumers ?? []).length) problems.push("Its requests are copied to another Worker (a tail Worker). afterwrd never sets one.");
    if (settings.logpush) problems.push("Its requests are sent out with Logpush. afterwrd never turns that on.");
    if ((settings.observability?.logs?.destinations ?? []).length) problems.push("Its logs are sent to another destination. afterwrd never sets one.");
  } catch {
    problems.push("Couldn't read its logging settings.");
  }
  try {
    const deployments = (await getJSON(`${at}/deployments`)).result?.deployments ?? [];
    const serving = deployments[0]?.versions ?? [];
    if (serving.length !== 1 || serving[0].percentage !== 100) {
      problems.push("More than one version of it is serving visitors, so the code checked may not be the code everyone gets.");
    } else {
      // Is this the Worker answering at the site's address? The site says which uploaded version it is (/_version);
      // Cloudflare says which version of this Worker is serving. A Worker of the same name in another account, or one
      // in an account that isn't the one at that address, won't match.
      const said = await fetcher(`${site}/_version`, { redirect: "manual" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const detail = (await getJSON(`${at}/versions/${encodeURIComponent(serving[0].version_id)}`)).result ?? {};
      result.liveVersion = text(serving[0].version_id, 64);
      // Cloudflare hands over the newest upload's code, which needn't be what's serving (an upload can sit there unused
      // over something else that's live). So what's serving is told by its fingerprint: it must be the signed etag of
      // the release it says it is (signing.js; releases signed before etags have none, so can't be confirmed).
      const etag = detail.resources?.script?.etag;
      const signedEtag = signed && version ? signed.releases.get(version)?.etag : null;
      if (signed && version && signed.releases.has(version)) {
        if (!signedEtag) {
          result.servingUnconfirmed = true;
          problems.push(`The code serving visitors couldn't be confirmed: the signed list has no fingerprint for afterwrd ${version}.`);
        } else if (etag !== signedEtag) {
          result.servingMismatch = true;
          problems.push(`The code serving visitors isn't afterwrd ${version} as signed (its fingerprint is different), whatever the code handed over says.`);
        }
      }
      const have = (detail.resources?.bindings ?? []).map((b) => b?.type === "durable_object_namespace"
        ? `${b.type} ${b.name} ${b.class_name}` : `${text(b?.type, 40)} ${text(b?.name, 60)}`);
      const extra = have.filter((b) => !BINDINGS.includes(b) && !(b.startsWith("secret_text ") && SECRETS.has(b.slice(12))));
      const missing = BINDINGS.filter((b) => !have.includes(b) && !NO_LONGER_NEEDED.has(b));
      // Without its version piece a site can't say which upload it is, so the comparison can't be made: one plain
      // problem, rather than that and a mismatch that only follows from it.
      const noVersion = missing.includes("version_metadata VERSION") && !said?.id;
      if (noVersion) {
        missing.splice(missing.indexOf("version_metadata VERSION"), 1);
        problems.push("It's missing the piece Cloudflare uses to tell a site which upload it is (afterwrd's installs and updates "
          + "have added it since 0.29), so this check can't be sure the Worker it read is the one answering at the address. "
          + "Updating the site from its Update page puts it back; then ask for another check an hour later.");
      } else if (said?.id !== serving[0].version_id) {
        problems.push(`The site at ${new URL(site).host} isn't the Worker that was checked: they're different uploads. Was the right Cloudflare account allowed?`);
      }
      if (extra.length) problems.push(`It's connected to things afterwrd doesn't use: ${extra.slice(0, 8).join(", ")}.`);
      const wired = storageElsewhere(detail.resources?.bindings, script);
      if (wired.length) problems.push(`Its storage is wired to another Worker, which would see and could change everything it keeps: ${wired.slice(0, 4).join(", ")}. afterwrd never does that.`);
      if (missing.length) problems.push(`It's missing parts afterwrd needs: ${missing.join(", ")}.`);
      // Any other Worker connected to this site's database could read and change everything in it, whatever it's
      // called (a name like a group's included), so each one's bindings are looked at too: a D1 binding to its
      // database, or a binding to one of its objects (Durable Objects), which hold its database and its secrets. Another
      // Worker can bind those by naming this one (`script_name`); Cloudflare lists the binding with the objects'
      // namespace either way. (Groups bind only their own objects, by class alone.)
      const own = detail.resources?.bindings ?? [];
      const database = own.find((b) => b?.type === "d1" && b?.name === "DB");
      const databaseId = database?.id ?? database?.database_id;
      const namespaces = new Set(own.filter((b) => b?.type === "durable_object_namespace" && typeof b.namespace_id === "string").map((b) => b.namespace_id));
      const reaches = (b) => (b?.type === "d1" && databaseId && (b.id ?? b.database_id) === databaseId)
        || (b?.type === "durable_object_namespace" && (b.script_name === script || namespaces.has(b.namespace_id)));
      const sharing = [];
      for (const other of others.slice(0, OTHER_WORKERS)) {
        try {
          const live = ((await getJSON(`/accounts/${account}/workers/scripts/${encodeURIComponent(other.id)}/deployments`)).result?.deployments ?? [])[0]?.versions ?? [];
          for (const v of live) {
            const bindings = (await getJSON(`/accounts/${account}/workers/scripts/${encodeURIComponent(other.id)}/versions/${encodeURIComponent(v.version_id)}`)).result?.resources?.bindings ?? [];
            if (bindings.some(reaches)) { sharing.push(text(other.id, 60)); break; }
          }
        } catch {
          sharing.push(`${text(other.id, 60)} (couldn't be read)`);
        }
      }
      if (sharing.length) problems.push(`Another Worker in the account is connected to its database, so it could read and change everything in it: ${sharing.join(", ")}. afterwrd never does that.`);
      if (others.length > OTHER_WORKERS) problems.push(`The account has more Workers than this check looks at (${others.length}), so it couldn't make sure none of them is connected to its database.`);
      const runtime = detail.resources?.script_runtime ?? {};
      // Every request goes through its code first (run_worker_first), which checks each file it sends against the
      // release (static.js). Otherwise Cloudflare could hand out changed files, its sign-in page's scripts included,
      // whatever the code is, and Cloudflare's fingerprint of the code wouldn't show it.
      if (!filesThroughCode(runtime)) {
        problems.push(runtime.assets ? "Cloudflare sends some of its files without its code checking them first. afterwrd always has every request go through its code."
          : "Couldn't confirm Cloudflare sends every request through its code first.");
      }
      if (manifest && (runtime.compatibility_date !== manifest.compatibility_date
        || [...(runtime.compatibility_flags ?? [])].sort().join() !== [...(manifest.compatibility_flags ?? [])].sort().join())) {
        problems.push("Its compatibility settings aren't the release's.");
      }
    }
  } catch {
    problems.push("Couldn't read what it's connected to.");
  }

  if (manifest && lookAtFiles) problems.push(...await siteFiles(site, manifest, fetcher));

  result.problems = problems;
  return result;
}

/** Whether a version (its script_runtime, from Cloudflare) has every request go through its code, as afterwrd sets it. */
export const filesThroughCode = (runtime) => runtime?.assets?.raw_run_worker_first === true && runtime.assets.serve_directly !== true;

/**
 * A version's storage (its objects, OUTBOX and MEDIA) wired to another Worker's (`script_name`), or to a class afterwrd
 * doesn't use: the signed code byte for byte, with everything it keeps going through someone else's Worker, which
 * Cloudflare's fingerprint of the code doesn't show (security review 2026-11 H4). Returns what's wrong, as words, or [].
 * @param {any[] | undefined} bindings @param {string} script
 */
export function storageElsewhere(bindings, script) {
  const want = { OUTBOX: "Outbox", MEDIA: "MediaStore" };
  return (Array.isArray(bindings) ? bindings : []).filter((b) => b?.type === "durable_object_namespace")
    .filter((b) => (b.script_name && b.script_name !== script) || (Object.hasOwn(want, b.name) && b.class_name !== want[b.name]))
    .map((b) => `${text(b.name, 40)} → ${text(b.script_name || b.class_name, 60)}`);
}

/**
 * Its site files only through its code: asked for without signing in, each must get the code's sign-in redirect.
 * The ones the code hands out to anyone (static.js isPublicStatic: fonts, the home-screen app's files) are left out,
 * as they'd come back either way. At most `most` of them: friends' checks look at them in a step of their own, so at
 * every one (FILES_AT_MOST). Problems found, in words.
 */
export async function siteFiles(site, manifest, fetcher = fetch, most = 25) {
  const paths = (manifest.assets ?? []).map((a) => a?.path).filter((p) => typeof p === "string" && /^\/static\/[\w./-]+$/.test(p)
    && !p.startsWith("/static/fonts/") && !isPublicStatic(p));
  const direct = [];
  let unread = 0; // couldn't be asked (out of calls, or the site away): not a pass
  for (const path of paths.slice(0, most)) {
    const response = await fetcher(site + path, { method: "HEAD", redirect: "manual" }).catch(() => null);
    if (!response) unread++;
    else if (response.status === 200) direct.push(path);
  }
  return [
    ...(direct.length ? [`Cloudflare hands out ${direct.length === 1 ? "one of its files" : `${direct.length} of its files`} without its code checking them first (${direct.slice(0, 3).join(", ")}).`] : []),
    ...(unread ? [`Couldn't look at ${unread === 1 ? "one of its files" : `${unread} of its files`}, to see they only come through its code.`] : []),
  ];
}

// --- showing it --------------------------------------------------------------------------------------------------

export const when = (seconds) => new Date(seconds * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

// --- telling a friend's site it was checked, and hearing it -------------------------------------------------------

/**
 * A friend's site saying it checked this one and found it genuine (POST /_p/checked). Returns [body, status].
 * It's their word, as a friend: it only changes what this site suggests to its owner, and says who it came from.
 * @returns {Promise<import("./util.js").Answer>}
 */
export async function receiveChecked(env, url, peer, body) {
  if (body?.type !== "Checked" || body.site !== url.origin) return [{ error: "That isn't a check of this site." }, 400];
  const version = typeof body.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(body.version) ? body.version : null;
  // At most once an hour from one friend (a real check takes a while, and each is told once), so a site saying it
  // over and over can't wear out this one's database.
  await keepChecked(env.DB, peer.id, peer.name, version);
  return [{ ok: true }, 200];
}

async function keepChecked(db, connectionId, name, version) {
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO checked (connection_id, name, version, checked_at) SELECT ?1, ?2, ?3, ?4
      WHERE ?1 IS NULL OR NOT EXISTS (SELECT 1 FROM checked WHERE connection_id = ?1 AND checked_at > ?4 - 3600)`)
      .bind(connectionId, name, version, at),
    db.prepare("DELETE FROM checked WHERE id NOT IN (SELECT id FROM checked ORDER BY id DESC LIMIT 10)"),
  ]);
}

/** This site's newest check, as { name (null: the owner's own), version, checked_at }, or null if it's never been checked. */
export const lastChecked = (db) => db.prepare("SELECT name, version, checked_at FROM checked WHERE problems IS NULL ORDER BY id DESC LIMIT 1").first();
