// Home, Memories and Add to home screen. Views only draw: they read nothing and change nothing.
import { friendItemCard, itemCard } from "./items.js";
import { identityChange as identityChangeWords } from "./devices.js";
import { fmtDate, summary, thumbUrl } from "./format.js";

import { icon } from "./nav.js";
import { host } from "../sites.js";
import { html, raw } from "./html.js";
import { askedBecause, friendFace, introductionCard } from "./friends.js";
import { gone, waitingFor } from "../friendcopies.js";
import { MEMORIES, page } from "./layout.js";
import { blockButton, composer, postCard } from "./parts.js";

// --- Home and Memories ----------------------------------------------------------------------------------------------

/** Posts from this day in past years, from the Facebook download (and anything posted here a year or more ago). */
function onThisDayCard(ctx, memories) {
  if (!memories.length) return "";
  return html`<section class="card onthisday">
  <h2>On this day</h2>
  ${memories.map((p) => {
    const photo = p.media?.find((m) => m.hash && m.kind === "photo");
    const href = photo ? `/photos/${photo.id}` : `/posts/${p.key}`;
    const words = p.text ? p.text.slice(0, 140) + (p.text.length > 140 ? "…" : "") : summary(p.title, ctx.me.name);
    return html`<a class="memory" href="${href}">
      ${photo && html`<img src="${thumbUrl(photo)}" alt="" loading="lazy">`}
      <span class="year">${new Date(p.created_at * 1000).getUTCFullYear()}</span>
      <span>${words}</span>
    </a>`;
  })}
</section>`;
}

const SIDE_FRIENDS = 12; // on Home; the rest are on Friends

/** "a", "a and b", "a, b and c". */
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The owner's Home: write something, then your posts and your friends' together, newest first.
 * @param {any} ctx
 * @param {Record<string, any> & { auto?: AutoState, checkGrant?: CheckGrant }} data
 */
export function homePage(ctx, { own, friendOwn = [], ownOld = [], onThisDay, friends: all = [], newDevices = { devices: [], canConfirm: false }, newNotifying = [], securityFix = null, asking = [], introductions = [], checkRequests = [], auto = { on: false }, checkFailure = null, friendChecks = [], checkGrant = {}, recovered = null, lookAfter = null, archiveDropped = false, identityChange = null, moved = null, friendsMoving = [], sent = { waiting: [], forged: [] }, busy = null }) {
  const stream = [
    ...own.map((item) => ({ at: item.created_at, card: itemCard(ctx, item) })),
    ...ownOld.map((p) => ({ at: p.created_at, card: postCard(ctx, p) })),
    ...friendOwn.map((item) => ({ at: item.created_at, card: friendItemCard(ctx, item) })),
  ].sort((a, b) => b.at - a.at);
  // A friend whose site has gone quiet for a day, or says it doesn't know this one, is on Friends instead (friendcopies.js).
  const friends = all.filter((c) => !gone(c));
  const unreachable = friends.filter((c) => c.missing_since);
  const waiting = friends.filter(waitingFor);
  return page(ctx, "Home", html`
<div class="home">
  <section class="stream" aria-label="Posts">
    <h1 class="hidden">Home</h1>
    ${securityFix && html`<p class="notice alert">afterwrd ${securityFix} fixes a security problem, and this site is older.
      <a href="/_admin/update">Update now</a>.</p>`}
    ${(auto.problem || auto.on && (auto.last?.result && auto.last.result !== "done" || auto.waiting?.needsHand)) && html`<p class="notice alert">
      ${auto.waiting?.needsHand ? html`afterwrd ${auto.waiting.version} has to be installed by hand.`
        : auto.problem ? html`An automatic update couldn't run.`
        : auto.last.result === "kept" ? html`afterwrd ${auto.last.version} failed its checks after updating your site's database, so it was kept.`
        : html`afterwrd ${auto.last.version} didn't work on this site, so it was put back as it was.`}
      <a href="/_admin/update#auto">See what happened</a>.</p>`}
    ${checkFailure && html`<p class="notice alert" id="check-failure"><strong>${checkFailure.name}'s site checked yours</strong> on
      ${fmtDate(checkFailure.checked_at)} and found something that needs a look: ${checkFailure.problems[0]}
      <a href="/_admin/update#check">See what it found</a>.</p>`}
    ${friendChecks.map((f) => html`<form class="notice alert friend-check" method="post" action="/_admin/checks/found/${f.id}/seen" data-region="" data-inplace="remove">
      ${f.verdict === "needs a look"
        ? html`<span>Your site checked <strong>${f.name}'s site</strong> and found something that needs a look. It's told their
          site too, but it's worth telling ${f.name}.</span>`
        : html`<span><strong>${f.name}'s site</strong> hasn't let yours check it the last ${f.refusals} times it tried. It may just
          be switched off, but it's worth asking ${f.name}.</span>`}
      <a href="/_admin/update#checking">See what it found</a> <button class="link">Put it away</button></form>`)}
    ${checkGrant.problem && html`<p class="notice alert">Your friends' sites can't check yours by themselves any more:
      ${checkGrant.problem} <a href="/_admin/update#check">Let them again</a>.</p>`}
    ${lookAfter && html`<form class="notice" id="look-after" method="post" action="/_admin/checks/remind-later" data-region="" data-inplace="remove">
      ${lookAfter.auto && lookAfter.checks ? html`Your site can look after itself: keep itself up to date, and let friends' sites check
          it's genuine.`
        : lookAfter.auto ? html`Your site can keep itself up to date, so fixes reach it without you doing anything.`
        : html`Your site can let friends' sites check it's genuine now and then, and tell you if anything's wrong.`}
      ${lookAfter.attempts.length > 0 && html`${listed(lookAfter.attempts.map((a) => `${a.name}'s`))}
        ${lookAfter.attempts.length === 1 ? "site has" : "sites have"} already tried to check it.`}
      <a id="look-after-go" href="${lookAfter.auto ? (lookAfter.checks ? "/_cloudflare/auto-start?then=checks" : "/_cloudflare/auto-start") : "/_cloudflare/checks-start"}">Set it up</a>
      <button class="link">Not now</button></form>`}
    ${busy && html`<p class="notice" id="busy-account">Your Cloudflare account has been busy: over half of its free daily
      allowance on ${busy.days} days this week${busy.sources.length > 1 ? html` (${busy.sources.map((s) => `${s.name ?? "your own site"} ${s.share}%`).join(", ")})` : ""}.
      Nothing has stopped, but if it reaches the limit, your site and groups pause until it resets at midnight UTC.
      ${busy.sources.some((s) => s.name) ? "Closing a group you no longer need frees it up." : ""}</p>`}
    ${archiveDropped && html`<p class="notice" id="archive-dropped">Your site moved to faster storage, but your Facebook
      download was too big to move with it in one day, so it was left out. Your own posts, photos, friends and groups all
      came. To have your Facebook years back, <a href="/_admin/import">import your download again</a>.</p>`}
    ${recovered && html`<form class="notice alert" id="recovered" method="post" action="/_admin/devices/recovered-seen" data-region="" data-inplace="remove">
      You got back into your site on ${fmtDate(recovered)}, without a passkey. Every other device was signed out and its
      passkey removed, so a lost one can't sign in. To use another of your phones or computers again, add it in
      <a href="/_admin">Your devices</a>. <button class="link">Done</button></form>`}
    ${identityChange && html`<p class="notice alert" id="identity-change">Your identity is changing: ${identityChangeWords(identityChange)},
      on ${fmtDate(identityChange.at)}. Not you? <a href="/_admin#identity-change">Cancel it in Your devices</a>.</p>`}
    ${moved && html`<p class="notice alert" id="moved">You've moved to <a href="${moved.to}">${host(moved.to)}</a>. Friends' sites
      find you there now, and this site only says where you've gone. If you haven't yet, <a href="/_admin/export">download
      everything</a> here and bring it in there, from Import. Delete this site once you're settled.</p>`}
    ${sentNotices(sent)}
    ${friendsMoving.map((f) => html`<p class="notice moving">${f.name} ${f.waiting
      ? html`is moving to ${host(f.moving_to)} on ${fmtDate(f.moving_at)}.`
      : html`has moved to ${host(f.moving_to)}.`}</p>`)}
    ${newDevices.devices.length > 0 && html`<form class="notice alert" method="post" action="/_admin/devices/seen" data-region="" data-inplace="remove">
      ${newDevices.devices.length === 1
        ? html`A new device was added to your site on ${fmtDate(newDevices.devices[0].created_at)}.`
        : html`${newDevices.devices.length} new devices were added to your site, on ${listed([...new Set(newDevices.devices.map((d) => fmtDate(d.created_at)))])}.`}
      Not you? <a href="/_admin">Remove ${newDevices.devices.length === 1 ? "it" : "them"} in Your devices</a>.
      ${newDevices.canConfirm
        ? html`<button class="link">${newDevices.devices.length === 1 ? "That was me" : "They were all me"}</button>`
        : html`If it was you, say so from one of your older devices.`}</form>`}
    ${newNotifying.length > 0 && html`<form class="notice alert" method="post" action="/_admin/notifications/seen" data-region="" data-inplace="remove">
      Notifications about events and mentions were turned on for ${newNotifying.length === 1
        ? html`a new device (${newNotifying[0].name}) on ${fmtDate(newNotifying[0].created_at)}`
        : html`${newNotifying.length} new devices, on ${listed([...new Set(newNotifying.map((d) => fmtDate(d.created_at)))])}`}.
      Not you? <a href="/_admin">Turn ${newNotifying.length === 1 ? "it" : "them"} off in Your devices</a>.
      <button class="link">That was me</button></form>`}
    ${asking.map((r) => html`<form class="notice asking" method="post">
      <strong>${host(r.origin)}</strong>, who says they're ${r.name}, is asking to be friends. ${r.via_kind && askedBecause(r)}
      ${r.invited_as && r.invited_as.toLowerCase() !== r.name.toLowerCase() && html`<strong class="warn">That's not the name you invited (${r.invited_as}).</strong>`}
      <span class="row"><button class="chip primary" formaction="/_admin/connections/${r.id}/approve?back=home">Approve</button>
        <button class="chip" formaction="/_admin/connections/${r.id}/decline?back=home" data-confirm="Decline? Their site will be told no." data-confirm-ok="Decline">Decline</button></span>
    </form>${r.identity && blockButton({ person: r.identity, name: r.name, back: "/", look: "link" })}`)}
    ${introductions.map((i) => introductionCard(i, "/", "div"))}
    <div class="notice install-note" id="install-note" hidden>
      <span><strong>Put afterwrd on your home screen.</strong> It opens like an app, in one tap, and can tell you when a
        friend invites you to an event.</span>
      <span class="row actions-row"><button class="chip primary" data-install hidden>Install</button>
        <a class="chip primary" href="/app" data-install-how>Show me how</a>
        <button class="chip" data-install-later>Not now</button></span>
    </div>
    ${checkRequests.map((r) => html`<div class="notice check-request" data-region="">
      <span><strong>${r.name}</strong> asks you to check their afterwrd site. Make a link, and send it to them by message.</span>
      <span class="row actions-row"><button class="chip primary" data-check-request="${r.id}">Make a check link</button>
        <form method="post" action="/_admin/checks/requests/${r.id}/dismiss" class="inline" data-inplace="remove"><button class="chip">Not now</button></form></span>
      <span class="check-share row actions-row" hidden><button class="chip primary" data-share>Send it to ${r.name}…</button>
        <button class="chip" data-copy>Copy the link</button></span>
      <span class="error" role="alert"></span>
    </div>`)}
    ${checkRequests.length > 0 && html`<script>
      // A friend asked for a check: make the link here, then hand it to the phone's share sheet (or copy it).
      document.addEventListener("click", async (e) => {
        const card = e.target.closest(".check-request");
        if (!card) return;
        const make = e.target.closest("button[data-check-request]");
        const error = card.querySelector(".error");
        const send = () => navigator.share({ text: card.dataset.message }).catch(() => {});
        if (make) {
          make.disabled = true;
          error.textContent = "";
          try {
            const res = await fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ connection: Number(make.dataset.checkRequest) }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Something went wrong.");
            card.dataset.message = data.message;
            make.parentElement.hidden = true;
            card.querySelector(".check-share").hidden = false;
            card.querySelector("[data-share]").hidden = !navigator.share;
            if (navigator.share) send();
          } catch (err) {
            error.textContent = err.message;
            make.disabled = false;
          }
        }
        if (e.target.closest("[data-share]")) send();
        const copy = e.target.closest("[data-copy]");
        if (copy) {
          await navigator.clipboard.writeText(card.dataset.message);
          copy.textContent = "Copied: paste it into a message";
        }
      });
    </script>`}
    ${composer()}
    ${unreachable.length > 2
      ? html`<p class="notice">Couldn't reach ${unreachable.length} friends' sites lately, so their newest posts may be missing.</p>`
      : unreachable.map((c) => html`<p class="notice">Couldn't reach ${c.name}'s site lately, so their newest posts may be missing.</p>`)}
    ${waiting.map((c) => html`<p class="notice">Waiting for ${c.name} to approve you as a friend.</p>`)}
    ${stream.length ? stream.map((s) => s.card) : html`<div class="empty"><p>Nothing here yet. Write your first post above.</p></div>`}
  </section>
  <aside class="side">
    ${onThisDayCard(ctx, onThisDay)}
    <section class="card">
      <h2>Friends</h2>
      ${friends.length ? html`<ul class="mini-friends">
        ${friends.slice(0, SIDE_FRIENDS).map((c) => html`<li><a href="/friend/${c.id}/posts">${friendFace(ctx, c)}${c.name}</a></li>`)}
      </ul>
      ${friends.length > SIDE_FRIENDS && html`<p><a href="/friend">All ${friends.length} friends</a></p>`}`
        : html`<p class="meta">Add friends to see their posts here. Anyone can join: your friend link shows them how.</p>`}
      <p><a class="chip" href="/_admin/connections">${raw(icon("connections"))}<span>Add a friend</span></a></p>
    </section>
  </aside>
</div>`, "wide");
}

/** Memories: the sections of the Facebook download that were published, and what happened on this day. */
export function memoriesPage(ctx, { onThisDay }) {
  const available = MEMORIES.filter(([s]) => ctx.chosen.includes(s));
  return page(ctx, "Memories", html`
<h1>Memories</h1>
<p class="meta">From your Facebook download.</p>
${available.length ? html`<ul class="memory-tiles">
  ${available.map(([s, label, about]) => html`<li><a href="/${s}">${raw(icon(s))}<strong>${label}</strong><span class="meta">${about}</span></a></li>`)}
</ul>` : html`<p class="empty">Nothing from Facebook has been published here.</p>`}
${onThisDayCard(ctx, onThisDay)}`);
}

/**
 * Add to home screen: the browser's own Install where it has one (ui.js), and how to do it on each kind of device.
 * ui.js shows only the steps for the device it's looking at (data-device), with the rest a tap away; without
 * scripts, all of them show.
 */
export function appPage(ctx) {
  return page(ctx, "Add to home screen", html`
<h1>Add afterwrd to your home screen</h1>
<p>Then it opens like an app: full screen, in one tap, and you don't need to remember your site's address. It can
also tell you when a friend invites you to an event, or one you're going to changes: turn that on in
<a href="/events#notify">Events</a>.</p>
<p><button class="chip primary" data-install hidden>Install afterwrd</button></p>
<section class="card" data-device="iphone-elsewhere" hidden>
  <h2>iPhone or iPad: open this page in Safari first</h2>
  <p>On an iPhone or iPad, afterwrd goes on the home screen from <strong>Safari</strong>, and this page is open
    somewhere else: another browser, or inside another app such as WhatsApp or an email app.</p>
  <ol>
    <li><button class="chip" data-copy-address>Copy this page's address</button></li>
    <li>Open <strong>Safari</strong>, tap the address bar, paste it, and go.</li>
    <li>Then follow the steps for Safari.</li>
  </ol>
</section>
<section class="card" data-device="iphone">
  <h2>iPhone or iPad (Safari)</h2>
  <ol>
    <li>Tap <strong>Share</strong>: a square with an arrow pointing up. Where it is depends on how Safari is set out:
      <ul>
        <li>With a row of buttons along the bottom of the screen, it's the one in the middle.</li>
        <li>Otherwise, tap <strong>⋯</strong> (three dots) next to the address, then <strong>Share</strong>.</li>
      </ul></li>
    <li>Under the row of apps, scroll down the list and tap <strong>Add to Home Screen</strong>.</li>
    <li>If you see <strong>Open as Web App</strong>, leave it switched on. Tap <strong>Add</strong>.</li>
    <li>Open afterwrd from its new icon on your home screen, and sign in once more: the app keeps its own sign-in,
      separate from Safari's.</li>
  </ol>
  <p class="meta">If a link to afterwrd opened inside another app (WhatsApp, or an email app), there's no
    <strong>Add to Home Screen</strong> there: open the page in Safari first.</p>
  <p class="meta">On an iPhone or iPad, notifications only work in the app on the home screen.</p>
</section>
<section class="card" data-device="android">
  <h2>Android (Chrome)</h2>
  <ol>
    <li>Tap <strong>⋮</strong>, at the top right.</li>
    <li>Tap <strong>Install app</strong> (on some phones, <strong>Add to Home screen</strong>).</li>
    <li>Open afterwrd from its new icon.</li>
  </ol>
  <p class="meta">If notifications only turn up when you unlock your phone, Android is saving battery:
  set Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's
  notifications come through Chrome.</p>
</section>
<section class="card" data-device="computer">
  <h2>A computer (Chrome or Edge)</h2>
  <p>Look for <strong>Install</strong> at the right-hand end of the address bar, or in the browser's menu.</p>
</section>
<p data-device-others hidden><button class="chip" data-show-devices>Steps for another phone or computer</button></p>`);
}

/** Where one of the owner's records went (sentchecks.js sentTrouble): a friend's post or photo, or a group. */
function sentWhere(r) {
  const item = String(r.target ?? r.item ?? "").split("/")[0].split("?")[0];
  if (r.connection_id) return html`<a href="/friend/${r.connection_id}/posts/${item}">${r.friend}'s post</a>`;
  if (r.group_id && item !== "" && item.length === 43 && r.kind !== "leave") return html`<a href="/groups/${r.group_id}/posts/${item}">a post in ${r.group_name}</a>`;
  return r.group_id ? html`<a href="/groups/${r.group_id}">${r.group_name}</a>` : html`a site you're no longer connected with`;
}

/**
 * Deletes and leaves a friend's site or group hasn't taken (sent again in the background until they are), and anything
 * signed as the owner that their site never sent (sentchecks.js).
 */
function sentNotices({ waiting = [], forged = [] } = {}) {
  return html`${waiting.map((r) => html`<form class="notice alert" method="post" action="/_admin/sent/stop" data-region="" data-inplace="remove">
      <input type="hidden" name="fp" value="${r.fp}">
      ${r.kind === "leave"
        ? html`${r.group_name ?? "A group"} hasn't taken your leaving yet, from ${fmtDate(r.created_at)}.`
        : html`${r.friend ? html`${r.friend}'s site` : r.group_name ?? "A site"} hasn't taken your delete on ${sentWhere(r)} yet, from ${fmtDate(r.created_at)}.`}
      ${r.next_at ? "Your site will keep asking." : "Your site has stopped asking: delete it again, or ask them."}
      <button class="link">Stop asking</button></form>`)}
    ${forged.map((r) => html`<form class="notice alert" method="post" action="/_admin/notices/dismiss" data-region="" data-inplace="remove">
      <input type="hidden" name="id" value="${r.id}">
      Something signed as you appeared on ${sentWhere(r)}, and your site didn't send it. Someone may have one of your keys:
      look at <a href="/_admin">Your devices</a>, and remove any you don't know. <button class="link">Got it</button></form>`)}`;
}
