// The owner's Update page (update.js): this version, the latest release and its notes, bringing groups up to date,
// and friends' sites checking this one.
import { nonce } from "../nonce.js";
import { connectLink } from "../cloudflare.js";
import { TOKENS_PAGE } from "../update.js";
import { escape } from "../util.js";
import { checkedWords, resultHtml } from "./checks.js";
import { asset, favicon, ownerHeader } from "./nav.js";

/** The Connect button for a step, or a note that it's done. */
function connectPart(connected, back, what, background = false) {
  if (connected) return `<p class="meta connected">Connected to Cloudflare for the next hour.</p>`;
  // Automatic updates' background access does it: nothing to connect.
  if (background) return `<p class="meta connected">This uses automatic updates' access, so there's no need to connect.</p>`;
  return `
<p><a class="button" id="connect" href="${escape(connectLink(back))}">Connect Cloudflare</a>
  <span class="meta">Cloudflare will ask you to <b>Allow</b> afterwrd ${what}, for one hour. Nothing is kept.</span></p>`;
}

const day = (seconds) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** A newer version's database update that failed (migrate.js), so the site stayed as it was. */
function problemPart(problem, version) {
  return problem ? `<p class="notice alert" id="update-problem">afterwrd ${escape(problem.version)} couldn't update your site's database on
  ${escape(day(problem.at))}. Nothing was lost: your site stayed on ${escape(version)}, as it was. Please send this to whoever
  looks after afterwrd: <code>${escape(problem.migration)}: ${escape(problem.error)}</code></p>` : "";
}

/** The versions this site has run, newest first. */
function historyPart(history) {
  return history.length ? `<section class="card" id="history">
  <h2>This site's updates</h2>
  <ul>${history.map((h) => `<li>${escape(day(h.at))}: afterwrd ${escape(h.version)}${h.from_version ? `, from ${escape(h.from_version)}` : ""}</li>`).join("")}</ul>
</section>` : "";
}

const ago = (seconds) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (m < 1) return "just now";
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 24 ? (h === 1 ? "an hour ago" : `${h} hours ago`) : day(seconds);
};
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Europe/London" })
  .replace(/\s/g, "").replace(":00", "");

/**
 * When automatic updates look for a release (the Worker's cron trigger, "M H * * *" in UTC, set at random when they
 * were turned on: auto.js), as {time: "8:13am", next: "today" | "tomorrow"} in UK time, or null.
 */
export function dailyLook(cron, at = Date.now()) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(cron ?? ""));
  if (!m) return null;
  const today = new Date(at);
  let next = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), Number(m[2]), Number(m[1]));
  if (next <= at) next += 86400 * 1000;
  const ukDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London" });
  return { time: clock(next), next: ukDay(next) === ukDay(at) ? "today" : "tomorrow" };
}

/** Automatic updates (auto.js): on or off, how and when they look, what last happened, and anything that needs the owner. */
function autoPart(auto, version, turnedOff = false) {
  // What went wrong last time. One that worked is only worth saying while it's the version running now.
  const last = auto.last?.result === "kept" ? `<p class="notice alert">afterwrd ${escape(auto.last.version)} didn't pass its
    checks on ${escape(day(auto.last.at))}, but it had already updated your site's database, so it stayed. If anything isn't
    working, please tell whoever looks after afterwrd.</p>`
    : auto.last && auto.last.result !== "done" ? `<p class="notice alert">afterwrd ${escape(auto.last.version)} didn't
    ${auto.last.result === "unhealthy" ? "work" : "start"} on your site on ${escape(day(auto.last.at))}, so your site went back to
    how it was. It'll wait for the next release.</p>`
    : auto.last && auto.last.version === version ? `<p class="meta" id="auto-done">It installed ${escape(version)} by itself on ${escape(day(auto.last.at))}.</p>` : "";
  const waiting = auto.waiting?.needsHand ? `<p class="notice alert">afterwrd ${escape(auto.waiting.version)} has to be installed
    by hand this time (it adds a new kind of storage, which Cloudflare won't let it add by itself). Use the button above.</p>`
    : auto.waiting?.version && auto.waiting.after && !auto.next ? `<p>afterwrd ${escape(auto.waiting.version)} will install itself after
    ${escape(day(auto.waiting.after))}.</p>` : "";
  const problem = auto.problem ? `<p class="notice alert">The last automatic update couldn't run: ${escape(auto.problem)}</p>` : "";
  const running = auto.running ? `<p class="notice" id="auto-running">It's looking for an update now (started ${escape(ago(auto.running))}).</p>` : "";
  const groupLines = Object.values(auto.groups ?? {}).filter((g) => g.result !== "done");
  const groupsDone = groupLines.length ? `<ul class="meta">${groupLines.map((g) => `<li>${escape(g.name)}: ${escape(
    g.result === "needs-hand" ? "has to be updated by hand (below)" : g.result.startsWith("error") ? `couldn't be updated: ${g.result.slice(7)}`
      : g.result === "kept" ? `failed its checks on ${g.version} after updating its database, so it was kept` : `didn't take ${g.version}, so it was put back`)}
    (${escape(day(g.at))})</li>`).join("")}</ul>` : "";
  if (auto.on) {
    const look = dailyLook(auto.cron);
    // When it looks, what it does, and what it last found, said once.
    const how = `Your site looks for a new afterwrd release once a day${look ? `, at about ${escape(look.time)}` : ""}, and installs it by
      itself${auto.early ? ", as soon as it's signed, because you're getting updates first"
      : " once it's been out for three days (one, for a security fix)"}. If one doesn't work, your site goes back to how it was.
      Your groups update with it.${auto.signed ? "" : " (No release is signed yet, so it's waiting for the first.)"}`;
    // Only a look since they were last turned on: one from before ("Cloudflare no longer allows…") is done with.
    const lastCheck = auto.lastCheck && !auto.running && !(auto.since && auto.lastCheck.at < auto.since) ? `<p id="auto-last">Last looked ${escape(ago(auto.lastCheck.at))}: ${escape(auto.lastCheck.words)}</p>` : "";
    return `
<section class="card" id="auto">
  <h2>Automatic updates are on</h2>
  ${running}${waiting}${last}${problem}${groupsDone}
  <p id="auto-how">${how} <a href="https://afterwrd.app/how-it-works/#install" target="_blank" rel="noopener">How it stays safe</a></p>
  ${lastCheck}
  ${auto.early ? `<form method="post" action="/_admin/update/early-off" id="early" class="meta"><button class="link">Wait the usual few days again</button></form>`
    : `<details class="other" id="early"><summary>Get updates first</summary>
    <p class="meta">For people helping to test afterwrd: your site installs each release as soon as it's signed, instead
    of waiting a few days. If a release has a problem, your site has it before anyone else's (and puts itself back as it
    was, if it can).</p>
    <form method="post" action="/_admin/update/early-on"><button class="link">Get updates first</button></form>
  </details>`}
  <form method="post" action="/_admin/update/auto-off" class="meta"><button class="link">Turn automatic updates off</button></form>
</section>`;
  }
  return `
<section class="card" id="auto">
  ${turnedOff ? `<p class="notice" id="auto-turned-off" role="status">Automatic updates are off. To be sure nothing can use their access,
    remove afterwrd in Cloudflare too: My Profile → Access Management → Connected Applications.</p>` : ""}
  <h2>Keep afterwrd up to date by itself</h2>
  ${problem}${auto.refusedAt ? `<p class="notice alert" id="auto-refused">They turned themselves off on ${escape(day(auto.refusedAt))},
    because Cloudflare stopped allowing them (perhaps they were removed in Cloudflare). Turn them on again below.</p>` : ""}
  <p>Your site can install new afterwrd releases by itself, so fixes reach you without coming here. Cloudflare will ask
  you to <b>Allow</b> it: leave <b>Background Access</b> ticked. It stays on until you turn it off here.</p>
  <details class="other"><summary>What exactly does it allow?</summary>
    <p class="meta">Lasting access to change your Workers, and nothing else: it can't touch your databases or your
    account's settings. <a href="https://afterwrd.app/how-it-works/#install" target="_blank" rel="noopener">More about updates</a></p></details>
  <p><a class="button" href="/_cloudflare/auto-start">Turn on automatic updates</a></p>
</section>`;
}

/**
 * While automatic updates are on, and a newer release is out: what they'll do with it, first, and "Install it now".
 */
function autoNext(auto, running) {
  const next = auto.next;
  if (next.unsigned && !next.after) {
    return `<p id="auto-next"><b>afterwrd ${escape(next.version)} is out.</b> It'll install itself once it's been signed with afterwrd's own key${auto.early ? "" : ", and has been out for a few days"}.</p>`;
  }
  const look = dailyLook(auto.cron);
  const atLook = look ? `at ${look.next === "today" ? "today's" : "tomorrow's"} look (about ${escape(look.time)})` : "at its next daily look";
  const when = next.failed ? "It didn't work on this site before, so it won't be tried again by itself."
    : next.after * 1000 > Date.now() ? `It'll install itself after ${escape(day(next.after))}, or you can install it now.`
    : `It'll install itself ${atLook}, or you can install it now.`;
  return `<p id="auto-next"><b>afterwrd ${escape(next.version)} is ready.</b> ${when}</p>
<p><button class="go" data-install-now${running ? " disabled" : ""}>${next.failed ? "Try it again" : "Install it now"}</button>
  <span class="meta">Your groups follow straight after. Your site carries on by itself, so this page can be closed.</span></p>
<ol class="log"></ol>
<p class="error" role="alert"></p>`;
}

/**
 * Friends' sites checking this one by themselves (friendchecks.js): that they do, or the offer to let them, and what a
 * check found. Everything else, done by hand or rarely, is folded away below it (see updatePage).
 */
function checksPart(grant, failure, attempts = []) {
  const found = failure ? `<div class="notice alert" id="check-failure"><p><b>${escape(failure.name)}'s site checked yours</b> on
    ${escape(day(failure.checked_at))}${failure.version ? ` (afterwrd ${escape(failure.version)})` : ""} and found something that needs a look:</p>
    <ul>${failure.problems.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>
    <p class="meta">If you didn't change anything in Cloudflare yourself, ask ${escape(failure.name)} about it, and see
    <a href="/help#checks">what to do</a>.</p></div>` : "";
  if (grant.on) return `${found}<p id="checks-on">Your friends' sites check yours by themselves now and then, and tell you if anything's wrong.</p>`;
  const names = attempts.map((a) => `${escape(a.name)}'s`);
  const tried = attempts.length ? `<p class="notice" id="check-attempts">${names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}
    ${attempts.length === 1 ? "site has" : "sites have"} tried to check yours lately (most recently on ${escape(day(attempts[0].at))}), but it isn't
    allowed yet.</p>` : "";
  return `${found}<div id="checks-off">${grant.problem ? `<p class="notice alert">Friends' sites can't check yours by themselves any more: ${escape(grant.problem)}</p>` : ""}${tried}
  <p><b>Let your friends' sites check yours by themselves.</b> Now and then, a friend's afterwrd site checks yours is the
  genuine afterwrd, and tells you if anything's wrong. It can only look, never change anything. Until you do, nobody can
  check your site. Cloudflare will ask you to <b>Allow</b> it: leave <b>Background Access</b> ticked.</p>
  <details class="other"><summary>What exactly does it allow?</summary>
    <p class="meta">Lasting access to read the code of every Worker in your Cloudflare account, and nothing else. Your
    site gives a friend's site that asks a one-hour, read-only pass from it.
    <a href="https://afterwrd.app/how-it-works/#checks" target="_blank" rel="noopener">More about checks</a></p></details>
  <p><a class="button" href="/_cloudflare/checks-start">Let friends check it</a></p></div>`;
}

/** Stopping friends' sites checking this one, once they do (folded away). */
function letOffPart(grant) {
  return grant.on ? `<p class="meta" id="let-off">Each check is read-only: your site hands a friend's site a pass to read its code
  for an hour.</p>
  <form method="post" action="/_admin/checks/let-off" class="meta"><button class="link">Stop letting them</button>, and then,
    to be sure, remove afterwrd in Cloudflare too: My Profile → Access Management → Connected Applications.</form>` : "";
}

/** This site's checks of its friends' sites (friendchecks.js), folded away. */
function checkingPart(auto, checking, results) {
  const verdictWords = { "all good": "all good", "needs a look": "found something that needs a look", "couldn't check": "couldn't check it" };
  const list = results.length ? `<ul class="friend-checks">${results.map((r) => `<li id="friend-check-${r.id}">
    <b>${escape(r.name)}</b>, ${escape(day(r.checked_at))}: ${escape(verdictWords[r.verdict] ?? r.verdict)}${r.verdict === "couldn't check" && r.result?.why
      ? ` <span class="meta">(${escape(r.result.why)})</span>` : ""}
    ${r.verdict === "needs a look" ? `<details${r.seen_at ? "" : " open"}><summary class="meta">What it found</summary>${resultHtml(r.result, "theirs")}
      ${r.seen_at ? "" : `<form method="post" action="/_admin/checks/found/${r.id}/seen?back=update"><button class="link">Put it away</button></form>`}</details>` : ""}
  </li>`).join("")}</ul>` : "";
  const how = !auto.on ? `<p class="meta">Your site checks your friends' sites by itself while automatic updates are on (above).</p>`
    : checking ? `<p class="meta">A few times a week, your site checks one of your friends' sites by itself, if they let it: that it's
      exactly the published afterwrd, and that nothing else has been put in its place since the last check.</p>
      <form method="post" action="/_admin/checks/checking-off" class="meta"><button class="link">Stop checking friends' sites</button></form>`
    : `<p class="meta">Your site doesn't check your friends' sites by itself.</p>
      <form method="post" action="/_admin/checks/checking-on" class="meta"><button class="link">Check them again</button></form>`;
  return `<div id="checking">
  <h3>Checking your friends' sites</h3>
  ${list}${how}
</div>`;
}

/** @param {Record<string, any> & { auto?: AutoState, checkGrant?: CheckGrant }} data */
export function updatePage({ owner, version: VERSION, latest, available, securityFix, connected, oldToken, groups, go, checked = null, auto = { on: false }, history = [], problem = null, madeGroups = 0, checkGrant = {}, checkFailure = null, checking = true, friendChecks = [], checkAttempts = [], me = null, turnedOff = false }) {
  // While automatic updates are on, they're the one way to update (signed releases only), unless a release has to be
  // installed by hand (a new kind of store): then the steps below, with their access.
  const byHand = !auto.on || !auto.next || (auto.waiting?.needsHand && auto.waiting.version === auto.next.version);
  // What updating by hand installs: with automatic updates on, the release they picked (signed, and the one that
  // needs installing by hand); otherwise the newest signed release.
  const offer = auto.on && auto.next && !auto.next.unsigned && byHand ? { tag: `v${auto.next.version}`, version: auto.next.version } : latest;
  // GitHub has a newer release than any signed one: named, but not offered until it's signed. Said once, as what
  // happens next (not beside "You have the latest version", which reads as a contradiction).
  const once = auto.on ? `Your site will install it by itself once it's signed with afterwrd's own key${auto.early ? "" : " and has been out a few days"}.`
    : "It'll be offered here once it's signed with afterwrd's own key, usually within a day.";
  const waitingSignature = latest.unsigned ? `<p class="meta" id="unsigned">afterwrd ${escape(latest.unsigned)} is out on GitHub too, waiting for its
  signature. ${once}</p>` : "";
  // Groups this site made that are behind it: brought up to this version, with the same connection.
  const groupsPart = groups.length && !available ? `
<section class="card" id="groups">
  <h2>Your groups</h2>
  <p>${groups.map((g) => `${escape(g.name)} (${escape(g.version)})`).join(", ")} ${groups.length === 1 ? "is" : "are"} behind your
  site. Bring ${groups.length === 1 ? "it" : "them"} up to ${escape(VERSION)}:</p>
  ${auto.on ? `<p class="meta">Automatic updates bring them up to date at the next daily look.</p>
  <p><button class="go" data-install-now${auto.running ? " disabled" : ""}>Update ${groups.length === 1 ? "it" : "them"} now</button></p>
  <ol class="log"></ol>
  <p class="error" role="alert"></p>` : `${connectPart(connected, "/_admin/update?go=groups", "to update your groups")}
  <p><button id="groups-go" data-groups="${escape(JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))))}">Update ${groups.length === 1 ? "the group" : "the groups"}</button></p>
  <ol id="group-log"></ol>
  <p id="group-error" role="alert"></p>`}
</section>` : "";
  // A token kept by a version before 0.20.0, which nothing uses any more.
  const forget = oldToken ? `
<section class="card" id="old-token">
  <p>An earlier version kept a Cloudflare API token on this site. afterwrd no longer needs one: updating now asks Cloudflare
  each time, for an hour. <button class="link" id="forget">Forget it</button>, then delete the token in Cloudflare too
  (<a href="${TOKENS_PAGE}" target="_blank" rel="noopener">My Profile → API Tokens</a>).</p>
  <p id="forget-error" role="alert"></p>
</section>` : "";
  const notes = latest.notes ? `<section class="card notes"><h2>What's new</h2><p>${escape(latest.notes)}</p></section>` : "";
  let body;
  if (latest.error) {
    body = `<p>Couldn't look for a newer version just now (${escape(latest.error)}). It'll try again later.</p>`;
  } else if (!available) {
    body = latest.unsigned ? `<p id="unsigned"><b>afterwrd ${escape(latest.unsigned)} is out</b>, waiting for its signature. ${once}</p>`
      : "<p>You have the latest version.</p>";
  } else if (!byHand) {
    // Automatic updates will install it: when, and "Install it now", first; what's in it after.
    body = `
${autoNext(auto, auto.running)}
${waitingSignature}
${securityFix ? `<p class="security"><b>It fixes a security problem</b> (in ${escape(securityFix)}), so it's worth updating soon.</p>` : ""}
${notes}`;
  } else {
    body = `
<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">On GitHub</a></p>
${waitingSignature}
${securityFix ? `<p class="security"><b>It fixes a security problem</b> (in ${escape(securityFix)}), so it's worth updating soon.</p>` : ""}
${notes}
<p class="meta">Updating keeps everything: your posts, photos, friends and devices.</p>
${byHand ? `${connectPart(connected, "/_admin/update?go=update", "to update your site", auto.on)}
<p><button id="go" data-tag="${escape(offer.tag)}" data-version="${escape(offer.version)}">Update to ${escape(offer.version)}</button>
  <span class="meta">Keep this page open until it says it's done. If the new version doesn't work, your site goes back to how it was.</span></p>
<ol id="log"></ol>
<p id="error" role="alert"></p>
<section id="done" class="card" hidden>
  <p><b>Updated to ${escape(offer.version)}.</b></p>
  <p><a class="button" href="/_admin/update">Done</a></p>
</section>` : ""}`;
  }
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Update · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${favicon()}
<style>
  /* This page's buttons are afterwrd's primary button (style.css .chip.primary). */
  .button, #go, #groups-go, button.go { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0.35rem 1.05rem; border: 0; border-radius: 999px;
    background: var(--button); color: var(--on-button); font: 800 0.92rem var(--round); text-decoration: none; cursor: pointer; }
  .button + .meta { display: block; margin-top: 0.4rem; }
  #go:disabled, #groups-go:disabled, button.go:disabled { opacity: 0.6; cursor: default; }
  #error, #group-error, #forget-error, .error { color: var(--danger); }
  .security { padding: 0.6rem 0.9rem; border-left: 3px solid var(--danger); border-radius: 10px; background: var(--tint-4); }
  #done[hidden], #done [hidden] { display: none; }
  .notes h2, #check h2, #auto h2 { margin: 0 0 0.4rem; font-size: 1rem; }
  .notes p { margin: 0; white-space: pre-wrap; }
  .other { margin: 1rem 0; }
  .other summary { cursor: pointer; color: var(--muted); }
  button.link { padding: 0; border: 0; background: none; color: var(--accent-strong); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
</head>
<body>
${ownerHeader("update", me)}
<main>
<h1>Update afterwrd</h1>
<p class="meta">Your site is on afterwrd ${escape(VERSION)}.</p>
${problemPart(problem, VERSION)}
${body}
${autoPart(auto, VERSION, turnedOff)}
${historyPart(history)}
<section class="card" id="check">
  <h2>Friends' checks</h2>
  <p id="last-checked">${checked ? escape(checkedWords(checked)) : "Your site hasn't been checked yet."}</p>
  ${checksPart(checkGrant, checkFailure, checkAttempts)}
  <details class="other" id="checks-more"${friendChecks.some((r) => r.verdict === "needs a look" && !r.seen_at) ? " open" : ""}>
  <summary>More about checks</summary>
  ${letOffPart(checkGrant)}
  ${checkingPart(auto, checking, friendChecks)}
  <form method="post" action="/_admin/checks/myself?back=update" class="meta">You can also <a href="https://afterwrd.app/check/">check
    it yourself</a> in Cloudflare's dashboard, and then <button class="link">say you've checked it</button>.</form>
  </details>
</section>
${groupsPart}
${forget}
</main>
<script nonce="${nonce()}">
  // A link to something folded away (Home's "See what it found", say) opens the fold it's in.
  const openFold = () => {
    let target = null;
    try { target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch {} // "#%E0"
    const fold = target?.closest("details");
    if (fold && !fold.open) { fold.open = true; target.scrollIntoView(); }
  };
  openFold();
  addEventListener("hashchange", openFold);
  const go = document.getElementById("go");
  const connected = ${connected || Boolean(auto.on)}; // automatic updates' access counts as connected
  const autoGo = ${JSON.stringify(go === "update" || go === "groups" ? go : null)};
  async function post(path, body) {
    const res = await fetch("/_admin/update/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const forget = document.getElementById("forget");
  if (forget) forget.addEventListener("click", async () => {
    if (!(await askFirst("Forget the old token? Afterwards, delete it in Cloudflare too.", { ok: "Forget it" }))) return;
    try {
      await post("forget", {});
      location.assign("${TOKENS_PAGE}");
    } catch (err) {
      document.getElementById("forget-error").textContent = "Couldn't forget it: " + err.message
        + " You can also delete the secret UPDATE_TOKEN in the Worker's settings in Cloudflare.";
    }
  });
  const groupsGo = document.getElementById("groups-go");
  if (groupsGo) groupsGo.addEventListener("click", async () => {
    const error = document.getElementById("group-error");
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("group-log").append(li); };
    error.textContent = "";
    if (!connected) { error.textContent = "Connect Cloudflare first."; return; }
    groupsGo.disabled = true;
    try {
      for (const group of JSON.parse(groupsGo.dataset.groups)) {
        log("Updating " + group.name + "…");
        let jwt = null; // a few files at a time (deploy.js FILES_AT_ONCE)
        for (let i = 0; i < 30 && !jwt; i++) ({ jwt } = await post("group-assets", { group: group.id }));
        if (!jwt) throw new Error("Couldn't finish copying afterwrd to your account. Try again in a minute.");
        await post("group-deploy", { group: group.id, jwt });
      }
      log("Done.");
    } catch (err) {
      error.textContent = err.message;
      groupsGo.disabled = false;
    }
  });
  if (go) go.addEventListener("click", async () => {
    const error = document.getElementById("error");
    const { tag, version } = go.dataset;
    const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
    error.textContent = "";
    if (!connected) { error.textContent = "Connect Cloudflare first."; return; }
    go.disabled = true;
    try {
      log("Checking your Cloudflare account…");
      const { account } = await post("check", { tag });
      log("Copying afterwrd " + version + " to your account…");
      let jwt = null; // a few files at a time (deploy.js FILES_AT_ONCE)
      for (let i = 0; i < 30 && !jwt; i++) ({ jwt } = await post("assets", { account, tag }));
      if (!jwt) throw new Error("Couldn't finish copying afterwrd to your account. Try again in a minute.");
      log("Installing " + version + " and checking it works (this can take a few minutes)…");
      await post("deploy", { account, tag, jwt });
      log("Waiting for the new version to start…");
      let started = false;
      // Cloudflare can take a few minutes to send visits to a new version (9 Nov 2026: over a minute), so up to three.
      for (let i = 0; i < 90 && !started; i++) {
        const res = await fetch("/_admin/update/version", { cache: "no-store" }).catch(() => null);
        started = Boolean(res && res.ok && (await res.json().catch(() => ({}))).version === version);
        if (!started) await new Promise((r) => setTimeout(r, 2000));
      }
      // Never "done" unless this site is the new version: an update that went somewhere else must say so.
      if (!started) throw new Error("Cloudflare has the update, but hasn't started using it yet. Don't update again:"
        + " reload this page in five minutes or so, and it should say " + version + ".");
      // The groups get the new version's code, so the new version's page brings them up to date, straight away.
      if (${madeGroups > 0} && connected) {
        log("Your site is on " + version + ". Now your groups…");
        location.assign("/_admin/update?go=groups");
        return;
      }
      document.getElementById("done").hidden = false;
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false;
    }
  });
  // "Install it now" (automatic updates on): the automatic run, straight away, showing what it does as it goes.
  document.querySelectorAll("button[data-install-now]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest("section") ?? document;
    const list = card.querySelector(".log");
    const error = card.querySelector(".error");
    const show = (lines) => { list.replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line }))); };
    document.querySelectorAll("button[data-install-now]").forEach((b) => { b.disabled = true; });
    button.textContent = "Installing…";
    error.textContent = "";
    show(["Starting…"]);
    let finished = false;
    const watch = (async () => {
      while (!finished) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch("/_admin/update/progress", { cache: "no-store" }).catch(() => null);
        const now = res && res.ok ? await res.json().catch(() => null) : null;
        if (!finished && now?.lines?.length) show(now.lines);
      }
    })();
    try {
      const res = await fetch("/_admin/update/install-now", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      if (data.busy) throw new Error("It's already installing something: reload this page in a few minutes to see what happened.");
      // The site carries on by itself (it doesn't need this page); this only watches until the run has finished.
      let state = null;
      for (let i = 0; i < 450; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const got = await fetch("/_admin/update/progress", { cache: "no-store" }).catch(() => null);
        state = got && got.ok ? await got.json().catch(() => null) : null;
        if (state?.lastRun >= data.asked && !state.running) break;
      }
      finished = true;
      await watch;
      if (!(state?.lastRun >= data.asked)) throw new Error("It's still going: this page can be closed, and the Update page will say what happened.");
      if (state.problem) throw new Error(state.problem);
      show([state.words || "Done."]);
      const done = document.createElement("p");
      done.append(Object.assign(document.createElement("a"), { className: "button", href: "/_admin/update", textContent: "Done" }));
      list.after(done);
    } catch (err) {
      finished = true;
      error.textContent = err.message;
      button.textContent = "Try again";
      document.querySelectorAll("button[data-install-now]").forEach((b) => { b.disabled = false; });
    }
  }));
  // Back from Connect (only from its own page here, never a link from elsewhere: security review 2026-11 L2): carry on
  // with what was asked for.
  const fromConnect = (() => { try { const r = new URL(document.referrer); return r.origin === location.origin && r.pathname.startsWith("/_cloudflare/"); } catch { return false; } })();
  if (connected && autoGo && fromConnect) {
    history.replaceState(null, "", "/_admin/update");
    (autoGo === "groups" ? groupsGo ?? document.querySelector("#groups button[data-install-now]") : go)?.click();
  }
</script>
</body>
</html>`;
}

/**
 * The Update page on a self-hosted site (hosting.js): this version, the newest release and its notes, and the commands
 * that update the server. Nothing here can update it: the server's owner pulls the new image.
 */
export function selfHostedUpdatePage({ version: VERSION, latest, available, securityFix, history = [], problem = null, me = null }) {
  const body = latest.error ? `<p>Couldn't look for a newer version just now (${escape(latest.error)}). It'll try again later.</p>`
    : !available ? `<p>You have the latest version.</p>`
    : `<p><b>afterwrd ${escape(latest.version)} is available.</b> <a href="${escape(latest.page)}" target="_blank" rel="noopener">On GitHub</a>
  (signed with afterwrd's own key)</p>
${securityFix ? `<p class="security"><b>It fixes a security problem</b> (in ${escape(securityFix)}), so it's worth updating soon.</p>` : ""}
${latest.notes ? `<section class="card notes"><h2>What's new</h2><p>${escape(latest.notes)}</p></section>` : ""}
<p>To update, on your server, in the folder with afterwrd's <code>compose.yaml</code>:</p>
<pre id="update-commands">docker compose pull
docker compose up -d</pre>
<p class="meta">Updating keeps everything: your posts, photos, friends and devices. Your groups on the same server update with it.</p>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Update · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${favicon()}
<style>
  .security { padding: 0.6rem 0.9rem; border-left: 3px solid var(--danger); border-radius: 10px; background: var(--tint-4); }
  .notes h2, #check h2 { margin: 0 0 0.4rem; font-size: 1rem; }
  .notes p { margin: 0; white-space: pre-wrap; }
  pre { overflow-x: auto; padding: 0.6rem 0.9rem; border-radius: 10px; background: var(--tint-4); }
</style>
</head>
<body>
${ownerHeader("update", me)}
<main>
<h1>Update afterwrd</h1>
<p class="meta">Your site is on afterwrd ${escape(VERSION)}, on your own server.</p>
${problemPart(problem, VERSION)}
${body}
${historyPart(history)}
<section class="card" id="check">
  <h2>Friends' checks</h2>
  <p>Your site is self-hosted, so friends' sites can't check it, and it can't check theirs. A check asks Cloudflare what's
  running on a site, and nothing outside your server can say what runs on it. Keeping it safe is up to you.</p>
</section>
</main>
</body>
</html>`;
}
