// The only pages served to people who aren't signed in. Styles and script are inline because /static is
// behind the login too (apart from the fonts, which are public: see index.js).
import { nonce } from "../nonce.js";
import { asset, favicon, importMap, LOGO } from "./nav.js";
import { escape } from "../util.js";
import { resultHtml } from "./checks.js";

const STYLE = `
  @font-face { font-family: "Nunito"; src: url("/static/fonts/nunito.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  @font-face { font-family: "Nunito Sans"; src: url("/static/fonts/nunito-sans.woff2") format("woff2"); font-weight: 200 1000; font-display: swap; }
  :root { --bg: #16201b; --surface: #1f2b25; --sunken: #121a16; --text: #ede6da; --muted: #a9a092; --border: #2e3d35;
          --accent: #ff8a3d; --accent-strong: #ffab73; --on-accent: #16201b; --button: #ede6da; --button-hover: #ffffff;
          --on-button: #16201b; --moss: #a8d49a; --danger: #ff8070; color-scheme: dark;
          --round: "Nunito", ui-rounded, system-ui, sans-serif; }
  /* The light look, as in style.css (nav.js look() picks it). */
  :root[data-look="light"] { --bg: #f6f1e8; --surface: #fffdf8; --sunken: #f1ebe0; --text: #1f2a24; --muted: #6b6458; --border: #e0d6c6;
          --accent-strong: #a8480c; --button: #24332b; --button-hover: #16201b; --on-button: #fffdf8; --moss: #3f7334; --danger: #b3352b;
          color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg);
         color: var(--text); font: 16px/1.55 "Nunito Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 420px; background: var(--surface); border-radius: 26px; padding: 34px; }
  .brand { display: flex; align-items: center; font: 900 1.8rem/1 var(--round); margin: 0 0 26px; letter-spacing: -0.02em; color: var(--text); }
  .wordmark { display: inline-flex; align-items: center; }
  .wordmark .o { width: 0.82em; height: 0.82em; margin: 0.08em 0.01em 0; color: var(--accent); }
  h1 { font: 900 1.75rem/1.2 var(--round); margin: 0 0 10px; letter-spacing: -0.015em; }
  p { margin: 0 0 20px; color: var(--muted); }
  a { color: var(--accent-strong); }
  button, .button { display: block; width: 100%; min-height: 3rem; padding: 12px; border: 0; border-radius: 999px; background: var(--button);
           color: var(--on-button); font: 900 1rem var(--round); text-align: center; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { background: var(--button-hover); }
  button:disabled { opacity: 0.6; cursor: default; }
  :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; }
  #error { color: var(--danger); margin: 12px 0 0; min-height: 1.5em; }
  .small { font-size: 0.9rem; }
  input { width: 100%; font: inherit; min-height: 3rem; padding: 11px 18px; border: 1px solid var(--border); border-radius: 999px;
          background: var(--sunken); color: var(--text); }
`;

// Turns WebAuthn's binary fields into base64url JSON and back; @simplewebauthn/server expects this shape.
// Also: a friend link brought here by the installer (after the #, so no server sees it) waits in this tab while the
// owner makes their passkey, then opens "Add … as a friend?" (INVITE_RE: a friend link's shape).
const CLIENT = `
  const INVITE_RE = /^(https:\\/\\/[a-z0-9-]+\\.[a-z0-9-]+\\.workers\\.dev|http:\\/\\/localhost:\\d+)\\/_connect\\/[\\w-]{40,100}$/;
  const keepInvite = () => {
    const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
    try { if (invite && INVITE_RE.test(invite)) sessionStorage.setItem("afterwrd-invite", invite); } catch {}
  };
  // The very first passkey of a site set up from the installer (setupPage hands on "#setup") goes on to the site's two
  // lasting permissions (automatic updates, then friends' checks: auto.js, friendchecks.js), which end at
  // /_admin/setup/done (setupDonePage), which carries on as below. A link made by hand (scripts/owner.mjs) doesn't.
  const afterPasskey = (first) => {
    if (first) return location.replace("/_cloudflare/auto-start?then=checks&setup=1");
    let invite = null;
    try { invite = sessionStorage.getItem("afterwrd-invite"); sessionStorage.removeItem("afterwrd-invite"); } catch {}
    location.replace(invite && INVITE_RE.test(invite) ? "/_admin/connections/new?link=" + encodeURIComponent(invite) : "/");
  };
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const ids = (list) => (list || []).map((c) => ({ ...c, id: dec(c.id) }));

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function credentialJSON(c) {
    const r = c.response;
    const response = { clientDataJSON: enc(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = enc(r.attestationObject);
      response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      response.authenticatorData = enc(r.authenticatorData);
      response.signature = enc(r.signature);
      if (r.userHandle) response.userHandle = enc(r.userHandle);
    }
    return { id: c.id, rawId: enc(c.rawId), type: c.type, response,
             clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment };
  }

  function run(button, action) {
    const error = document.getElementById("error");
    if (!window.PublicKeyCredential) {
      error.textContent = "This browser doesn't support passkeys. Try an up-to-date Safari, Chrome, Edge or Firefox.";
      button.disabled = true;
      return;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try { await action(); }
      catch (e) {
        error.textContent = e.name === "NotAllowedError" ? "Cancelled, or no passkey was chosen. Try again." : e.message;
        button.disabled = false;
      }
    });
  }
`;

// afterwrd 2's signing code (public/static/signed.js, browserkey.js), loaded when needed: public, so sign-in can use it.
const SIGNING = `
  const signing = () => Promise.all([import(${JSON.stringify(asset("/static/signed.js"))}), import(${JSON.stringify(asset("/static/browserkey.js"))})]);
`;

function page(title, body, script = "") {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${favicon()}
${importMap()}
<title>${title} · afterwrd</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand" aria-label="afterwrd">${LOGO}</p>
${body}
</main>
${script && `<script nonce="${nonce()}">${CLIENT}\n${SIGNING}\n${script}</script>`}
</body>
</html>`;
}

/**
 * Signing in. Lost every device: on Cloudflare, back in through the account the site is in (recover.js); on a
 * self-hosted site (hosting.js), a link from a command on the server.
 */
export function loginPage(next, { recoverCommand = null } = {}) {
  return page("Sign in", `
<h1>Sign in</h1>
<p>This is a private afterwrd site. Sign in with your passkey.</p>
<button id="go">Sign in with a passkey</button>
<p id="error" role="alert"></p>
${recoverCommand ? `<details class="small" id="recover"><summary>Lost your device?</summary>
<p>On your server, run <code>${escape(recoverCommand)}</code> and open the link it gives you on this phone or computer.
Every device is signed out, and you make a new passkey here.</p></details>`
  : `<p class="small"><a href="/_auth/recover">Lost your device?</a></p>`}`, `
  // Words kept on this device while they were being written (ui.js) go once it's signed out, however that happened:
  // Sign out here, from another device, or the session running out. This may be a shared phone or computer.
  try { Object.keys(localStorage).filter((k) => k.startsWith("afterwrd-draft:")).forEach((k) => localStorage.removeItem(k)); } catch {}
  const next = ${JSON.stringify(next).replace(/</g, "\\u003c")};
  // Signed out: this browser's key goes too (a shared computer keeps nothing that signs). Signing in makes a new one,
  // which the same passkey prompt lets sign for the owner for 30 days (keys.js). A browser that can't make one
  // (no Ed25519) still signs in, just without it.
  signing().then(([, keys]) => keys.forgetKey()).catch(() => {});
  run(document.getElementById("go"), async () => {
    let made = null;
    try { made = await (await signing())[1].newBrowserKey(); } catch {}
    const { afterwrd, ...options } = await post("/_auth/login/options", made ? { browserKey: made.publicKey } : {});
    const credential = await navigator.credentials.get({ publicKey: {
      ...options, challenge: dec(options.challenge), allowCredentials: ids(options.allowCredentials) } });
    // This browser signs the delegation with its own key too, showing it holds the key the passkey lets sign.
    const possession = afterwrd && made ? await (await signing())[0].signAs("delegation", made.privateKey, (await signing())[0].fromB64url(afterwrd.delegation)) : null;
    const result = await post("/_auth/login/verify", { response: credentialJSON(credential), ...(afterwrd ? { delegation: afterwrd.delegation, possession } : {}) });
    if (result.signing && made) await (await signing())[1].keyAllowed(made, result.person, result.expires);
    // Signing isn't set up yet: on to the recovery code (keysPage), then where they were going.
    if (result.keys === "setup") return location.replace("/_admin/keys?next=" + encodeURIComponent(next));
    location.replace(next);
  });`);
}

// Lost every device you sign in with (recover.js): back in through the Cloudflare account the site is in.
export function recoverPage() {
  return page("Lost your device?", `
<h1>Lost your device?</h1>
<p>If you can't sign in on any of your phones or computers, you can add this one instead, as long as you can still sign
in to the Cloudflare account your site is in.</p>
<p>Cloudflare will ask you to let afterwrd change your Workers for an hour, as it does for an update. Your site uses
that once, to prove the account can change it (by making the version that's running live again, which changes
nothing), and keeps nothing.</p>
<p>Then every device signed in to your site is signed out, in case someone else has the one you lost, and you make a
passkey on this one. That replaces the passkeys on all your other devices: add any you find again from Your devices.</p>
<a class="button" href="/_auth/recover/start">Connect Cloudflare</a>
<p class="small">Can't sign in to Cloudflare either? Get back into Cloudflare first, from its own sign-in page (Forgot
password, or the backup codes it gave you when you turned on two-step sign-in), then come back here.</p>
<p class="small"><a href="/_auth/login">Back to sign in</a></p>`);
}

// A link to add one of the owner's devices (from Your devices, or setting up a new site).
export function deviceLinkPage(name) {
  return page("Add this device", `
<h1>Hello, ${escape(name)}</h1>
<p>Add this phone or computer to your afterwrd site by creating a passkey on it: it will ask for your face,
fingerprint or PIN. There's no password, and this link only works once.</p>
<button id="go">Create a passkey</button>
<p id="error" role="alert"></p>`, `
  const token = location.pathname.split("/").pop();
  const fromSetup = location.hash === "#setup";
  run(document.getElementById("go"), async () => {
    const options = await post("/_auth/register/options", { token });
    const credential = await navigator.credentials.create({ publicKey: {
      ...options, challenge: dec(options.challenge), user: { ...options.user, id: dec(options.user.id) },
      excludeCredentials: ids(options.excludeCredentials) } });
    const { first, signing: owned } = await post("/_auth/register/verify", { token, response: credentialJSON(credential) });
    // A site's first passkey: next, the recovery code and signing (keysPage), which then carries on as afterPasskey.
    if (first) return location.replace("/_admin/keys" + (fromSetup ? "#setup" : ""));
    // The owner signs what they post: a device that already signs lets this one, then one more prompt here (joinPage).
    if (owned) return location.replace("/_admin/keys/join");
    afterPasskey(false);
  });`);
}

/**
 * Setting up signing (afterwrd 2, keys.js): the recovery code, made here in the browser and shown once, then one passkey
 * prompt that signs the owner's first identity document and this browser's key together. Straight after a new site's
 * first passkey ("#setup": then on to its permissions, as afterPasskey), or at an older site's next sign-in. There's no
 * "Not now": without it the site can't reach anyone (app.js sends every page here until it's done).
 */
export function keysPage(next) {
  return page("Your recovery code", `
<style>.code { font: 600 1.35rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; padding: 14px 18px;
  background: var(--sunken); border: 1px solid var(--border); border-radius: 12px; word-break: break-all; }
  .tick { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0; } .tick input { width: auto; min-height: 0; margin-top: 4px; }
  .quiet { background: transparent; color: var(--text); border: 1px solid var(--border); }</style>
<h1>Your recovery code</h1>
<p>What you post and comment is now signed on your own devices, so nobody can change your words or put new ones in your
mouth: not other sites, and not whoever runs yours.</p>
<p>If you ever lose every device you sign in with, this code is how you show it's still you.</p>
<p class="code" id="code" aria-live="polite">…</p>
<p><button type="button" id="copy" class="quiet">Copy</button></p>
<p class="small">Write it down, or keep it in your password manager. Your site doesn't keep it, so nobody can tell you
what it was later.</p>
<label class="tick"><input type="checkbox" id="kept"> <span>I've kept my recovery code somewhere safe</span></label>
<button id="go" disabled>Continue</button>
<p id="error" role="alert"></p>
<p class="small" id="moving">Moving here from another afterwrd site? <a href="/_admin/import/move">Bring yourself over</a>
instead, and keep your recovery code, friends and posts.</p>`, `
  const next = ${JSON.stringify(next).replace(/</g, "\\u003c")};
  const fromSetup = location.hash === "#setup";
  (async () => {
    const [S, keys] = await signing();
    const code = S.newRecoveryCode();
    document.getElementById("code").textContent = code;
    document.getElementById("copy").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(code); e.target.textContent = "Copied"; } catch {}
    });
    const go = document.getElementById("go");
    document.getElementById("kept").addEventListener("change", (e) => { go.disabled = !e.target.checked; });
    run(go, async () => {
      const recovery = await S.recoveryKey(code);
      const key = await keys.newBrowserKey();
      const start = await post("/_admin/keys/start", { recovery: recovery.publicKey, browserKey: key.publicKey });
      const identity = S.fromB64url(start.identity), delegation = S.fromB64url(start.delegation);
      // What the passkey is about to sign must be this code's key and this browser's key.
      if (S.decode(identity)?.recovery !== recovery.publicKey || S.decode(delegation)?.key !== key.publicKey) {
        throw new Error("Something didn't match. Try again.");
      }
      const challenge = await S.statementsChallenge(start.nonce,
        [await S.fingerprintOf("identity", identity), await S.fingerprintOf("delegation", delegation)]);
      const credential = await navigator.credentials.get({ publicKey: { challenge: dec(challenge), userVerification: "required",
        allowCredentials: start.allow.map((id) => ({ type: "public-key", id: dec(id) })) } });
      const done = await post("/_admin/keys/finish", { identity: start.identity, delegation: start.delegation, response: credentialJSON(credential),
        possession: await S.signAs("delegation", key.privateKey, delegation) }); // this browser holds the key it names
      await keys.keyAllowed(key, done.person, done.expires);
      if (fromSetup) afterPasskey(true); else location.replace(next);
    });
  })().catch((e) => { document.getElementById("error").textContent = "This browser can't set up signing: " + e.message; });`);
}

/**
 * A new device, straight after making its passkey from a device link (keys.js): a device that already signs for the owner
 * lets it, from Your devices; this page waits for that, then one prompt lets this browser sign, as at sign-in.
 */
export function joinPage() {
  return page("One more step", `
<h1>One more step</h1>
<p>So that what you post and comment from this device is yours: on a phone or computer that already signs for you, open
Your devices and choose <b>Let it sign for you</b>.</p>
<p id="waiting" class="small">Waiting for that…</p>
<div id="ready" hidden>
<p>Done there. Now one more face, fingerprint or PIN here.</p>
<button id="go">Continue</button>
</div>
<p id="error" role="alert"></p>
<p class="small"><a href="/">Not now</a> (it can still sign in; let it sign later from Your devices)</p>`, `
  const until = Date.now() + 3600_000;
  (async function wait() {
    const now = await fetch("/_admin/keys/signing").then((r) => r.json()).catch(() => null);
    if (now?.thisSigns) {
      document.getElementById("waiting").hidden = true;
      document.getElementById("ready").hidden = false;
    } else if (Date.now() < until) setTimeout(wait, 3000);
  })();
  run(document.getElementById("go"), async () => {
    const [S, keys] = await signing();
    const key = await keys.newBrowserKey();
    const start = await post("/_admin/keys/browser/start", { browserKey: key.publicKey });
    const delegation = S.fromB64url(start.delegation);
    if (S.decode(delegation)?.key !== key.publicKey) throw new Error("Something didn't match. Try again.");
    const challenge = await S.statementsChallenge(start.nonce, [await S.fingerprintOf("delegation", delegation)]);
    const credential = await navigator.credentials.get({ publicKey: { challenge: dec(challenge), userVerification: "required",
      allowCredentials: start.allow.map((id) => ({ type: "public-key", id: dec(id) })) } });
    const done = await post("/_admin/keys/browser/finish", { delegation: start.delegation, response: credentialJSON(credential),
      possession: await S.signAs("delegation", key.privateKey, delegation) }); // this browser holds the key it names
    await keys.keyAllowed(key, done.person, done.expires);
    afterPasskey(false);
  });`);
}

/**
 * Agreeing to move, on the old site (afterwrd 2, step 4f: keys.js): a new site sent the owner here with a move request
 * its passkey signed (?move=…). One passkey prompt here signs the change of address, which waits 7 days; then back to
 * the new site, which carries on from there (move.js).
 */
export function moveOutPage() {
  return page("Move your site", `
<h1>Move your site</h1>
<p id="asking">One moment…</p>
<div id="offer" hidden>
<p>Your identity moves to <b id="to"></b>: from then, that's the site that signs for you, friends' sites find you there,
and your passkeys here stop signing.</p>
<p>It takes effect in <b>7 days</b>. Until then this site carries on as normal, and you can cancel from Your devices
here, or with your recovery code. Your friends' sites hear about it within the hour, so their 7 days start with yours.</p>
<p>On the day, you make a Download everything here and bring it into your new site, posts, comments and friends.</p>
<button id="go">Move to <span id="to-again"></span></button>
</div>
<p id="error" role="alert"></p>
<p class="small" id="done" hidden>Done. <a id="back" href="/">Back to your new site</a></p>
<p class="small" id="not-now"><a href="/">Not now</a></p>`, `
  const asked = new URLSearchParams(location.search).get("move") || "";
  let move = null;
  try { move = JSON.parse(new TextDecoder().decode(dec(asked))); } catch {}
  (async () => {
    if (!move?.request || !move.proof) throw new Error("This link isn't complete. Start again from your new site.");
    const { to } = await post("/_admin/keys/move/check", move);
    const where = new URL(to).host;
    document.getElementById("to").textContent = where;
    document.getElementById("to-again").textContent = where;
    document.getElementById("asking").hidden = true;
    document.getElementById("offer").hidden = false;
    run(document.getElementById("go"), async () => {
      const [S] = await signing();
      const start = await post("/_admin/keys/change/start", { change: "move", ...move });
      const doc = S.fromB64url(start.doc);
      // What the passkey is about to sign must be the move to that address.
      if (S.decode(doc)?.origin !== to) throw new Error("Something didn't match. Try again.");
      const challenge = await S.statementsChallenge(start.nonce, [await S.fingerprintOf("identity", doc)]);
      const credential = await navigator.credentials.get({ publicKey: { challenge: dec(challenge), userVerification: "required",
        allowCredentials: start.allow.map((id) => ({ type: "public-key", id: dec(id) })) } });
      await post("/_admin/keys/change/finish", { doc: start.doc, response: credentialJSON(credential) });
      document.getElementById("offer").hidden = true;
      document.getElementById("not-now").hidden = true;
      document.getElementById("back").href = to + "/_admin/import/move";
      document.getElementById("done").hidden = false;
      location.replace(to + "/_admin/import/move");
    });
  })().catch((e) => { document.getElementById("asking").hidden = true; document.getElementById("error").textContent = e.message; });`);
}

/** The end of a new site's setup, after its permissions (allowed or not): on to a friend's invitation, or Home. */
export function setupDonePage() {
  return page("One moment", `
<style>main { animation: appear 0s 0.5s both; } @keyframes appear { from { visibility: hidden; } }</style>
<p id="status">One moment…</p>`, `
  afterPasskey(false);`);
}

export function setupPage() {
  return page("Set up afterwrd", `
<h1>Your site is ready</h1>
<p id="given" hidden>It's yours, <b id="given-name"></b> (<a href="#" id="change">change your name</a>).</p>
<p id="name-box"><input id="name" placeholder="Your name" autocomplete="name" maxlength="100"></p>
<p>Now make a passkey on this device to sign in with: your face, fingerprint or device PIN. There's no password.
Then you can post, add photos and invite friends.</p>
<p id="hour-over" class="small" hidden>The installer's one-hour access ends by itself. It kept nothing.</p>
<button id="go">Continue</button>
<p id="error" role="alert"></p>`, `
  const code = new URLSearchParams(location.search).get("code");
  keepInvite();
  // The name they gave the installer, brought after the # (so no server saw it on the way).
  const given = (new URLSearchParams(location.hash.slice(1)).get("name") ?? "").trim().slice(0, 100);
  // Given already, it's shown rather than asked again, with a way to change it.
  if (given) {
    document.getElementById("name").value = given;
    document.getElementById("given-name").textContent = given;
    document.getElementById("given").hidden = false;
    document.getElementById("name-box").hidden = true;
    document.getElementById("change").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("given").hidden = true;
      document.getElementById("name-box").hidden = false;
      document.getElementById("name").focus();
    });
  }
  // Sent by the installer (which always brings the name): after the passkey, on to the site's lasting permissions.
  const fromInstaller = new URLSearchParams(location.hash.slice(1)).has("name");
  if (fromInstaller) document.getElementById("hour-over").hidden = false;
  // Off the address bar and out of history, so an abandoned setup doesn't leave the code lying around.
  history.replaceState(null, "", "/_auth/setup");
  run(document.getElementById("go"), async () => {
    const name = document.getElementById("name").value.trim();
    if (!name) throw new Error("Give your name.");
    const { link } = await post("/_auth/setup", { code, name });
    location.replace(fromInstaller ? link + "#setup" : link);
  });`);
}

export function signOutPage() {
  return page("Sign out", `
<h1>Sign out?</h1>
<p>You'll need your passkey to sign in again.</p>
<form method="post" action="/_auth/logout"><button>Sign out</button></form>`);
}

export function messagePage(message, link = { href: "/_auth/login", label: "Go to sign in" }) {
  return page("afterwrd", `<p>${escape(message)}</p><a class="button" href="${escape(link.href)}">${escape(link.label)}</a>`);
}

// Opened from a check link (checks.js): a friend's site asking to check this person's site, read-only, through
// Cloudflare. `result` is what a finished check found, and `by` the site that checked.
export function checkLinkPage({ owner, checker, site, fixed, result, by = null, reading = false }) {
  const style = `<style>
  .check-good { color: var(--moss); } .check-bad { color: var(--danger); }
  .check-good, .check-bad { margin: 0 0 14px; } .check-good b, .check-bad b { color: var(--text); }
  .check-files { margin: -6px 0 16px; padding-left: 1.2rem; color: var(--muted); font-size: 0.9rem; word-break: break-word; }
  .meta { font-size: 0.9rem; } main { max-width: 520px; }
  .check-who { color: var(--text); padding: 12px 16px; border-radius: 16px; background: var(--sunken); word-break: break-word; }
</style>`;
  if (result && !reading) return page("Site check", `${style}<h1>${escape(owner)}'s site checked yours</h1>\n${resultHtml(result, "yours", by)}`);
  return page("Check my site", `${style}
${reading ? `<p class="check-bad">This check didn't finish. Start it again:</p>` : ""}
<h1>${escape(owner)} would like to check your site</h1>
<p>${escape(owner)}'s afterwrd site (<b>${escape(checker)}</b>, the site this page is on) will look at your Cloudflare
account, read-only, for a moment. It downloads the code
your afterwrd site is running and compares it with the published release, and reads your account's log of changes
for anything afterwrd doesn't do. Cloudflare asks you to allow this. It can't change anything, and the access isn't kept.</p>
<form id="check">
  ${fixed ? `<p>Your site: <b>${escape(new URL(site).host)}</b></p>`
    : `<input name="site" value="${escape(site ? new URL(site).host : "")}" placeholder="e.g. jo.example.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">`}
  <p id="error" role="alert"></p>
  <button>Check my site</button>
</form>
<p class="meta" style="margin-top: 20px">Best done before you start using a new site, and again after updates.
<a href="https://afterwrd.app/check/">More about checking</a>.</p>`, `
  document.getElementById("check").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    button.disabled = true;
    document.getElementById("error").textContent = "";
    try {
      const { relay } = await post(location.pathname + "/start", { site: e.target.site?.value.trim() });
      location.assign(relay);
    } catch (err) {
      document.getElementById("error").textContent = err.message;
      button.disabled = false;
    }
  });`);
}

// Opened from a friend link (connect.js): someone wants to be friends. With a site already, they say where it is and
// confirm there. Without one, "Set up your own afterwrd" takes them to the installer carrying this link after the #
// (so neither the installer's server nor any other sees it); their new site then opens "Add … as a friend?" as soon
// as they've made their passkey. `installer`: install.afterwrd.app, or a stand-in when testing.
export function connectLinkPage(name, { invitedAs = null, installer = "https://install.afterwrd.app/" } = {}) {
  return page("Be friends", `
<style>main { max-width: 480px; } h2 { font: 900 1.15rem/1.3 var(--round); margin: 26px 0 6px; color: var(--text); }
  .meta { font-size: 0.9rem; } .secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }</style>
<h1>${escape(name)} would like to be friends</h1>
<p>${escape(name)} is on afterwrd: a small, private social network where everyone has their own site, free, in their
own Cloudflare account. Friends see each other's posts and photos, and nobody else does.</p>
<h2>New to afterwrd?</h2>
<p>Set up your own site: it takes a few minutes, on a phone or a computer. Once it's ready, you'll be friends with
${escape(name)} in one step.</p>
<a class="button" id="install" href="${escape(installer)}" data-name="${escape(invitedAs ?? "")}">Set up your own afterwrd</a>
<h2>Already have an afterwrd site?</h2>
<p>Copy this link, then open your own afterwrd site and paste it into <b>Add a friend</b>.</p>
<button id="copy-link">Copy this link</button>
<details class="meta" style="margin-top: 16px"><summary>Or type your site's address</summary>
<form id="site">
  <input name="site" placeholder="e.g. afterwrd.your-name.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">
  <p id="error" role="alert"></p>
  <button class="secondary">Continue on my site</button>
</form>
</details>
<p class="meta" style="margin-top: 16px">Opened this inside an app, like WhatsApp or Instagram? Open it in your
browser instead (usually in the app's ⋯ menu): passkeys often don't work inside apps.</p>`, `
  // The installer gets this link (and the name it was made for, to suggest an address) after the #.
  const install = document.getElementById("install");
  const carry = new URLSearchParams({ invite: location.origin + location.pathname });
  if (install.dataset.name) carry.set("name", install.dataset.name);
  install.href += "#" + carry.toString();
  document.getElementById("copy-link").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      e.target.textContent = "Copied: now paste it into Add a friend on your site";
    } catch {
      e.target.textContent = "Copy this page's address from the address bar instead";
    }
  });
  document.getElementById("site").addEventListener("submit", (e) => {
    e.preventDefault();
    let site = e.target.site.value.trim();
    if (!/^https?:\\/\\//.test(site)) site = "https://" + site;
    try {
      const origin = new URL(site).origin;
      location.assign(origin + "/_admin/connections/new?link=" + encodeURIComponent(location.origin + location.pathname));
    } catch {
      document.getElementById("error").textContent = "That doesn't look like a web address.";
    }
  });`);
}

// Opened from a group's invite link (groups.js). Sends them on to their own site to confirm, carrying the link.
export function groupLinkPage(group, owner) {
  return page("Join a group", `
<h1>Join ${escape(group)}</h1>
<p>${escape(owner)} has invited you to ${escape(group)}, a group on afterwrd. Its members read it from their own
afterwrd sites, and can post and comment there.</p>
<p>Copy this link, then open your own afterwrd site and paste it into <b>Groups</b>.</p>
<button id="copy-link">Copy this link</button>
<details class="meta" style="margin-top: 16px"><summary>Or type your site's address</summary>
<form id="site">
  <input name="site" placeholder="e.g. afterwrd.your-name.workers.dev" required autocomplete="url" inputmode="url" aria-label="Your site's address">
  <p id="error" role="alert"></p>
  <button>Continue on my site</button>
</form>
</details>
<p style="margin-top: 20px">No afterwrd site yet? <a href="https://afterwrd.app/">Set one up</a>, then paste this link into
<b>Groups</b> on it.</p>`, `
  document.getElementById("copy-link").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(location.href);
      e.target.textContent = "Copied: now paste it into Groups on your site";
    } catch {
      e.target.textContent = "Copy this page's address from the address bar instead";
    }
  });
  document.getElementById("site").addEventListener("submit", (e) => {
    e.preventDefault();
    let site = e.target.site.value.trim();
    if (!/^https?:\\/\\//.test(site)) site = "https://" + site;
    try {
      const origin = new URL(site).origin;
      location.assign(origin + "/groups/join?link=" + encodeURIComponent(location.href));
    } catch {
      document.getElementById("error").textContent = "That doesn't look like a web address.";
    }
  });`);
}
