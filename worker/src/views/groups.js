// Groups, each its own Worker, read from there (membership.js, groupcopies.js): a group's posts, photos and members,
// making, joining and closing one. Views only draw: they read nothing and change nothing.
import { connectLink } from "../cloudflare.js";
import { closedGroup } from "../groups.js";
import { fmtDate, fmtDatetime } from "./format.js";

import { asset, icon } from "./nav.js";
import { host } from "../sites.js";
import { html, raw } from "./html.js";
import { faceFor } from "./friends.js";
import { mentionData, page } from "./layout.js";
import { composer, feed } from "./parts.js";
import { groupItemCard, groupItemEventForm, signedGroupPhoto as itemPhotoPage } from "./items.js";

// --- groups, each its own Worker, read from there (membership.js) -----------------------------------------------------

export const groupBase = (g) => `/groups/${g.id}`;
const runs = (g) => g.role === "owner" || g.role === "admin";
const ROLE_NAMES = { owner: "Owner", admin: "Admin" };

/** Where a group lives and who runs it, in a few words; and whether it's closed, or from before signing. */
function groupWhere(g) {
  const shut = closedGroup(g);
  const where = g.role === "owner" ? html`Your group, at ${host(g.origin)}` : html`${g.host_name}'s group, at ${host(g.origin)}`;
  return html`${where}${!g.identity ? " · from before signing" : shut ? ` · closed${shut.goes > Date.now() / 1000 ? `, goes ${fmtDate(shut.goes)}` : ""}` : ""}`;
}

/** The owner's groups, starting one, and joining one with an invite link. */
export function groupsIndexPage(ctx, { groups, unfinished = [], connected = false }) {
  return page(ctx, "Groups", html`
<div class="feed-head">
  <h1>Groups</h1>
  <a class="chip primary" href="/groups/new">${raw(icon("groups"))}<span>Start a group</span></a>
</div>
<form class="filters" id="join" action="/groups/join" method="get">
  <input type="search" name="link" placeholder="Got a link to join a group? Paste it here" required autocomplete="off" aria-label="A group's invite link">
  <button type="button" class="chip" id="join-paste" hidden>Paste</button>
  <button>Join</button>
</form>
<script>
  // Paste in one tap where the browser allows reading what was copied (it may ask first).
  const joinPaste = document.getElementById("join-paste");
  if (navigator.clipboard?.readText) {
    joinPaste.hidden = false;
    joinPaste.addEventListener("click", async () => {
      const box = document.querySelector("#join input[name=link]");
      try { box.value = (await navigator.clipboard.readText()).trim(); } catch { box.focus(); return; }
      if (box.value) document.getElementById("join").requestSubmit();
    });
  }
</script>
<p class="meta">Each group is its own small site, kept by whoever started it alongside their own. Its members read it
from their own sites, and post and comment there. You're told about comments on posts you wrote or commented on; for
anything else, open the group. What's coming up in your groups is on <a href="/events">Events</a>, with your friends'
events and your own.</p>
${groups.length ? html`<ul class="group-list">
  ${groups.map((g) => html`<li><a class="card" href="${groupBase(g)}">
    <span class="icon-tile" aria-hidden="true">${raw(icon("groups"))}</span>
    <span class="what"><strong>${g.name}</strong><span class="meta">${groupWhere(g)}</span></span>
    ${ROLE_NAMES[g.role] && html`<span class="badge as-written">${ROLE_NAMES[g.role]}</span>`}
    ${g.notes > 0 && html`<span class="badge badge-new as-written">${g.notes} new</span>`}
  </a></li>`)}
</ul>` : html`<p class="empty">You're not in any groups yet.</p>`}
${unfinished.length > 0 && html`<section class="card" id="unfinished">
  <h2>Not finished setting up</h2>
  <p class="meta">Starting ${unfinished.length === 1 ? "this group" : "these groups"} stopped partway. Finish setting up, or
  delete what was made in your Cloudflare account.</p>
  <ul class="member-list">${unfinished.map((g) => html`<li class="card member">
    <span class="what"><strong>${g.name}</strong><span class="meta">${host(g.origin)}</span></span>
    <div class="actions-row"><button class="chip primary" data-finish="${g.id}">Finish setting up</button>
      <button class="chip" data-delete="${g.id}">Delete</button></div>
  </li>`)}</ul>
  ${connectField(connected, "to delete what was made", "/groups")}
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</section>
<script>${raw(STEP_SCRIPT)}
  document.getElementById("unfinished").addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-finish], button[data-delete]");
    if (!button || (button.dataset.delete && !(await askFirst("Delete this group's Worker and database from your Cloudflare account?", { ok: "Delete" })))) return;
    button.disabled = true;
    error.textContent = "";
    try {
      if (button.dataset.delete) {
        log("Deleting…");
        await post("/_groups/" + button.dataset.delete + "/delete", {});
        location.reload();
        return;
      }
      const id = Number(button.dataset.finish);
      log("Waiting for it to answer…");
      for (let i = 0; i < 20 && !(await post("/_groups/create/wait", { id })).ready; i++) await new Promise((r) => setTimeout(r, 2000));
      log("Setting it up as yours…");
      const claimed = (await post("/_groups/create/claim", { id })).id;
      await signGroup(claimed);
      location.assign("/groups/" + claimed + "/members");
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
</script>`}`);
}

/**
 * What a step that changes the owner's Cloudflare account needs: their connection from Connect (an hour's token,
 * cloudflare.js), coming back to `back` once Cloudflare's said yes.
 */
function connectField(connected, purpose, back) {
  return connected ? html`<p class="meta">Connected to Cloudflare for the next hour, ${purpose}.</p>`
    : html`<p class="meta"><a class="chip primary connect" href="${connectLink(back)}">Connect Cloudflare</a>
    Cloudflare asks you to allow afterwrd to change Workers and databases in your account, for an hour, ${purpose}. Nothing is kept afterwards.</p>`;
}

// The small script both group pages that call Cloudflare use: post JSON, and say how it went.
const STEP_SCRIPT = `
  const error = document.getElementById("error");
  const log = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("log").append(li); };
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  // afterwrd 2 (groupidentity.js): once its site is claimed, one face, fingerprint or PIN signs the group's identity
  // as yours.
  async function signGroup(id) {
    log("Signing it as yours…");
    const [S, { passkeySigns }] = await Promise.all([import(${JSON.stringify(asset("/static/signed.js"))}), import(${JSON.stringify(asset("/static/passkey.js"))})]);
    const start = await post("/_groups/" + id + "/identity/start", {});
    const response = await passkeySigns(start.nonce, [await S.fingerprintOf("identity", S.fromB64url(start.doc))], start.allow);
    await post("/_groups/" + id + "/identity/finish", { doc: start.doc, response });
  }`;

/** Starting a group: name it, and this site makes its Worker (groupsites.js), step by step. */
export function groupNewPage(ctx, { connected, domain, maxPhotos, selfHosted = false, command = "" }) {
  if (selfHosted) return selfHostedGroupNewPage(ctx, { maxPhotos, command });
  return page(ctx, "Start a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Start a group</h1>
<p>A group is its own small site in your Cloudflare account, separate from yours: it holds the group and nothing else,
and no one signs in to it. You and its members use it from your own afterwrd sites. You decide who's in it (up to 1,000
people besides you), can make others admins, and can close it. Members can post photos (up to ${maxPhotos} a post), which
are kept on the group's site.</p>
<p class="meta">A free Cloudflare account can hold about 9 groups besides your site. Your site keeps each group
up to date when you update.</p>
${domain ? html`<form class="card stack" id="start">
  <input name="name" required maxlength="100" placeholder="Its name" aria-label="Group name">
  <textarea name="about" rows="2" maxlength="1000" placeholder="What it's for (optional)" aria-label="What it's for"></textarea>
  ${connectField(connected, "to make the group's site", "/groups/new")}
  <div class="actions-row"><button class="chip primary" id="go">Start the group</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</form>
<script>${raw(STEP_SCRIPT)}
  const form = document.getElementById("start");
  // Connect takes a page away and back: what's typed is kept for the return.
  const kept = "afterwrd-group-start";
  try {
    const saved = JSON.parse(sessionStorage.getItem(kept) || "null");
    if (saved) { form.name.value = saved.name; form.about.value = saved.about; sessionStorage.removeItem(kept); }
  } catch {}
  document.querySelector("a.connect")?.addEventListener("click", () => {
    try { sessionStorage.setItem(kept, JSON.stringify({ name: form.name.value, about: form.about.value })); } catch {}
  });
  let made = null; // a group whose site is made, still to be claimed: trying again carries on from there
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = document.getElementById("go");
    error.textContent = "";
    go.disabled = true;
    try {
      if (!made) {
        const name = form.name.value.trim();
        log("Checking your Cloudflare account…");
        const { account, script, address } = await post("/_groups/create/check", { name });
        log("Preparing " + address + "…");
        let jwt = null; // a few files at a time (deploy.js FILES_AT_ONCE)
        for (let i = 0; i < 30 && !jwt; i++) ({ jwt } = await post("/_groups/create/assets", { account, script }));
        if (!jwt) throw new Error("Couldn't finish uploading the group's site files. Try again in a minute.");
        log("Making the group's site…");
        made = (await post("/_groups/create/deploy", { account, script, jwt, name, about: form.about.value })).id;
      }
      log("Waiting for it to start…");
      for (let i = 0; i < 40 && !(await post("/_groups/create/wait", { id: made })).ready; i++) await new Promise((r) => setTimeout(r, 2000));
      log("Setting it up as yours…");
      const { id } = await post("/_groups/create/claim", { id: made });
      await signGroup(id);
      location.assign("/groups/" + id + "/members");
    } catch (err) {
      error.textContent = err.message + (made ? " Press the button again to carry on." : "");
      go.disabled = false;
    }
  });
</script>` : html`<p class="notice">Groups can be started from your site's workers.dev address.</p>`}`);
}

/**
 * Starting a group on a self-hosted server (hosting.js): its site is made on the server by a command, which gives its
 * address and a setup code; this site then claims it (groupsites.js /local, then membership.js claimGroup).
 */
function selfHostedGroupNewPage(ctx, { maxPhotos, command }) {
  return page(ctx, "Start a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Start a group</h1>
<p>A group is its own small site on your server, at its own address, separate from yours: it holds the group and nothing
else, and no one signs in to it. You and its members use it from your own afterwrd sites. You decide who's in it (up to
1,000 people besides you), can make others admins, and can close it. Members can post photos (up to ${maxPhotos} a post),
which are kept on the group's site.</p>
<ol class="how">
  <li>Point an address at your server for the group, as you did for your site: <code>walkers.example.com</code>, say.</li>
  <li>On your server, run <code>${command} walkers.example.com</code> (with the group's address). It gives you a setup code.</li>
  <li>Fill in the group's address and that code here.</li>
</ol>
<form class="card stack" id="start">
  <input name="name" required maxlength="100" placeholder="Its name" aria-label="Group name">
  <textarea name="about" rows="2" maxlength="1000" placeholder="What it's for (optional)" aria-label="What it's for"></textarea>
  <input name="origin" required placeholder="The group's address, e.g. walkers.example.com" autocomplete="off" spellcheck="false" inputmode="url" aria-label="The group's address">
  <input name="setup" required placeholder="Its setup code" autocomplete="off" spellcheck="false" aria-label="Setup code">
  <div class="actions-row"><button class="chip primary" id="go">Start the group</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</form>
<script>${raw(STEP_SCRIPT)}
  const form = document.getElementById("start");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = document.getElementById("go");
    error.textContent = "";
    go.disabled = true;
    try {
      const typed = form.origin.value.trim().replace(/[/]+$/, "");
      const origin = /^https?:[/][/]/i.test(typed) ? typed : "https://" + typed;
      const made = (await post("/_groups/create/local", { origin, setup: form.setup.value.trim(), name: form.name.value, about: form.about.value })).id;
      log("Setting it up as yours…");
      const { id } = await post("/_groups/create/claim", { id: made });
      await signGroup(id);
      location.assign("/groups/" + id + "/members");
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false;
    }
  });
</script>`);
}

/** Join the group an invite link is for? (Or why not.) */
export function groupJoinPage(ctx, { info = null, link = "", error = null }) {
  if (error) {
    return page(ctx, "Join a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Couldn't open that invite</h1>
<p>${error}</p>`);
  }
  return page(ctx, "Join a group", html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<h1>Join ${info.name}?</h1>
${info.about && html`<p>${info.about}</p>`}
<p class="meta">${info.owner}'s group, at <strong>${host(info.origin)}</strong>. Its members will see your name and your
site's address, and what you post there is kept there. Its admins let people in, so you'll be asking. You can leave
whenever you like, and joining shares nothing else of yours.</p>
<p id="error" role="alert"></p>
<div class="actions-row">
  <button class="chip primary" id="go" data-group-record="join" data-link="${link}">Ask to join</button>
  <a class="chip" href="/groups">Not now</a>
</div>`);
}

export function groupHead(ctx, g, info, tab) {
  const waiting = runs(g) ? info?.waiting ?? 0 : 0;
  return html`
<p class="crumbs"><a href="/groups">Groups</a> /</p>
<div class="feed-head">
  <h1>${info?.name ?? g.name}</h1>
</div>
${(info?.about ?? g.about) && html`<p>${info?.about ?? g.about}</p>`}
<p class="meta">${groupWhere(g)}${info && ` · ${info.members} ${info.members === 1 ? "member" : "members"}`}. Only its members see it.</p>
${closedNotice(g)}
${info && mentionData("mention-group", { people: info.people ?? [], here: Boolean(info.mayHere) })}
<nav class="tabs">
  <a href="${groupBase(g)}" ${tab === "posts" && raw('aria-current="page"')}>Posts</a>
  <a href="${groupBase(g)}/calendar" ${tab === "calendar" && raw('aria-current="page"')}>Calendar</a>
  <a href="${groupBase(g)}/members" ${tab === "members" && raw('aria-current="page"')}>${g.role === "owner" ? "Members & settings" : "Members"}${waiting > 0 && html` <span class="count">${waiting}<span class="hidden"> asking to join</span></span>`}</a>
</nav>`;
}

/**
 * A group its owner has closed (step 6e: groups.js): read-only, and when it goes. Nothing new can be posted or said;
 * members can still delete what they wrote.
 */
function closedNotice(g) {
  const shut = closedGroup(g);
  if (!shut) return "";
  const gone = shut.goes <= Date.now() / 1000;
  return html`<p class="notice">${gone ? "This group has closed, and gone." : html`This group is closed. You can read it, and delete what you wrote,
    until ${fmtDate(shut.goes)}, when it goes.`}</p>`;
}

/** The group's owner's identity (step 6c), from those its site lists: who admins may not remove things of. */
const ownerPersonOf = (info) => info?.people?.find((p) => p.origin === info.ownerFrom)?.person ?? null;

/**
 * A group's page (groupcopies.js): its newest posts as this site keeps them, and older ones a page at a time (`next`: the
 * time the next page goes back from), with a composer that signs (none once it's closed).
 */
function signedGroupPage(ctx, { membership: g, group: info, posts, next, before, maxPhotos }) {
  g.ownerFrom = info.ownerFrom;
  const ownerPerson = ownerPersonOf(info);
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "posts")}
${!before && !closedGroup(g) && composer({ action: `/_groups/${g.id}/items`, max: maxPhotos, placeholder: `Write something for ${info.name}`, host: g.identity })}
${feed(posts, (p) => groupItemCard(ctx, g, p, { ownerPerson }), before ? "Nothing older." : "Nothing posted yet. Write the first post above.")}
${(before || next) && html`<nav class="pager">${before ? html`<a class="chip" href="${groupBase(g)}">Newest</a>` : ""}${next ? html`<a class="chip" href="${groupBase(g)}?before=${next}">Older posts</a>` : ""}</nav>`}`);
}

/**
 * A group from before signing (membership.js oldGroupWords): what the owner here posted and said there, as they sent
 * it, read-only, for them alone, until migration.
 */
function oldGroupPage(ctx, { membership: g, words }) {
  const kinds = { post: "You posted", comment: "You commented" };
  return page(ctx, g.name, html`
${groupHead(ctx, g, null, "")}
<p class="notice">This group is from before signing. Its posts stay on its site, and these are your own posts and comments
there, as you wrote them. Only you can see them here, and they can't be changed.</p>
${words.length ? html`<ul class="old-words">${words.map((w) => html`<li class="card">
  <p class="meta">${kinds[w.kind] ?? "You wrote"} · <time title="${fmtDatetime(w.created_at)}">${fmtDate(w.created_at)}</time>
    ${w.photos > 0 && ` · with ${w.photos} ${w.photos === 1 ? "photo" : "photos"}`}${w.event?.title && ` · an event: ${w.event.title}`}</p>
  ${w.text && html`<div class="text">${w.text}</div>`}
</li>`)}</ul>` : html`<p class="empty">Nothing of yours there.</p>`}
${g.role !== "owner" || !g.script ? html`<form method="post" action="/_groups/${g.id}/forget" data-confirm="Take this group off your list? Your own words
  in it stay in Download everything." data-confirm-ok="Take it off"><button class="chip">Take it off your list</button></form>` : ""}`);
}

/** A group that's closed, and whose 30 days are up. */
function goneGroupPage(ctx, { membership: g }) {
  return page(ctx, g.name, html`
${groupHead(ctx, g, null, "")}
${g.role === "owner" ? html`<p class="meta">You can delete its site now, from <a href="${groupBase(g)}/members">Members & settings</a>.</p>`
    : html`<form method="post" action="/_groups/${g.id}/forget"><button class="chip">Take it off your list</button></form>`}`);
}

/** A post in a signed group, its comments open (read from the group and checked). */
export function groupItemPage(ctx, { membership: g, group: info, item, thread, list, problem }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, info.name, html`
${groupHead(ctx, g, info, "")}
<div class="feed">${groupItemCard(ctx, g, item, { thread, list, open: true, problem, ownerPerson: ownerPersonOf(info) })}</div>`);
}

/** A photo in a signed group's post. */
export function groupItemPhotoPage(ctx, data) {
  return itemPhotoPage(ctx, { ...data, ownerPerson: ownerPersonOf(data.group) });
}

/** Changing an event the owner here added to a signed group. */
export function groupItemEventEditPage(ctx, { membership: g, group: info, item, list }) {
  g.ownerFrom = info.ownerFrom;
  return page(ctx, `${info.name}: change the event`, html`
${groupHead(ctx, g, info, "")}
<section class="card">
  <h2>Change the event</h2>
  <p class="meta">If you change its name, time or place, everyone going, or who might, is told. Its times are in
  ${item.event.time_zone.replace(/_/g, " ")} time.</p>
  ${groupItemEventForm(g, item, list)}
</section>`);
}

export function groupPage(ctx, data) {
  if (data.old) return oldGroupPage(ctx, data);
  if (data.gone) return goneGroupPage(ctx, data);
  return signedGroupPage(ctx, data);
}

/** Who's in a group. For its admins: requests to join, the invite link, roles, and (its owner) deleting it. */
export function groupMembersPage(ctx, { membership: g, group: info, members, max, connected, friends = [], deleteCommand = null, gone = false }) {
  const owner = g.role === "owner";
  const shut = closedGroup(g);
  const here = `/groups/${g.id}/members`;
  // Friends with them, asked them, asked by them, or a button to ask: everyone in a group can see who's in it.
  const friendship = (m) => {
    if (!m.from || m.waiting || m.from === ctx.url.origin) return "";
    const c = friends.find((f) => f.origin === m.from);
    if (c?.approved_at) {
      return html`<span class="friendship">${c.reached_at ? html`<a class="chip" href="/friend/${c.id}/posts">Friends</a>` : html`<span class="meta">Asked</span>`}</span>`;
    }
    if (c?.invited_as) return html`<span class="friendship"><a class="chip primary" href="/friend">Asking to be friends</a></span>`;
    if (c) {
      return html`<form method="post" class="friendship"><button class="chip primary"
        formaction="/_admin/connections/${c.id}/approve?back=${encodeURIComponent(here)}">Approve friend request</button></form>`;
    }
    return html`<form method="post" action="/_admin/connections/ask" class="friendship">
      <input type="hidden" name="origin" value="${m.from}"><input type="hidden" name="group" value="${g.id}">
      <input type="hidden" name="back" value="${here}"><button class="chip">Ask to be friends</button></form>`;
  };
  const person = (m, actions) => html`<li class="card member" data-from="${m.from ?? ""}">
    ${faceFor(ctx, m.from, m.name, m.id ?? 0)}
    <span class="what"><strong>${m.name}</strong>${m.from && html`<span class="meta">${host(m.from)}</span>`}</span>
    ${ROLE_NAMES[m.role] && html`<span class="badge as-written">${ROLE_NAMES[m.role]}</span>`}
    ${friendship(m)}
    ${actions}
  </li>`;
  // Buttons for an admin: what they can do about someone (only the owner deals with admins).
  const choices = (m) => {
    if (!runs(g) || shut || m.id === null || m.role === "owner" || m.from === ctx.url.origin) return [];
    if (m.waiting) return [["approve", "Let in", true], ["decline", "Decline"]];
    if (m.role === "admin") return owner ? [["member", "Stop being admin"], ["remove", "Remove"]] : [];
    return [...(owner ? [["admin", "Make admin"]] : []), ["remove", "Remove"]];
  };
  // Each decision is a record signed in this browser (ui/groupsign.js).
  const SIGNED = { approve: ["approve"], decline: ["remove"], remove: ["remove"], admin: ["role", "admin"], member: ["role", "member"] };
  const decide = (m) => {
    const list = m.join ? choices(m) : [];
    return list.length > 0 && html`<div class="actions-row">
      ${list.map(([action, label, primary]) => html`<button class="chip${primary ? " primary" : ""}" data-group-record="${SIGNED[action][0]}"
        data-group="${g.id}" data-about="${m.join}" ${SIGNED[action][1] ? raw(`data-role="${SIGNED[action][1]}"`) : ""}
        ${action === "remove" && raw(`data-ask="Remove them from the group? What they posted stays." data-ask-ok="Remove"`)}>${label}</button>`)}
    </div>`;
  };
  const waiting = members.filter((m) => m.waiting);
  const inGroup = members.filter((m) => !m.waiting);
  const name = info?.name ?? g.name;
  return page(ctx, `${name}: members`, html`
${groupHead(ctx, g, info, "members")}
${owner && !shut && html`<p class="meta jump">You started this group: <a href="#about">change its name or description</a> ·
  <a href="#close">close it</a>.</p>`}
${runs(g) && !shut && html`<section class="card" id="invite">
  <h2>Invite people</h2>
  <p class="meta">Make a link and send it to people who have an afterwrd site: they paste it into <b>Groups</b> on their
  own site. Anyone with it can ask to join for the next 14 days, and the group's admins decide who's in. Making a new
  link stops the old one working.</p>
  <div class="actions-row"><button class="chip primary" id="make">Make an invite link</button></div>
  <div id="link" hidden>
    <input id="link-url" readonly aria-label="Invite link">
    <div class="actions-row"><button class="chip primary" id="copy">Copy link</button></div>
  </div>
  <p id="invite-error" role="alert"></p>
</section>`}
${waiting.length > 0 && html`<section class="requests">
  <h2>Asking to join</h2>
  <ul class="member-list">${waiting.map((m) => person(m, decide(m)))}</ul>
</section>`}
${!gone && html`<h2>Members <span class="meta">${inGroup.length}${runs(g) && ` of up to ${max + 1}`}</span></h2>
<ul class="member-list">${inGroup.map((m) => person(m, decide(m)))}</ul>`}
${runs(g) && !shut && html`<section class="card" id="about">
  <h2>Name and description</h2>
  <form class="stack" method="post" action="/_groups/${g.id}/about">
    <input name="name" required maxlength="100" value="${name}" aria-label="Group name">
    <textarea name="about" rows="2" maxlength="1000" placeholder="What it's for (optional)" aria-label="What it's for">${info.about ?? ""}</textarea>
    <div class="actions-row"><button class="chip">Save</button></div>
  </form>
</section>
<section class="card" id="here">
  <h2>@here</h2>
  <p class="meta">Writing @here in a post or comment tells everyone in the group, on their phones if they've said yes to
  mentions. A few times a day at most.</p>
  <form method="post" action="/_groups/${g.id}/here">
    <label><input type="checkbox" name="anyone" value="1"${info.hereAnyone && " checked"}> Anyone in the group can use it
      (otherwise only you${g.role === "owner" ? " and the admins" : ", the owner and the other admins"})</label>
    <div class="actions-row"><button class="chip">Save</button></div>
  </form>
</section>`}
${owner && !shut ? html`<section class="card" id="close">
  <h2>Close the group</h2>
  <p class="meta">Everyone in it is told. For 30 days it stays as it is, to read, and for people to delete what they wrote,
  but nothing new can be posted, said or answered; then it goes, for everyone, and you can delete its site. This can't be
  undone.</p>
  <p id="error" role="alert"></p>
  <div class="actions-row"><button class="chip" data-group-record="close" data-group="${g.id}"
    data-ask="Close this group for everyone? It goes 30 days from now. This can't be undone." data-ask-ok="Close it">Close the group</button></div>
</section>` : owner && gone ? html`<section class="card" id="delete">
  <h2>Delete the group's site</h2>
  <p class="meta">It closed, and has gone for its members. Its site can go now too.</p>
  ${g.script ? connectField(connected, "to delete the group's site", `/groups/${g.id}/members`) : ""}
  ${deleteCommand && html`<p class="meta" id="delete-command">Its site stays on your server, empty, until you remove it there:
    <code>${deleteCommand}</code></p>`}
  <div class="actions-row"><button class="chip" id="delete-go">Delete the group's site</button></div>
  <ol id="log"></ol>
  <p id="error" role="alert"></p>
</section>` : !owner && gone ? html`<form method="post" action="/_groups/${g.id}/forget"><button class="chip">Take it off your list</button></form>`
  : !owner && !shut ? html`<p id="error" role="alert"></p><div class="actions-row"><button class="chip" data-group-record="leave" data-group="${g.id}"
  data-ask="Leave this group? What you posted in it stays there." data-ask-ok="Leave">Leave the group</button></div>` : ""}
<script>${raw(STEP_SCRIPT)}
  const linkUrl = document.getElementById("link-url");
  document.getElementById("make")?.addEventListener("click", async () => {
    const problem = document.getElementById("invite-error");
    problem.textContent = "";
    try {
      linkUrl.value = (await post("/_groups/${raw(String(g.id))}/link")).link;
      document.getElementById("link").hidden = false;
      linkUrl.select();
    } catch (err) { problem.textContent = err.message; }
  });
  document.getElementById("copy")?.addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(linkUrl.value);
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy link"; }, 1500);
  });
  document.getElementById("delete-go")?.addEventListener("click", async (e) => {
    if (!(await askFirst("Delete the group's site? This can’t be undone.", { ok: "Delete" }))) return;
    e.target.disabled = true;
    error.textContent = "";
    try {
      log("Deleting the group's site…");
      await post("/_groups/${raw(String(g.id))}/delete", {});
      location.assign("/groups");
    } catch (err) {
      error.textContent = err.message;
      e.target.disabled = false;
    }
  });
</script>`);
}

export function groupProblem(ctx, { membership: g, message }) {
  const waiting = /^Waiting for /.test(message);
  const gone = /^Not a member|has closed/.test(message);
  return page(ctx, g.name, html`
${groupHead(ctx, g, null, "")}
<p class="notice">${waiting ? message : gone ? "You're no longer in this group, or it's closed and gone." : !g.identity ? message
    : html`Couldn't load this from ${host(g.origin)}: ${message}`}</p>
${g.role !== "owner" && (g.identity && !gone ? html`<p id="error" role="alert"></p><div class="actions-row"><button class="chip" data-group-record="leave"
  data-group="${g.id}">${waiting ? "Cancel the request" : "Leave the group"}</button></div>`
  : html`<form method="post" action="/_groups/${g.id}/forget"><button class="chip">Take it off your list</button></form>`)}`);
}
