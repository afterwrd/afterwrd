// The owner's import page. The work happens in the browser (public/static/import/main.js): the export is read
// on this computer and only the ticked sections are uploaded.
import { asset, integrity, favicon, ownerHeader } from "./nav.js";
import { escape } from "../util.js";

const SECTION_CHOICES = [
  ["posts", "Posts", "Everything you've posted, with photos, links and places."],
  ["photos", "Photos & videos", "Your albums, and photos attached to posts and comments."],
  ["timeline", "Timeline", "Posts, comments and likes in date order."],
  ["comments", "Comments", "What you've said on other people's posts and photos."],
  ["likes", "Likes & reactions", "Whose posts you've liked, and when."],
  ["friends", "Friends", "Everyone you've interacted with, and when you became friends."],
  ["overview", "Overview", "Your profile, counts by year, and who you interact with most."],
];
const DEFAULT_ON = new Set(["posts", "photos"]);

export function importPage({ owner, me = null }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${favicon()}
<style>
  .pickers { display: grid; gap: 0.75rem; margin: 1rem 0; }
  .file-picker { display: block; background: var(--surface); border: 1px dashed var(--border); border-radius: 18px;
    padding: 0.9rem 1rem; cursor: pointer; }
  .file-picker:hover { border-color: var(--accent); }
  .file-picker strong { display: block; }
  .file-picker input { margin-top: 0.6rem; max-width: 100%; }
  fieldset { border: 1px solid var(--border); border-radius: 18px; background: var(--surface); padding: 0.6rem 1rem 0.8rem; margin: 0 0 1rem; }
  legend { font-weight: 600; padding: 0 0.3rem; }
  fieldset label { display: grid; grid-template-columns: auto 1fr; gap: 0 0.6rem; padding: 0.35rem 0; cursor: pointer; }
  fieldset label input { grid-row: span 2; align-self: start; margin-top: 0.3rem; }
  fieldset label span { color: var(--muted); font-size: 0.85rem; }
  /* The page's one button: afterwrd's primary button (style.css .chip.primary). */
  #go { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0.35rem 1.25rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button); font: 800 0.92rem var(--round); cursor: pointer; }
  #go:disabled { opacity: 0.6; cursor: default; }
  #progress[hidden] { display: none; }
  #progress progress { width: 100%; height: 0.7rem; margin: 0.5rem 0; }
  #steps { padding-left: 1.2rem; margin: 0.5rem 0; }
  #steps li { margin: 0.2rem 0; }
  #steps li.done { color: var(--muted); }
  #notes { color: var(--muted); font-size: 0.85rem; }
  #error { color: var(--danger); }
  #error:empty { display: none; }
</style>
</head>
<body>
${ownerHeader("import", me)}
<main>
<h1>Import your Facebook archive</h1>
<p class="meta">Moving here from another afterwrd site? <a href="/_admin/import/move">Bring everything over</a> instead.</p>
<p class="meta">Signed in as ${escape(owner)}. Choose the download Facebook gave you, in JSON format.
Your browser reads it on this computer and uploads only the sections you tick below. Importing replaces
what you imported before (never what you've posted on afterwrd); the old version stays until the new one is complete.</p>

<div class="pickers">
  <label class="file-picker"><strong>The zip file(s) from Facebook</strong>
    <span class="meta">Big archives come as several zips: choose them all.</span><br>
    <input type="file" id="zips" accept=".zip,application/zip" multiple></label>
  <label class="file-picker"><strong>…or the unzipped folder</strong>
    <input type="file" id="folder" webkitdirectory></label>
</div>

<fieldset>
  <legend>What to publish</legend>
  ${SECTION_CHOICES.map(([key, label, about]) => `
  <label><input type="checkbox" name="section" value="${key}" ${DEFAULT_ON.has(key) ? "checked" : ""}>
    ${label}<span>${about}</span></label>`).join("")}
  <p class="meta">Comments, likes and friends are mostly about other people, so they're off by default. Whatever
  you leave unticked stays on this computer.</p>
</fieldset>

<fieldset>
  <legend>Privacy</legend>
  <label><input type="checkbox" id="locations">
    Photo locations<span>Where photos were taken, from the map positions your phone saved in them, and the
    coordinates of check-ins. Off by default: they can show where you live. Place names you wrote in posts are kept
    either way.</span></label>
</fieldset>

<button id="go" disabled>Import and publish</button>
<p id="error" role="alert"></p>

<section id="progress" hidden>
  <ol id="steps"></ol>
  <progress id="bar" max="1" value="0"></progress>
  <p id="status" class="meta"></p>
  <ul id="notes"></ul>
</section>
</main>
<script src="/static/vendor/zip-2.24.0.min.js" integrity="${integrity("/static/vendor/zip-2.24.0.min.js")}"></script>
<script type="module" src="${asset("/static/import/main.js")}" integrity="${integrity("/static/import/main.js")}"></script>
</body>
</html>`;
}

// Moving a whole afterwrd site here (src/move.js, src/movein.js): first the owner's identity, by a change of address
// their old site signs, which waits 7 days; then everything else, from Download everything. The work happens in the
// browser (public/static/import/move.js).
const day = (at) => new Date(at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The identity half of the page, by where the move is up to (movein.js moveIn). */
function identityPart(site, moving, own) {
  if (own && !moving) {
    return `<p class="meta">This site has an identity of its own, so it can only take a download from a site that never set up
signing. To move a site with its identity, start from a new site.</p>`;
  }
  const old = moving ? escape(new URL(moving.from).host) : "";
  if (!moving) {
    return `<h2>1. Your old site</h2>
<p>Type its address. One face, fingerprint or PIN here asks to move; then you agree on your old site.</p>
<form id="ask"><input id="from" placeholder="you.example" autocomplete="url" aria-label="Your old site's address">
  <button class="chip primary">Ask to move</button></form>`;
  }
  if (moving.stage === "agree") {
    return `<h2>1. Agree on your old site</h2>
<p>Open <b>${old}</b>, signed in, and agree to move there. You'll come straight back here.</p>
<div class="row"><a class="chip primary" id="agree" href="${escape(moving.agree)}">Open ${old}</a>
  <button class="chip" data-move="check">I've agreed</button> <button class="chip" data-move="forget">Start again</button></div>`;
  }
  if (moving.stage === "cancelled") {
    return `<h2>The move was cancelled</h2>
<p>Your identity on ${old} doesn't say it's moving here any more: it was cancelled there.</p>
<div class="row"><button class="chip" data-move="forget">Start again</button></div>`;
  }
  if (moving.stage === "waiting") {
    return `<h2 id="waiting">Moving here on ${day(moving.at)}</h2>
<p>You've agreed on ${old}. Changes of address wait 7 days, so that if it wasn't you, you can cancel it there, from Your
devices, or with your recovery code. Your friends' sites are told meanwhile.</p>
<p>${old} carries on as normal until then. On ${day(moving.at)}, make a Download everything there and bring it in here,
below.</p>
<div class="row"><button class="chip" data-move="check">Check again</button></div>`;
  }
  return `<p id="moved-here"><strong>Your identity has moved here from ${old}.</strong> Now bring everything over.</p>`;
}

export function movePage({ me = null, site, moving = null, own = false }) {
  const ready = !moving || moving.stage === "ready";
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Move here · afterwrd</title>
<link rel="stylesheet" href="${asset("/static/style.css")}">
${favicon()}
<style>
  .file-picker { display: block; background: var(--surface); border: 1px dashed var(--border); border-radius: 18px;
    padding: 0.9rem 1rem; margin: 1rem 0; cursor: pointer; }
  .file-picker:hover { border-color: var(--accent); }
  .file-picker strong { display: block; }
  .file-picker input { margin-top: 0.6rem; max-width: 100%; }
  /* The page's one button: afterwrd's primary button (style.css .chip.primary). */
  #go { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0.35rem 1.25rem; border: 0; border-radius: 999px; background: var(--button); color: var(--on-button); font: 800 0.92rem var(--round); cursor: pointer; }
  #go:disabled { opacity: 0.6; cursor: default; }
  #ask { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  #ask input { flex: 1; min-width: 12rem; }
  #progress[hidden] { display: none; }
  #progress progress { width: 100%; height: 0.7rem; margin: 0.5rem 0; }
  #steps { padding-left: 1.2rem; margin: 0.5rem 0; }
  #steps li { margin: 0.2rem 0; }
  #steps li.done { color: var(--muted); }
  #error { color: var(--danger); }
  #error:empty { display: none; }
</style>
</head>
<body>
${ownerHeader("import", me)}
<main>
<h1>Move here from another afterwrd site</h1>
<p>Bring yourself over from your old site to this one (${escape(new URL(site).host)}): who you are, so your friends'
sites know it's you; your friends; your posts, photos and videos, albums, comments (yours and friends'), polls and
events; and your Facebook archive.</p>
<section id="identity">${identityPart(site, moving, own)}</section>
<p id="error" role="alert"></p>
${ready ? `<section id="everything">
<h2>${moving ? "2. " : ""}Bring everything over</h2>
<ol>
  <li>Make sure both sites run the same version of afterwrd: update whichever is older.</li>
  <li>On your old site, open <strong>Download everything</strong>, leave <strong>Include photos and videos</strong> ticked,
    and download.</li>
  <li>Choose that zip file here.</li>
</ol>
<p class="meta">Only a new site can take a move: one with nothing posted, imported or connected yet.</p>
<p class="meta"><strong>Groups don't come with it.</strong> Ask your groups to invite this site once you've moved. Your old
site stays, saying where you've gone, until you delete it.</p>
<p class="meta"><strong>Only move your own download.</strong> Whatever is in the zip becomes this site's, comments
in friends' names included (though any signed by them must check), so a file someone sent you could put words in
other people's mouths.</p>

<label class="file-picker"><strong>Your Download everything zip</strong>
  <input type="file" id="zip" accept=".zip,application/zip"></label>

<button id="go" disabled>Move everything here</button>

<section id="progress" hidden>
  <ol id="steps"></ol>
  <progress id="bar" max="1" value="0"></progress>
  <p id="status" class="meta"></p>
</section>
</section>` : ""}
</main>
<script src="/static/vendor/zip-2.24.0.min.js" integrity="${integrity("/static/vendor/zip-2.24.0.min.js")}"></script>
<script type="module" src="${asset("/static/import/move.js")}" integrity="${integrity("/static/import/move.js")}"></script>
</body>
</html>`;
}
