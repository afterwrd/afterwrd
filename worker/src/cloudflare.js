// Connecting to Cloudflare: afterwrd asks for a one-hour token through Cloudflare's own sign-in (OAuth 2.0 with
// PKCE, as a public client: no secret) instead of a token the owner makes by hand. Used by the installer at
// install.afterwrd.app (central/), the Update page (update.js) and groups (groupsites.js). Nothing is kept beyond the hour:
// the token lives in a cookie that expires with it, which only this site's own pages can use, and afterwrd never
// asks for permission to make tokens of its own.
//
// The site sends the browser straight to Cloudflare's Allow page, with an address it builds itself (allowLink), so
// nothing else ever chooses what's asked for or the PKCE challenge (security review 2026-11 M11). Cloudflare only sends
// people back to the one address registered for afterwrd, https://afterwrd.app/connect/: a static page
// (installer/connect.html) that forwards them to the site `state` names, which is the only thing that holds the PKCE
// secret and so the only thing that can use the code. Before it does, for a site this browser hasn't connected
// before, it shows the address and asks: a look-alike site can't be told apart any other way (M10). The steps, all on
// the person's own site:
//   GET  /_cloudflare/start?back=<path>  a fresh PKCE secret and state in a short cookie, and a page saying what
//                                        Cloudflare will ask (allowPage), with the button that goes there
//   GET  /_cloudflare/done#code=…&state=…  back through the relay: a tiny page posts the code to…
//   POST /_cloudflare/finish {code, state}  checks the state against the cookie, swaps the code for the token (sending
//                                        the PKCE secret), keeps the token in a cookie, and says where to go back to
//   POST /_cloudflare/disconnect         drops the token early
// A site in group mode serves none of this (index.js); only the owner reaches it on their own site.
import { nonce } from "./nonce.js";
import pkg from "../package.json";
import { escape, html, json } from "./util.js";

// The sign-in app ("OAuth client") afterwrd asks Cloudflare through. Earlier ones (package.json cloudflareClientsBefore,
// oldest first) keep working for what they were given: a lasting permission is renewed with the app that was allowed
// (grantClient). So moving to a new app never ends anyone's automatic updates or friends' checks.
export const CLIENT_ID = pkg.afterwrd.cloudflareClient;
export const EARLIER_CLIENTS = /** @type {string[]} */ (pkg.afterwrd.cloudflareClientsBefore ?? []);
/** The app a lasting permission must be renewed with: the one noted when it was given, or the first, from before. */
export const grantClient = (noted) => (noted === CLIENT_ID || EARLIER_CLIENTS.includes(noted) ? noted : EARLIER_CLIENTS[0] ?? CLIENT_ID);
export const RELAY = `https://${pkg.afterwrd.site}/connect/`;
// What Connect asks Cloudflare for: making, changing and deleting Workers (afterwrd's own, and groups'; "Workers Editor" can't make a new one, so a fresh
// install or a new group needs "Workers Admin"), making databases, and reading the account's workers.dev name.
export const SCOPES = "workers-scripts.admin d1.write account-settings.read";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
// Both cookies are host-only. (workers.dev is a public suffix, so other Workers under the same account subdomain
// count as the same site: they're all afterwrd's own, and every POST here checks Origin exactly, which is what holds.)
const START_COOKIE = "cf_connect";
const TOKEN_COOKIE = "cf_token";
const START_SECONDS = 600;
const BACK_RE = /^\/(?![/\\])[\x21-\x7e]*$/; // a path on this site (never another site), as the browser would read it
export const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,1024}$/;

/** The link that starts connecting, coming back to `back` (a path here) once it's done. */
export const connectLink = (back) => `/_cloudflare/start?back=${encodeURIComponent(back)}`;

/** The token from an earlier Connect, while it lasts; null if there isn't one. */
export function connectedToken(request) {
  const token = readCookie(request, TOKEN_COOKIE);
  return token && CODE_RE.test(token) ? token : null;
}

/** The token a step uses: the connected one. Throws if there isn't one. */
export function tokenFor(request) {
  const token = connectedToken(request);
  if (!token) throw new Error("Connect Cloudflare first.");
  return token;
}

/** The connection's steps, for the paths under /_cloudflare/; null for anything else. */
export async function handleCloudflare(request, env, url) {
  const path = url.pathname.slice("/_cloudflare".length);
  if (request.method === "GET" && path === "/start") return start(request, url);
  if (request.method === "GET" && path === "/done") return html(donePage("/_cloudflare/finish"));
  if (request.method !== "POST") return null;
  if (path === "/finish") return finish(request, env, await request.json().catch(() => ({})));
  if (path === "/disconnect") return withCookie(json({ ok: true }), `${TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return null;
}

async function start(request, url) {
  // Only from this site's own pages (or typed in), never a link on another site: a connection someone else started
  // could end in the auto-run that follows it.
  const from = request.headers.get("Sec-Fetch-Site");
  if (from && from !== "same-origin" && from !== "none") return json({ error: "Start connecting from your own site." }, 403);
  const back = url.searchParams.get("back") ?? "/";
  if (!BACK_RE.test(back)) return json({ error: "Unexpected details." }, 400);
  const { verifier, state, link } = await allowLink(`${url.origin}/_cloudflare/done`, SCOPES);
  // Lax, so the cookie comes along when the relay page sends the browser back here.
  return withCookie(html(allowPage("connect", link, url.host)),
    `${START_COOKIE}=${state}.${verifier}.${base64url(new TextEncoder().encode(back))}; Path=/; Max-Age=${START_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

async function finish(request, env, body) {
  const started = readCookie(request, START_COOKIE) ?? "";
  const [state, verifier, backEncoded] = started.split(".");
  const clear = `${START_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  if (!state || !verifier || !backEncoded) return withCookie(json({ error: "This connection has expired. Start again from your site." }, 400), clear);
  if (typeof body.state !== "string" || body.state !== state) return withCookie(json({ error: "That isn't the connection this site started. Start again." }, 400), clear);
  if (typeof body.code !== "string" || !CODE_RE.test(body.code)) return withCookie(json({ error: "Cloudflare didn't send a code." }, 400), clear);
  const back = new TextDecoder().decode(fromBase64url(backEncoded));
  let data;
  try {
    data = await exchangeCode(env, body.code, verifier, new URL(request.url).origin);
  } catch (error) {
    return withCookie(json({ error: error.message }, 400), clear);
  }
  // Kept just short of the hour Cloudflare gives it, so a step never starts with a token about to expire.
  const seconds = Math.max(60, Math.min(Number(data.expires_in) || 3600, 3600) - 60);
  const done = withCookie(json({ back: BACK_RE.test(back) ? back : "/" }), clear);
  return withCookie(done, `${TOKEN_COOKIE}=${data.access_token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`);
}

/**
 * Whether test stand-ins may be used: ALLOW_LOCAL_SITES set AND this site running on this computer. A setting alone
 * isn't enough, so one added to a real site (say, by someone with access to the account) can't send Connect's codes,
 * or a check's, to an address of their choosing.
 */
export function testingHere(env, origin) {
  try {
    return env?.ALLOW_LOCAL_SITES === "1" && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Cloudflare's Allow page, asking for `scope`, with a fresh PKCE secret: { verifier, state, link }. Built here, so
 * afterwrd.app's relay, which Cloudflare sends the browser back through, never sees the challenge on the way out, and
 * only ever passes on a code it can't use (security review 2026-11 M11). `state` says where the relay sends the browser
 * on: `<random>~<to, base64url>`, `to` being an address on this site (installer/connect.html checks it's one of
 * afterwrd's return paths on a workers.dev address).
 * @param {string} to @param {string} scope
 */
export async function allowLink(to, scope) {
  const { verifier, challenge } = await pkce();
  const state = `${random(24)}~${base64url(new TextEncoder().encode(to))}`;
  const link = new URL(AUTHORIZE);
  link.searchParams.set("response_type", "code");
  link.searchParams.set("client_id", CLIENT_ID); // the app this site swaps the code with (exchangeCode)
  link.searchParams.set("redirect_uri", RELAY);
  link.searchParams.set("scope", scope);
  link.searchParams.set("state", state);
  link.searchParams.set("code_challenge", challenge);
  link.searchParams.set("code_challenge_method", "S256");
  return { verifier, state, link };
}

/** A fresh PKCE secret, its challenge (what Cloudflare is shown) and a state to match the return against. */
export async function pkce() {
  const verifier = random(48);
  const state = random(24);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, state, challenge };
}

/** Swaps Cloudflare's one-time code for the token (sending the PKCE secret); throws with a message to show. */
export async function exchangeCode(env, code, verifier, origin, redirectUri = RELAY) {
  // When testing on this computer, a stand-in for Cloudflare's token endpoint.
  const endpoint = testingHere(env, origin) && env.OAUTH_TOKEN_URL ? env.OAUTH_TOKEN_URL : TOKEN_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(`Cloudflare didn't finish connecting: ${data.error_description || data.error || `HTTP ${response.status}`}`);
  }
  if (!CODE_RE.test(data.access_token)) throw new Error("Cloudflare's token isn't in a form this site can use.");
  return data;
}

// The card both pages below are drawn on (Cloudflare's page comes between them, so going there and back reads as one).
// Only the page before Cloudflare's hides where it came from: the page after it mustn't, as the Update page starts the
// update by itself only when it's arrived at from Connect (views/update.js fromConnect).
const CARD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<style>
  body { margin: 0; padding: 16px; background: #16201b; color: #ede6da; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 480px; margin: 48px auto; background: #1f2b25; border-radius: 24px; padding: 28px; }
  .brand { display: flex; align-items: center; font: 900 1.35rem/1 ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif; margin: 0 0 18px; letter-spacing: -0.02em; }
  .brand .o { width: 0.82em; height: 0.82em; color: #ff8a3d; margin: 0 0.02em; }
  p { margin: 8px 0; }
  a { color: #ffab73; }
  .meta { color: #a9a092; font-size: 0.9rem; }
  details summary { cursor: pointer; }
  ul { padding-left: 1.1rem; }
  li { margin: 0.4rem 0; }
  .grants { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.92rem; }
  .grants th, .grants td { text-align: left; vertical-align: top; padding: 8px 6px; border-top: 1px solid #2e3d35; }
  .grants thead th { color: #a9a092; font-weight: 600; border-top: 0; }
  .button { display: inline-block; padding: 10px 18px; border-radius: 999px; background: #ede6da; color: #16201b; font-weight: 700;
    text-decoration: none; margin-top: 8px; }
  #error:empty { display: none; }
  /* Passing through: nothing but the background unless it takes a moment, so it doesn't flash. A problem shows at once. */
  body.passing main { animation: appear 0s 0.5s both; }
  @keyframes appear { from { visibility: hidden; } }
</style>`;
const BRAND = `<p class="brand" aria-label="afterwrd">afterw<svg class="o" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-4.7 14.5L3.8 20l1.2-3.6A8 8 0 0 1 12 4z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>rd</p>`;

// What each way of connecting asks Cloudflare for, in words, on the site's own page before Cloudflare's (allowPage).
const ASKING = {
  connect: `<p><b>Connect your site to Cloudflare?</b></p>
    <p class="meta">This lets your site update itself (or your groups) for <b>one hour</b>. On Cloudflare's next page,
    press <b>Allow</b>.</p>
    <details class="meta"><summary>What exactly does it allow?</summary>
    <p>For that hour, the site can make and change Workers (the small programs websites run on) and databases in your
    Cloudflare account. Nothing is kept afterwards.</p></details>`,
  auto: `<p><b>Let your site keep itself up to date?</b></p>
    <p class="meta">New afterwrd releases will install by themselves, a few days after they come out. This stays on
    until you turn it off, on your site's Update page. On Cloudflare's next page, leave <b>Background Access</b> ticked
    and press <b>Allow</b>.</p>
    <details class="meta"><summary>What exactly does it allow?</summary>
    <p>Lasting access to change your Workers (Cloudflare calls it Workers Editor), and nothing else: it can't make or
    read databases, read your account's settings or make tokens. You can also remove it in Cloudflare: My Profile →
    Access Management → Connected Applications.</p></details>`,
  both: `<p><b>Let your site look after itself?</b></p>
    <ul class="meta">
      <li><b>Keep itself up to date.</b> New afterwrd releases install by themselves, so you get fixes without doing
        anything.</li>
      <li><b>Let friends' sites check it.</b> Now and then, a friend's afterwrd site checks yours is the genuine afterwrd,
        and tells you if anything's wrong. It can only look, never change anything. Without it, nobody can check your
        site.</li>
    </ul>
    <p class="meta">Both stay on until you turn them off, on your site's Update page. On each of the next two Cloudflare
    pages, leave <b>Background Access</b> ticked and press <b>Allow</b>.</p>
    <details class="meta"><summary>What exactly do they allow?</summary>
    <p>Unlike the one-hour access that installed afterwrd, these last until you turn them off.</p>
    <table class="grants">
      <thead><tr><th></th><th>What it can do</th><th>How long</th></tr></thead>
      <tbody>
        <tr><th>Automatic updates</th><td>Install each new afterwrd release, once it's signed and has been out a few days.
          It can change your Workers, but can't read your databases or your account's settings.</td><td>Until you turn it off</td></tr>
        <tr><th>Friends' checks</th><td>Let your friends' afterwrd sites read your site's code, to confirm it's the real
          afterwrd. Read-only: it can't change anything. Each friend's site gets a one-hour pass at a time.</td><td>Until you turn it off</td></tr>
      </tbody>
    </table>
    <p>Turn either off any time on your site's Update page, or in Cloudflare under My Profile → Access Management →
    Connected Applications.</p></details>`,
  checks: `<p><b>Let your friends' afterwrd sites check yours?</b></p>
    <p class="meta">Now and then, a friend's afterwrd site checks yours is the genuine afterwrd, and tells you if
    anything's wrong. It can only look, never change anything. This stays on until you turn it off, on your site's
    Update page. On Cloudflare's next page, leave <b>Background Access</b> ticked and press <b>Allow</b>.</p>
    <details class="meta"><summary>What exactly does it allow?</summary>
    <p>Lasting access to <b>read</b> the code of every Worker in your Cloudflare account (not only afterwrd's), and
    nothing else: it can't change anything, or read your databases or your account's settings. Your site gives a
    friend's site that asks a one-hour, read-only pass from it. You can also remove it in Cloudflare: My Profile →
    Access Management → Connected Applications.</p></details>`,
  recover: `<p><b>Get back into your afterwrd site?</b></p>
    <p class="meta">Cloudflare will ask to let afterwrd change your Workers for an hour. Your site uses that once, to
    prove you're its owner, without changing anything, and keeps nothing. Then you can add the device you're on.
    Sign in to Cloudflare as the account your site is in, and press <b>Allow</b>.</p>`,
};

/**
 * The site's own page before Cloudflare's Allow page: what's about to be asked for, and the button that goes there
 * (`link`, from allowLink). Then the way back is through afterwrd.app, which may show this site's address to check.
 * `skip`: where "Not now" goes, when there is one (a new site's setup).
 * @param {keyof typeof ASKING} kind @param {URL} link @param {string} host @param {{ skip?: string | null }} [options]
 */
export function allowPage(kind, link, host, { skip = null } = {}) {
  return `<!doctype html>
<html lang="en-GB">
<head>
${CARD}
<meta name="referrer" content="no-referrer">
<title>Connecting to Cloudflare · afterwrd</title>
</head>
<body>
<main>
${BRAND}
${ASKING[kind]}
<p class="meta">Afterwards, Cloudflare sends you back here through afterwrd.app, which may ask you to check this site's
address: <b>${escape(host)}</b>.</p>
<p><a class="button" href="${escape(link.toString())}">Continue to Cloudflare</a></p>
${skip ? `<p class="meta"><a href="${escape(skip)}">Not now</a>: you can turn ${kind === "both" ? "them" : "it"} on later on your site's Update page.</p>` : ""}
</main>
</body>
</html>`;
}

// Back from the relay: the code and state travel in the fragment (never sent to a server or kept in a log), and this
// page posts them to /finish, which can read the cookie the fragment can't. With `carryOn` (a new site's setup), a
// problem, or not allowing it, still leaves a way on: setup carries on without it.
export function donePage(finishPath, { carryOn = null } = {}) {
  return `<!doctype html>
<html lang="en-GB">
<head>
${CARD}
<title>One moment · afterwrd</title>
</head>
<body class="passing">
<main>
${BRAND}
<p id="status">One moment…</p>
<p id="error" role="alert"></p>
<p id="carry-on" hidden><a href="${carryOn ?? "/"}">Carry on to your site</a>. You can turn this on later on its Update page.</p>
</main>
<script nonce="${nonce()}">
  const carryOn = () => {
    document.body.classList.remove("passing");
    if (${JSON.stringify(Boolean(carryOn))}) document.getElementById("carry-on").hidden = false;
  };
  (async () => {
    const params = new URLSearchParams(location.hash.slice(1));
    const status = document.getElementById("status");
    const problem = document.getElementById("error");
    history.replaceState(null, "", location.pathname); // the code is single-use, and not for the history
    if (params.get("error")) {
      status.textContent = "";
      problem.textContent = params.get("error") === "access_denied"
        ? "You didn't allow it, so nothing has changed. You can go back and try again."
        : "Cloudflare couldn't connect: " + params.get("error");
      carryOn();
      return;
    }
    try {
      const res = await fetch(${JSON.stringify(finishPath)}, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: params.get("code"), state: params.get("state") }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      location.replace(data.back || "/");
    } catch (err) {
      status.textContent = "";
      problem.textContent = err.message;
      carryOn();
    }
  })();
</script>
</body>
</html>`;
}

export function withCookie(response, cookie) {
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", cookie);
  return out;
}

export function readCookie(request, name) {
  const found = (request.headers.get("Cookie") ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

export const random = (bytes) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
