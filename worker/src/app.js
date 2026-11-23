// Everything a request to the site goes through, wherever its database is (index.js decides: D1 here, or the site's
// object). Pages are built from the database, photos and videos come from the media store (/files/<sha256>), and the
// stylesheet and import scripts from public/static. Everything the owner imports arrives through /_admin/import. Every
// request comes through here first (run_worker_first), so nothing is reachable without a session, apart from sign-in,
// a Connect link, friends' sites, which make signed calls (calls.js: friendhost.js, friendcalls.js, notes.js), and
// groups the owner's in, which carry a key (membership.js). A group's own Worker (with the secret GROUP_KEY) is afterwrd in
// group mode: it answers only its members' sites and invite links (groups.js), and serves nothing else at all.
import { handleFriendItems } from "./friendhost.js";
import { withWork } from "./later.js";
import { contentSecurityPolicy, newNonce, withNonce } from "./nonce.js";
import { BRINGING_BYTES } from "./before.js";
import { receiveNotes } from "./notes.js";
import { receiveReceipt } from "./receipts.js";
import { handleIdentity } from "./identities.js";
import { testSlowSeconds } from "./identity.js";
import { handleAdmin } from "./admin.js";
import { renderArchive } from "./archive/routes.js";
import { currentUser, handleAuth, safeNext } from "./auth.js";
import { handleCloudflare } from "./cloudflare.js";
import { handleConnectLink } from "./connect.js";
import { handleGroupApi, handleJoinLink, testCloseSeconds } from "./groups.js";
import { handleGroupItems } from "./groupposts.js";
import { HASH_RE, mediaStore } from "./media.js";
import { handleGroupActions, handleMember } from "./membership.js";
import { checkNewer, databaseIsNewer, ensureSchema } from "./migrate.js";
import { friendCallRoute, handleFriendCalls } from "./friendcalls.js";
import { messagePage } from "./views/pages.js";
import { signedFor } from "./share.js";
import { PUBLIC_APP, PUBLIC_FONT, PUBLIC_SIGNING, serveStatic } from "./static.js";
import { handleCheck } from "./checks.js";
import { html, json } from "./util.js";
import { bodyBytes } from "./calls.js";
import { countRequest, testLimits } from "./limits.js";
import { OverAllowance, settle } from "./allowances.js";
import { handleLive } from "./live.js";
import { handlePush } from "./push.js";
import { autoState, handleAutoConnect, handleAutoStep, health, runAuto } from "./auto.js";
import { handleChecksConnect, runFriendChecks } from "./friendchecks.js";
import { selfHosted } from "./hosting.js";
import { measure, measured, showTiming, testDelays, timingHeader } from "./timing.js";

export const HEADERS = {
  // Scripts only from this site's files, plus (set per answer in handle) the page's own, which carry its nonce
  // (nonce.js). The rest of the policy is there too.
  "Content-Security-Policy": contentSecurityPolicy(""),
  // Other sites never learn where a visitor came from. (Not "no-referrer": that makes browsers send
  // "Origin: null" on this site's own forms, which the cross-site check then refuses.)
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

// What a self-hosted site doesn't have (hosting.js): automatic updates and Connect (/_auto, /_cloudflare), friends'
// checks both ways (/_check, /_admin/checks, and the protocol's check calls), and getting back in through Cloudflare
// (/_auth/recover). Updating (update.js) and starting groups (groupsites.js) say what to do instead.
const CLOUDFLARE_ONLY = /^\/(_auto|_cloudflare|_check|_admin\/checks)(\/|$)|^\/_auth\/recover(\/|$)|^\/_p\/(check-request|check-token|check-soon|check-failed|checked)$/;
// What the owner can still open before signing is set up (ownerRoute): setting it up, moving in (which brings an
// identity with it), Download everything and Update; and files, live updates and the rest that aren't pages.
const SIGNING_NOT_NEEDED = /^\/(_admin\/(keys|import\/move|export|update)|_cloudflare|_live|_push|_groups|files|static)(\/|$)/;

/**
 * One request, start to finish, wherever the site's database is: in this Worker (D1), or inside the site's object
 * (sqlite.js, the prototype), which calls this with env.DB its own. Each request is timed (timing.js): the signed-in
 * owner's replies say how long went on the database and on other sites, and how many calls out were made, in a
 * Server-Timing header.
 */
export const handle = (request, env, work) => measure(async () => {
  env = measured(env);
  testDelays(env);
  if (env.ALLOW_LOCAL_SITES && env.TEST_SLOW_SECONDS) testSlowSeconds(Number(env.TEST_SLOW_SECONDS));
  if (env.ALLOW_LOCAL_SITES && env.TEST_CLOSE_SECONDS) testCloseSeconds(Number(env.TEST_CLOSE_SECONDS));
  testLimits(env);
  countRequest(); // today's usage (limits.js), for the busy-account warning
  const nonce = newNonce(); // for this answer's page, if it's one (nonce.js)
  let response;
  try {
    response = await withNonce(nonce, () => withWork(work, () => route(request, env, work)));
  } catch (error) {
    // A site past its allowance here today (allowances.js): refused until the day ends, and told when that is.
    if (error instanceof OverAllowance) response = json({ error: error.message, ...error.more }, 429);
    // A newer version may have changed the database under this one (migrate.js): say so, rather than fail.
    else if (!(await checkNewer(env))) throw error;
    else response = withNonce(nonce, () => beingUpdated(request));
  }
  // The rows this request read, charged to whoever it was from; counts saved now and then (allowances.js).
  await settle(env).catch((error) => console.error("Counting:", error.message));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
  headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  const timing = timingHeader();
  if (timing) headers.set("Server-Timing", timing);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});

/**
 * The daily run of automatic updates (auto.js), at the time set when they were turned on. Group Workers have none.
 * Then this site's checks of its friends' sites that are due (friendchecks.js).
 */
export async function daily(env) {
  if (env.GROUP_KEY || selfHosted(env)) return; // both jobs work through Cloudflare (hosting.js)
  await runAuto(env).then(async () => {
    const { on, origin } = await autoState(env.DB);
    // (On this computer a test can have every friend checked at once.)
    if (on && origin) await runFriendChecks(env, origin, { everyone: Boolean(env.ALLOW_LOCAL_SITES && env.TEST_CHECK_EVERYONE) });
  }).catch((error) => console.error("Daily run:", error.message));
}

/**
 * What an older version answers on a database a newer one has changed (migrate.js), while everyone's sent on to the
 * newer one: a page or a JSON error, and nothing written.
 */
function beingUpdated(request) {
  const message = "This site is being updated. Try again in a few minutes.";
  const headers = { "Retry-After": "120", "Cache-Control": "no-store" };
  if ((request.headers.get("Accept") ?? "").includes("text/html")) {
    return new Response(messagePage(message, { href: "/", label: "Try again" }), {
      status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return new Response(JSON.stringify({ error: message }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
}

async function route(request, env, work) {
  await ensureSchema(env);
  const url = new URL(request.url);
  // On a newer version's database, only which version this is, an update's own steps (they only use settings), and the
  // stylesheet and fonts for the page saying so.
  if (url.pathname !== "/_version" && !/^\/(_auto|static)\//.test(url.pathname) && await databaseIsNewer(env)) return beingUpdated(request);
  // Other sites' calls (friends', members', groups'): bodies of 64 KB at most, refused before anything is read or
  // checked (T31), but 1 MB for bringing things over from afterwrd 1, where an item's comments from before go together.
  // Read once here, so what follows can read it again.
  if (request.method === "POST" && /^\/_(p|member|group)\//.test(url.pathname)) {
    const bytes = await bodyBytes(request, url.pathname === "/_p/before" || url.pathname === "/_group/before" ? BRINGING_BYTES : undefined);
    if (!bytes) return json({ error: "That's too big." }, 413);
    request = new Request(request, { body: bytes });
  }
  if (env.GROUP_KEY) return routeGroup(request, env, url);
  // Which uploaded version of the Worker is answering at this address: public, as it says nothing but an ID Cloudflare
  // made up. A friend's check (checks.js) compares it with what Cloudflare says, to be sure it read the right Worker.
  // With ?health=1, also a few typical reads: what an update waits for before it counts (auto.js). The migrations have
  // already run by now, as for every request.
  if (url.pathname === "/_version" && request.method === "GET") {
    const answer = url.searchParams.has("health") ? await health(env) : { id: env.VERSION?.id ?? null };
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  // Self-hosted (hosting.js), what works through Cloudflare isn't there: as if it didn't exist.
  if (selfHosted(env) && CLOUDFLARE_ONLY.test(url.pathname)) return new Response("Not found", { status: 404 });
  // The steps of an automatic update, asked for by the site's own daily run with a key only it has (auto.js).
  if (url.pathname.startsWith("/_auto/")) return handleAutoStep(request, env, url);
  if (url.pathname.startsWith("/_auth/")) return handleAuth(request, env, url);
  // A friend's Connect link, and their site asking to be friends: signed calls (connect.js).
  if (url.pathname.startsWith("/_connect/")) return handleConnectLink(request, env, url);
  // afterwrd 2 (identities.js): the owner's identity, public.
  if (url.pathname === "/.well-known/afterwrd") {
    return (await handleIdentity(request, env, url)) ?? new Response("Not found", { status: 404 });
  }
  // afterwrd 2: friends' sites asking about the owner's signed posts, and passing on their owners' comments (friendhost.js).
  if (url.pathname === "/_p/items" || url.pathname.startsWith("/_p/items/") || url.pathname === "/_p/records" || url.pathname === "/_p/records/check"
    || url.pathname === "/_p/before") return handleFriendItems(request, env, url, work);
  if (url.pathname === "/_p/notes" && request.method === "POST") return receiveNotes(request, env, url, work);
  if (url.pathname === "/_p/mention" && request.method === "POST") return receiveReceipt(request, env, url, work);
  // …and the rest: removing, introductions, checks, and the shared Facebook archive (friendcalls.js).
  if (friendCallRoute(`${request.method} ${url.pathname}`)) return handleFriendCalls(request, env, url);
  // A group the owner's in, calling with the key this site gave it.
  if (url.pathname.startsWith("/_member/")) return handleMember(request, env, url);
  // Anything else another site might ask under /_p/ isn't here: a plain 404, never the sign-in page (a 401 would read
  // to a friend's site as "they've removed you", so a call added in a later release would look like that to them).
  if (url.pathname.startsWith("/_p/")) return json({ error: "Not found." }, 404);
  // A friend checking their site at this site's invitation (checks.js): they aren't signed in here.
  if (url.pathname.startsWith("/_check/")) return handleCheck(request, env, url);
  const reading = request.method === "GET" || request.method === "HEAD";
  // The fonts are public, so the sign-in pages can use them too; they're open-licensed and say nothing about the site.
  if (reading && PUBLIC_FONT.test(url.pathname)) return serveStatic(request, env);
  // So is the signing code the sign-in page makes this browser's key with (static.js PUBLIC_SIGNING).
  if (reading && PUBLIC_SIGNING.test(url.pathname)) return serveStatic(request, env);
  // The home-screen app's manifest, icons and service worker are public too: phones fetch them without
  // the session, and they're the same for every site. The service worker may look after the whole site (scope "/").
  if (reading && PUBLIC_APP.test(url.pathname)) {
    const file = await serveStatic(request, env);
    if (url.pathname === "/static/app/push-sw.js") file.headers.set("Service-Worker-Allowed", "/");
    return file;
  }
  const signed = await signedFile(request, env, url);
  if (signed) return signed;

  const user = await currentUser(request, env);
  if (!user) {
    if (!reading) return new Response("Not signed in", { status: 401 });
    return Response.redirect(`${url.origin}/_auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  // Every signed-in form and action is checked here, once: only this site's own pages may send them. (A browser always
  // says which site a POST, PUT or DELETE comes from, in Origin.) So no handler below needs to, or can forget to.
  if (!reading && request.headers.get("Origin") !== url.origin) return fromElsewhere(request);
  showTiming();
  return redrawn(request, env, url, user, work, await ownerRoute(request, env, url, user, work));
}

/**
 * A form ui.js sends in place says which page its part is redrawn from (the Afterwrd-Redraw header: a path on this
 * site). When it worked (the site sends you on), that page comes back in the same answer instead, marked
 * Afterwrd-Redrawn: one trip over a slow phone network, not two. Anything else is answered as it was.
 */
async function redrawn(request, env, url, user, work, answer) {
  const asked = request.headers.get("Afterwrd-Redraw");
  if (request.method !== "POST" || !asked || ![302, 303].includes(answer.status)) return answer;
  const location = answer.headers.get("Location");
  if (!location || new URL(location, url).origin !== url.origin) return answer;
  if (!asked.startsWith("/") || safeNext(asked, url) !== asked) return answer;
  const page = new URL(asked, url.origin);
  if (page.pathname.startsWith("/_")) return answer; // pages only, never another action
  // The same reader (their session, and where they are: the page's times are in their time zone), asking for a page.
  const reading = new Request(page, { headers: { Cookie: request.headers.get("Cookie") ?? "", Accept: "text/html" }, cf: request.cf });
  const fresh = await renderArchive(reading, env, page, user, work);
  if (fresh.status !== 200) return answer;
  const headers = new Headers(fresh.headers);
  headers.set("Afterwrd-Redrawn", "1");
  headers.set("Cache-Control", "private, no-store");
  for (const cookie of answer.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(fresh.body, { status: 200, headers });
}

/** A signed-in action sent from another site: refused, in the form its caller expects (JSON for the scripted steps). */
function fromElsewhere(request) {
  const message = "Request from another site";
  const wantsJson = /json/.test(`${request.headers.get("Content-Type") ?? ""} ${request.headers.get("Accept") ?? ""}`);
  return wantsJson ? new Response(JSON.stringify({ error: message }), { status: 403, headers: { "Content-Type": "application/json" } })
    : new Response(message, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** The owner's own pages and actions, once signed in (actions only from this site's own pages: see route). */
async function ownerRoute(request, env, url, user, work) {
  const reading = request.method === "GET" || request.method === "HEAD";
  const [, top, rest] = url.pathname.split("/");
  // afterwrd 2 (step 10a): until signing is set up the site has no identity, so it can't reach anyone. After the update
  // to afterwrd 2, every page sends the owner to set it up first (keys.js), then on to where they were going. Setting
  // up, moving in, Download everything and Update still open.
  if (reading && !SIGNING_NOT_NEEDED.test(url.pathname) && !(await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1").first())) {
    return Response.redirect(`${url.origin}/_admin/keys?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) return handleAdmin(request, env, url, user);
  // Connecting to Cloudflare, for updating and groups (an hour's token in a cookie; cloudflare.js).
  // Background access for automatic updates is a Connect of its own (auto.js).
  if (url.pathname.startsWith("/_cloudflare/auto-")) return (await handleAutoConnect(request, env, url)) ?? new Response("Not found", { status: 404 });
  // So is the read-only access friends' sites check this one with (friendchecks.js).
  if (url.pathname.startsWith("/_cloudflare/checks-")) return (await handleChecksConnect(request, env, url)) ?? new Response("Not found", { status: 404 });
  if (url.pathname.startsWith("/_cloudflare/")) return (await handleCloudflare(request, env, url)) ?? new Response("Not found", { status: 404 });
  if (url.pathname === "/_live") return handleLive(request, env, url, user, work);
  // This device saying yes or no to notifications about events (push.js).
  if (url.pathname.startsWith("/_push/")) return handlePush(request, env, url, user);
  if (url.pathname.startsWith("/_groups/")) return handleGroupActions(request, env, url);
  if (!reading) return new Response("Method not allowed", { status: 405 });

  if (top === "files" && HASH_RE.test(rest ?? "")) return serveFile(request, env, rest);
  if (top === "static") return serveStatic(request, env);
  return renderArchive(request, env, url, user, work);
}

// A photo or video a connected friend's site (or a group's member) was given a signed link to (share.js): no session
// needed until it expires, and only that one file. Null if the request isn't for one.
async function signedFile(request, env, url) {
  const [, top, rest] = url.pathname.split("/");
  if (!["GET", "HEAD"].includes(request.method) || top !== "files" || !HASH_RE.test(rest ?? "") || !url.searchParams.has("sig")) return null;
  const left = await signedFor(env, rest, url.searchParams);
  return left ? serveFile(request, env, rest, `private, max-age=${left}`) : new Response("This link has expired", { status: 403 });
}

// A group's own Worker: invite links, its members' sites, and its photos by signed link. Nothing else.
async function routeGroup(request, env, url) {
  // afterwrd 2 (step 6a): the group's identity, public, with its owner's (identities.js, groupidentity.js).
  if (url.pathname === "/.well-known/afterwrd") return (await handleIdentity(request, env, url)) ?? new Response("Not found", { status: 404 });
  if (url.pathname.startsWith("/_join/")) return handleJoinLink(request, env, url);
  if (url.pathname.startsWith("/_group/")) return handleGroupApi(request, env, url);
  // afterwrd 2 (step 6c): its posts, as signed items, to members' signed calls (groupposts.js).
  if (url.pathname === "/_p/items" || url.pathname.startsWith("/_p/items/") || url.pathname === "/_p/records" || url.pathname === "/_p/records/check"
    || url.pathname === "/_p/people") return handleGroupItems(request, env, url);
  const signed = await signedFile(request, env, url);
  if (signed) return signed;
  if (request.method === "GET" && PUBLIC_FONT.test(url.pathname)) return serveStatic(request, env);
  return html(messagePage("This is an afterwrd group. Its members open it from their own afterwrd sites.",
    { href: "https://afterwrd.app/", label: "About afterwrd" }), 404);
}

// A file's address is its contents' hash, so it can be cached for good (or, through a signed link, while it lasts).
async function serveFile(request, env, hash, cacheControl = "private, max-age=31536000, immutable") {
  const stored = await mediaStore(env, hash).fetch(new Request(`https://media/${hash}`, {
    method: request.method,
    headers: ["Range", "If-None-Match"].filter((h) => request.headers.has(h)).map((h) => [h, request.headers.get(h)]),
  }));
  const response = new Response(stored.body, stored);
  if (stored.ok || stored.status === 304) response.headers.set("Cache-Control", cacheControl);
  return response;
}
