// Your devices (admin.js): the owner's passkeys, adding a device with a one-hour link, signing out everywhere, and
// notifications: turning them on for this device, and the devices that have them.
import { nonce } from "../nonce.js";
import { escape } from "../util.js";
import { asset, favicon, integrity, ownerHeader } from "./nav.js";

function day(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

/** What a change to the owner's identity that's waiting does, in words (keys.js identitySummary). */
export function identityChange(pending) {
  // A move (keys.js): the passkeys change too, but the address is what matters.
  if (pending.moving) return `you're moving to ${new URL(pending.moving).host}, and your new site's passkey will sign for you instead`
    + (pending.byRecovery ? " (asked with your recovery code)" : "");
  const n = (count, one) => `${count} ${one}${count === 1 ? "" : "s"}`;
  const parts = [
    pending.removed.length && `${n(pending.removed.length, "passkey")} will stop signing for you`,
    pending.added.length && `${n(pending.added.length, "passkey")} will start signing for you`,
    pending.recovery && "your recovery code will change",
  ].filter(Boolean);
  return (parts.join(", and ") || "your identity will change") + (pending.byRecovery ? " (asked with your recovery code)" : "");
}

/**
 * Notifications on this device (push.js; public/static/notifications.js does the asking): only for invitations,
 * changes to events the owner hasn't said no to, and mentions. Without scripts it only says it's checking.
 */
function notificationsSwitch(pushKey) {
  return `<section class="card notify" id="notify" data-key="${escape(pushKey ?? "")}">
  <h3>This device</h3>
  <p id="notify-status">Checking this device…</p>
  <div class="row">
    <button class="chip primary" data-do="on" hidden>Turn on notifications</button>
    <button class="chip" data-do="off" hidden>Turn them off</button>
  </div>
  <label id="notify-preview" hidden><input type="checkbox"> Show what it's about on the lock screen (otherwise just who it's from)</label>
  <label id="notify-mentions" hidden><input type="checkbox"> Mentions too (otherwise only events)</label>
  <p class="meta" id="notify-android" hidden>If they only turn up when you unlock your phone, Android is saving battery: set
  Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's notifications
  come through Chrome.</p>
  <p class="error" id="notify-error" role="alert"></p>
</section>
<script src="${asset("/static/notifications.js")}" integrity="${integrity("/static/notifications.js")}" type="module"></script>`;
}

export function devicesPage({ owner, passkeys, openLinks, sessions, notifying = [], me = null, identity = null, thisCredential = null, pushKey = null }) {
  const signs = (id) => Boolean(identity?.signing.includes(id));
  const thisSigns = signs(thisCredential);
  const pending = identity?.pending ?? null;
  const status = (k) => {
    if (!identity) return "";
    if (pending?.removed.includes(k.id)) return `, stops signing for you on ${day(pending.at)}`;
    if (pending?.added.includes(k.id)) return `, starts signing for you on ${day(pending.at)}`;
    return signs(k.id) ? ", signs for you" : ", can sign in, but can't sign for you yet";
  };
  const canLet = Boolean(identity && thisSigns && !pending);
  const notSigning = passkeys.filter((k) => !signs(k.id)).length;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your devices · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${favicon()}
<style>
  .devices { list-style: none; margin: 0 0 1.25rem; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .devices li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .devices strong { font-family: var(--round); }
  #link { display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; margin: 0 0 1.25rem; }
  #link[hidden] { display: none; }
  #link input { width: 100%; font: inherit; font-size: 0.9rem; padding: 0.55rem 0.95rem; border: 1px solid var(--border); border-radius: 999px; background: var(--sunken); color: var(--text); }
  #link p { margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.25rem; }
  #error { color: var(--danger); font-weight: 700; }
  #error:empty { display: none; }
  .code { font: 600 1.2rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; word-break: break-all; margin: 0; }
  #recovery-form { display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; }
  #recovery-form input[type=text] { width: 100%; font: inherit; padding: 0.55rem 0.95rem; border: 1px solid var(--border); border-radius: 999px; background: var(--sunken); color: var(--text); }
</style>
</head>
<body>
${ownerHeader("devices", me)}
<main>
<h1>Your devices</h1>
<p class="meta">Signed in as ${escape(owner)}. Each phone or computer you use has its own passkey. To add one, make a
link here and open it on that device: it works once, for an hour, and gives owner access, so open it only on your own.</p>
<p id="error" role="alert"></p>
<div class="row"><button class="chip primary" id="new-link">Add a device</button></div>
<section class="card" id="link" hidden>
  <strong>Open this on your other device</strong>
  <input id="link-url" readonly aria-label="Link to add a device">
  <div class="row"><button class="chip primary" id="copy">Copy link</button><button class="chip" id="share" hidden>Share…</button></div>
  <p class="meta" id="link-note"></p>
</section>
<ul class="devices">
  ${passkeys.map((k, i) => `<li class="card" data-credential="${escape(k.id)}"><span><strong>Passkey ${i + 1}</strong>${k.id === thisCredential ? " (this device)" : ""}<span class="meta"> · added ${day(k.created_at)}${k.last_used_at ? `, last used ${day(k.last_used_at)}` : ""}${status(k)}</span></span>
    ${passkeys.length > 1 ? `<button class="chip danger" data-action="delete-passkey" data-credential="${escape(k.id)}">Remove</button>` : ""}</li>`).join("")}
</ul>
${canLet ? `<div class="row" id="let-sign"${notSigning ? "" : " hidden"}><button class="chip primary" data-sign="allow">${notSigning > 1 ? "Let them sign for you" : "Let it sign for you"}</button></div>` : ""}
<div class="row">
  ${openLinks ? `<button class="chip" data-action="cancel-links">Cancel ${openLinks} unused link${openLinks === 1 ? "" : "s"}</button>` : ""}
  ${sessions ? '<button class="chip" data-action="sign-out">Sign out everywhere</button>' : ""}
</div>
<h2>Signing</h2>
${!identity ? `<p class="meta">What you post and comment isn't signed yet. <a href="/_admin/keys?next=/_admin">Set up signing</a>:
it takes your recovery code and one face, fingerprint or PIN.</p>` : `
<p class="meta">What you post and comment is signed on the devices above that sign for you, so nobody can change your
words. ${thisSigns ? "This device's passkey signs for you." : "This device can't sign for you yet: let it from one that does, or use your recovery code below."}</p>
${thisSigns ? `<div class="notice browser-sign" data-browser-sign hidden><p>This browser can't sign what you write yet, so you can't post
  or comment from it. One face, fingerprint or PIN lets it.</p>
  <div class="row"><button class="chip primary">Let this browser sign</button></div><p class="error" role="alert"></p></div>
<script type="module" src="${asset("/static/ui/letsign.js")}" integrity="${integrity("/static/ui/letsign.js")}"></script>` : ""}
${pending ? `<section class="card" id="identity-change"><strong>Waiting until ${day(pending.at)}</strong>
  <p>${escape(identityChange(pending))}. If that wasn't you, cancel it.</p>
  <div class="row">${!pending.byRecovery && thisSigns ? '<button class="chip danger" data-sign="cancel">Cancel it</button>' : ""}
  <span class="meta">${pending.byRecovery ? "Only your recovery code can cancel this:" : "Or with your recovery code:"} below.</span></div></section>` : ""}
<details class="card" id="recovery"><summary><strong>Your recovery code</strong></summary>
  ${thisSigns && !pending ? `<p class="meta">Lost it, or think someone else has seen it? Make a new one. Your old code keeps working for 7 days.</p>
  <div class="row"><button class="chip" data-sign="new-code">Make a new recovery code</button></div>
  <div id="new-code" hidden><p class="code" id="new-code-text"></p>
    <p class="meta">Write it down, or keep it in your password manager. Your site doesn't keep it.</p>
    <div class="row"><button class="chip primary" data-sign="new-code-kept">I've kept it: use this code</button></div></div>` : ""}
  <form id="recovery-form"><p class="meta">${pending
    ? "Type your recovery code to cancel the change that's waiting."
    : "Lost every device that signs for you? Type your recovery code to make the passkeys here the ones that sign for you. It takes effect after 7 days, and your other devices are told, in case it isn't you."}</p>
    <input type="text" id="recovery-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Recovery code">
    <button class="chip" data-recovery="${pending ? "cancel" : "devices"}">${pending ? "Cancel the change" : "Use my recovery code"}</button></form>
</details>`}
<h2 id="notifications">Notifications</h2>
<p class="meta">Only when a friend invites you to an event, an event you haven't said no to changes or is called off,
or someone mentions you (or writes @here in a group you're in): never for other posts, comments or anything else.
Each phone or computer is turned on by itself, here, on that device.</p>
${notificationsSwitch(pushKey)}
<h3>Devices they're on for</h3>
<p class="meta">Removing the passkey a device was signed in with, or signing out there, turns them off too.</p>
${notifying.length ? `<ul class="devices" id="notifying">
  ${notifying.map((d) => `<li class="card"><span><strong>${escape(d.name)}</strong><span class="meta"> · on since ${day(d.created_at)}${d.preview ? ", showing events on the lock screen" : ", showing only who they're from"}${d.last_ok_at ? `, last sent ${day(d.last_ok_at)}` : ""}</span></span>
    <form method="post" action="/_admin/notifications/${Number(d.id)}/forget" data-confirm="Turn off notifications on this device?" data-confirm-ok="Turn off"><button class="chip danger">Turn off</button></form></li>`).join("")}
</ul>` : '<p id="notifying">None.</p>'}
</main>
<script nonce="${nonce()}">
  const error = document.getElementById("error");
  const linkUrl = document.getElementById("link-url");
  async function post(path, body) {
    error.textContent = "";
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  document.getElementById("new-link").addEventListener("click", async () => {
    try {
      linkUrl.value = (await post("/_admin/devices/link")).link;
      document.getElementById("link").hidden = false;
      linkUrl.select();
      // On a device that signs: once the new device has its passkey, it can be let sign from here (the module below).
      if (window.afterwrdSigning) window.afterwrdSigning.watch();
    } catch (err) { error.textContent = err.message; }
  });
  const confirmations = {
    "delete-passkey": "Remove this passkey? The device it's on will be signed out and won't be able to sign in again.",
    "sign-out": "Sign out on every device, this one included? You can sign straight back in with a passkey.",
  };
  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const ask = confirmations[button.dataset.action];
    if (ask && !(await askFirst(ask, { ok: button.dataset.action === "sign-out" ? "Sign out" : "Remove" }))) return;
    try {
      // A passkey that signs for the owner stops signing too, after 7 days (a signed change: the module below).
      if (button.dataset.action === "delete-passkey" && window.afterwrdSigning) await window.afterwrdSigning.removing(button.dataset.credential);
      await post("/_admin/devices/" + button.dataset.action, { credential: button.dataset.credential });
      location.assign(button.dataset.action === "sign-out" ? "/_auth/login" : "/_admin");
    } catch (err) { error.textContent = err.message; }
  });
  document.getElementById("copy").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(linkUrl.value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy link"; }, 1500);
  });
  const share = document.getElementById("share");
  if (navigator.share) {
    share.hidden = false;
    share.addEventListener("click", () => navigator.share({ title: "Add a device to afterwrd", url: linkUrl.value }).catch(() => {}));
  }
</script>
${identity ? `<script type="application/json" id="signing-data">${JSON.stringify({ identity, thisSigns, passkeys: passkeys.map((k) => k.id) }).replace(/</g, "\\u003c")}</script>
<script type="module" nonce="${nonce()}">
  // Changing the owner's identity (keys.js): a passkey that signs for them, or their recovery code, signs each change.
  import * as S from ${JSON.stringify(asset("/static/signed.js"))};
  import { passkeySigns } from ${JSON.stringify(asset("/static/passkey.js"))};
  const { identity, thisSigns, passkeys } = JSON.parse(document.getElementById("signing-data").textContent);
  const error = document.getElementById("error");
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  async function change(body) {
    const start = await post("/_admin/keys/change/start", body);
    const response = await passkeySigns(start.nonce, [await S.fingerprintOf("identity", S.fromB64url(start.doc))], start.allow);
    return post("/_admin/keys/change/finish", { doc: start.doc, response });
  }
  const cancelled = (e) => e?.name === "NotAllowedError";
  window.afterwrdSigning = {
    /** After making a link: waits for the new device's passkey, then offers to let it sign for the owner. */
    watch() {
      const note = document.getElementById("link-note");
      if (!thisSigns || identity.pending) {
        note.textContent = "Once it's added it can sign in. To let it sign for you, come back to Your devices on a device that does.";
        return;
      }
      note.textContent = "Once it has its passkey, it shows here, and you can let it sign for you.";
      const until = Date.now() + 3600_000;
      (async function poll() {
        const now = await fetch("/_admin/keys/signing").then((r) => r.json()).catch(() => null);
        const added = (now?.passkeys ?? []).filter((id) => !passkeys.includes(id) && !now.signing.includes(id));
        if (added.length) {
          note.textContent = "Your new device has its passkey. Let it sign for you, then press Continue on it.";
          document.getElementById("let-sign").hidden = false;
        } else if (Date.now() < until) setTimeout(poll, 3000);
      })();
    },
    /** Before a passkey is removed from signing in: if it signs for the owner, it stops, after 7 days. */
    async removing(credential) {
      if (thisSigns && !identity.pending && identity.signing.includes(credential)) await change({ change: "remove", credential });
    },
  };
  let newCode = null;
  document.querySelector("main").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-sign], button[data-recovery]");
    if (!button) return;
    e.preventDefault();
    error.textContent = "";
    try {
      if (button.dataset.sign === "new-code") {
        newCode = S.newRecoveryCode();
        document.getElementById("new-code-text").textContent = newCode;
        document.getElementById("new-code").hidden = false;
        return;
      }
      if (button.dataset.sign === "new-code-kept") {
        await change({ change: "recovery", recovery: (await S.recoveryKey(newCode)).publicKey });
      } else if (button.dataset.sign) {
        await change({ change: button.dataset.sign });
      } else {
        const key = await S.recoveryKey(document.getElementById("recovery-code").value);
        if (!key) throw new Error("That isn't a recovery code: five groups of five letters and numbers.");
        const start = await post("/_admin/keys/recover/start", { change: button.dataset.recovery });
        const signature = await S.signAs("identity", key.privateKey, S.fromB64url(start.doc));
        await post("/_admin/keys/recover/finish", { doc: start.doc, signature });
      }
      location.reload();
    } catch (err) { error.textContent = cancelled(err) ? "Cancelled." : err.message; }
  });
</script>` : ""}
</body>
</html>`;
}
