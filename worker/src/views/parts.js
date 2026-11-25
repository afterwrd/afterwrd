// Pieces several signed-in pages share: post and comment cards, comment threads, the V menus and edit boxes, polls,
// pictures and pagers. Views only draw: they read nothing and change nothing.
import { aspect, EMOJI, fmtAgo, fmtDate, fmtDatetime, linkify, mediaUrl, number, safeUrl, summary, thumbUrl } from "./format.js";

import { MAX_OPTION } from "../polls.js";
import { asset, integrity, icon, initial } from "./nav.js";
import { html, raw } from "./html.js";
import { guestsBlock, ownEventBlock } from "./events.js";
import { notFriend } from "./friends.js";
import { readMentions } from "../mentions.js";

// --- pieces (_macros.html) ---------------------------------------------------

export const has = (ctx, section) => ctx.sections.includes(section);

export function personLink(ctx, id, name) {
  if (id === ctx.me.id) return "you";
  if (id && has(ctx, "friends")) return html`<a href="/people/${id}">${name}</a>`;
  return name;
}

export function ownerPhrase(ctx, ownerId, ownerName, authorId = null) {
  if (ownerId && (ownerId === ctx.me.id || ownerId === authorId)) return "your own";
  if (ownerId && has(ctx, "friends")) return html`<a href="/people/${ownerId}">${ownerName}</a>'s`;
  if (ownerId) return `${ownerName}'s`;
  return "a";
}

export function mediaImg(m) {
  if (m.kind === "video") {
    return html`<video src="${mediaUrl(m)}#t=0.5" preload="metadata" muted playsinline></video><span class="play" aria-hidden="true"></span>`;
  }
  return html`<img src="${thumbUrl(m)}" loading="lazy" alt="${m.description || ""}" ${m.width && html`width="${Number(m.width)}" height="${Number(m.height)}"`}>`;
}

/** Rows of photos at a shared height, each keeping its own shape (like Google Photos). */
export function justified(items) {
  return html`<div class="justified">
  ${items.map((m) => html`<a href="/photos/${m.id}" class="tile" style="--r: ${aspect(m)}" title="${fmtDate(m.created_at)}">${mediaImg(m)}</a>`)}
</div>`;
}

/**
 * Facebook-style layout for the photos attached to a post or comment. A post's (`back`: where the post is shown) open
 * among that post's photos, and ✕ comes back here; a comment's open in their album.
 */
export function collage(items, { back = null } = {}) {
  if (!items?.length) return "";
  const n = items.length;
  const stay = back ? `?${new URLSearchParams({ in: "post", back })}` : "";
  return html`<div class="collage collage-${Math.min(n, 4)}">
    ${items.slice(0, 4).map((m, i) => html`
      <a href="/photos/${m.id}${stay}" class="tile" ${n === 1 && m.kind === "photo" && html`style="--bg-img: url('${thumbUrl(m)}')"`}>
        ${mediaImg(m)}
        ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}
      </a>`)}
  </div>`;
}

/**
 * "Edited", opening onto what a post or comment said before (oldest first), each with when it was replaced
 * (src/edits.js). `item` has edited_at and earlier: [{text, replaced_at}]. Nothing if it was never edited.
 */
export function edited(item) {
  if (!item?.edited_at) return "";
  const earlier = item.earlier ?? [];
  if (!earlier.length) return html`<span class="edited" title="${fmtDatetime(item.edited_at)}">Edited</span>`;
  return html`<details class="edited"><summary title="${fmtDatetime(item.edited_at)}">Edited</summary>
  <ol class="versions">${earlier.map((v) => html`<li><span class="meta">Until ${fmtDatetime(v.replaced_at)}</span>
    <span class="was">${v.text ? linkify(v.text) : html`<em>(no words)</em>`}</span></li>`)}</ol>
</details>`;
}

/**
 * The small V on something you wrote: Edit (while it can still be changed) and Delete, folded away until wanted, so a
 * page of posts isn't a page of Delete buttons. It's a <details>, and Edit is a link to the edit box (editBox), which
 * shows while it's the page's #target, so both work without scripts; ui.js closes the menu on a tap elsewhere.
 * `items` are menuEdit / menuDelete entries (false ones left out); nothing at all if there are none.
 */
export function moreMenu(items, label = "Edit or delete") {
  const shown = items.filter(Boolean);
  if (!shown.length) return "";
  return html`<details class="more"><summary aria-label="${label}" title="${label}">${raw(icon("more"))}</summary>
  <div class="menu">${shown}</div></details>`;
}
export const menuEdit = (id) => html`<a href="#${id}">Edit</a>`;
/**
 * A Delete in the menu: asks first (ui.js). `fields` are extra hidden fields, `back` where to go afterwards. `inplace`:
 * done without a new page (ui.js), "refresh" (what it's in is drawn again: a comment's post) or "remove" (a post).
 */
export function menuDelete(action, confirm, { back = null, label = "Delete", fields = {}, inplace = null } = {}) {
  return html`<form method="post" action="${action}" data-confirm="${confirm}" data-confirm-ok="Delete"${inplace && raw(inplace === "remove" ? ' data-inplace="remove"' : " data-inplace")}>
    ${back !== null && html`<input type="hidden" name="back" value="${back}">`}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="delete">${label}</button></form>`;
}

/**
 * A way to change words that can still be changed (src/edits.js): the words, ready to edit. Hidden until the menu's
 * Edit makes it the page's #target; Cancel goes back to `home`, the post or comment itself.
 */
export function editBox(id, home, action, text, back, max, { required = true, post = null } = {}) {
  return html`<div class="edit" id="${id}">
  <form method="post" action="${action}" data-inplace>
    <input type="hidden" name="back" value="${back}">
    ${post !== null && html`<input type="hidden" name="post" value="${post}">`}
    <textarea name="text" data-draft="${action}" rows="3" maxlength="${max}" ${required && "required"} aria-label="New words">${text ?? ""}</textarea>
    <div class="edit-buttons"><button class="chip primary">Save</button><a class="chip" href="#${home}">Cancel</a></div>
    <span class="meta">Anyone who can see it can see what it said before.</span>
  </form>
</div>`;
}

/**
 * The comments written here on a post or photo before signing, as they were: read-only, until migration turns them
 * into signed records (docs/signed-conversations.md, step 10). Nothing if there are none.
 */
export function thread(ctx, key, comments, { region = false } = {}) {
  if (!comments?.length) return "";
  return html`<section class="thread" id="t-${key}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((c) => html`<div class="comment" id="c${c.id}"${c.origin && c.origin !== "site" && html` data-who="${c.origin}" data-name="${c.name}"`}>
    ${c.author_is_owner ? ownerFace(ctx)
      : c.origin && c.origin !== "site" && ctx.friendFaces?.[c.origin] ? html`<img class="who" src="${ctx.friendFaces[c.origin]}" alt="" aria-hidden="true">`
        : html`<span class="who who-${(c.author_id ?? 0) % 6}" aria-hidden="true">${initial(c.name)}</span>`}
    <div class="bubble"><strong>${c.name}</strong>${c.origin !== "site" && notFriend(ctx, c.origin)}<span class="said">${linkify(c.text, said(c))}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.created_at)}">${fmtAgo(c.created_at)}</time>
    </div>
    ${edited(c)}
  </div>`)}
</section>`;
}

/** Who a post or comment mentions (mentions.js), as kept here (JSON) or read from another site (a list). */
export const said = (item) => (Array.isArray(item?.mentions) ? item.mentions : readMentions(item?.mentions));

/** The owner's picture, or their initial: for posts written here. */
export function ownerFace(ctx) {
  const picture = ctx.profile?.profile;
  return picture ? html`<img class="who" src="/files/${picture.thumb_hash ?? picture.hash}" alt="" aria-hidden="true">`
    : html`<span class="who" aria-hidden="true">${initial(ctx.ownerName)}</span>`;
}

/**
 * A poll (polls.js): each option with how many chose it. While it's open, choosing is one tap (or, when it takes
 * several, ticks and Save). `action` takes the answer, with `hidden` fields; `closeAction`, for whoever asked, closes
 * it. Who chose what shows only where the poll says (to whoever asked), folded away.
 */
export function pollBlock(ctx, poll, { id, action = null, hidden = {}, closeAction = null, whoNote = "Only you can see this.", whoLink = null,
  sign = "", closeSign = "" }) {
  // No `action`: read-only (a poll from before signing), shown as it was.
  // `sign` and `closeSign` (afterwrd 2: views/items.js): a signed poll's forms' data-sign-* attributes (ui/sign.js).
  const back = ctx.url.pathname + ctx.url.search;
  const share = (o) => (poll.voters ? Math.round((o.count / poll.voters) * 100) : 0);
  const facts = [
    !poll.voters ? "Nobody's answered yet" : (poll.voters === 1 ? "1 person answered" : `${poll.voters} people answered`)
      // Split by who the owner here knows (names.js), when some of them aren't.
      + (poll.knownVoters !== null && poll.knownVoters !== undefined && poll.knownVoters < poll.voters ? `, ${poll.knownVoters} you know` : ""),
    poll.open && poll.multiple && "Pick as many as you like",
    !poll.open ? "Closed" : poll.closes_at && `Closes ${fmtDate(poll.closes_at)}`,
  ].filter(Boolean).join(" · ");
  const inside = (o) => html`<span class="fill" aria-hidden="true"></span>
    <span class="name">${o.name}</span><span class="tally">${o.count}<span class="hidden"> (${share(o)}%)</span></span>`;
  const fields = html`<input type="hidden" name="back" value="${back}">
    ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}`;
  let options;
  if (!poll.open || !action) {
    options = poll.options.map((o) => html`<div class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%">${inside(o)}</div>`);
  } else if (poll.multiple) {
    options = html`<form method="post" action="${action}" class="poll-form" data-inplace${raw(sign)}>${fields}
      ${poll.options.map((o, i) => html`<label class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%">
        <input type="checkbox" name="choice" value="${i}" ${o.chosen && "checked"}>${inside(o)}</label>`)}
      <button class="chip">${poll.answered ? "Change my answer" : "Answer"}</button>
    </form>`;
  } else {
    options = html`<form method="post" action="${action}" class="poll-form" data-inplace${raw(sign)}>${fields}
      ${poll.options.map((o, i) => html`<button class="poll-option${o.chosen ? " chosen" : ""}" style="--share: ${share(o)}%"
        name="choice" value="${i}" aria-pressed="${o.chosen ? "true" : "false"}">${inside(o)}</button>`)}
    </form>`;
  }
  const named = poll.options.some((o) => o.voters?.length);
  const who = (v) => (v.me !== undefined ? v.name : !v.from || v.from === ctx.url.origin ? "You" : v.name);
  return html`<div class="poll" id="${id}">
  ${options}
  <p class="meta">${facts}</p>
  ${named ? html`<details class="poll-who"><summary>Who chose what</summary>
    <p class="meta">${whoNote}</p>
    <dl>${poll.options.filter((o) => o.voters?.length).map((o) => html`<dt>${o.name}</dt><dd>${o.voters.map(who).join(", ")}</dd>`)}</dl>
  </details>` : whoLink && poll.voters > 0 && html`<p class="meta"><a href="${whoLink}">See who chose what</a></p>`}
  ${closeAction && poll.open && html`<form method="post" action="${closeAction}" data-inplace data-confirm="Close this poll? Nobody will be able to answer any more." data-confirm-ok="Close it"${raw(closeSign)}>
    <input type="hidden" name="back" value="${back}"><button class="chip">Close poll</button></form>`}
</div>`;
}

export function postCard(ctx, p) {
  // Posts written here before signing look like friends' posts (who, when, and what they did if it's more than writing),
  // read-only and the owner's alone until migration (docs/signed-conversations.md, step 10). `thread` is undefined where
  // comments weren't loaded (no link), null where the post has none (Facebook's).
  if (p.source === "afterwrd") {
    const did = p.title && p.title !== "Posted on afterwrd." ? p.title : "";
    const back = ctx.url.pathname + ctx.url.search;
    return html`<article class="card social own" id="p-${p.key}" data-region="/posts/${p.key}">
  <header>
    ${ownerFace(ctx)}
    <span class="what"><strong>You</strong><span class="meta">${did ? `${did} ` : ""}Only you can see this for now.</span></span>
    ${p.thread !== undefined ? html`<a class="when" href="/posts/${p.key}" title="${fmtDatetime(p.created_at)}"><time>${fmtAgo(p.created_at)}</time></a>`
      : html`<time title="${fmtDatetime(p.created_at)}">${fmtAgo(p.created_at)}</time>`}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text, said(p))}</div>`}
  ${edited(p)}
  ${p.poll && pollBlock(ctx, p.poll, { id: `poll-${p.id}` })}
  ${p.event && ownEventBlock(ctx, p, { full: ctx.url.pathname === `/posts/${p.key}` })}
  ${p.event && ctx.url.pathname === `/posts/${p.key}` && guestsBlock(ctx, p)}
  ${collage(p.media, { back: `${back}#p-${p.key}` })}
  ${p.thread && thread(ctx, p.key, p.thread)}
</article>`;
  }
  let what;
  if (p.kind === "wall") what = html`Wrote on ${personLink(ctx, p.target_id, p.target_name)}'s profile`;
  else if (p.kind === "group") what = html`Posted in <em>${p.group_name}</em>`;
  else what = summary(p.title, ctx.me.name);
  return html`<article class="card">
  <header>
    <span class="badge badge-${p.kind}">${p.kind}</span>
    <span class="what">${what}</span>
    ${p.thread !== undefined ? html`<a class="when" href="/posts/${p.key}" title="Link to this post"><time>${fmtDatetime(p.created_at)}</time></a>`
      : html`<time>${fmtDatetime(p.created_at)}</time>`}
  </header>
  ${p.text && html`<div class="text">${linkify(p.text)}</div>`}
  ${collage(p.media, { back: ctx.url.pathname + ctx.url.search })}
  ${safeUrl(p.link_url) && !(p.text || "").includes(p.link_url) &&
    html`<p class="link"><a href="${p.link_url}" target="_blank" rel="noopener noreferrer">${p.link_url}</a></p>`}
  ${p.place_name && html`<p class="meta">📍 ${p.place_name}${p.place_address && `, ${p.place_address}`}</p>`}
  ${p.tags?.length > 0 && html`<p class="meta">With ${p.tags.map((t, i) => html`${personLink(ctx, t.id, t.name)}${i < p.tags.length - 1 && ", "}`)}</p>`}
  ${p.thread && thread(ctx, p.key, p.thread)}
</article>`;
}

export function commentCard(ctx, c) {
  const what = c.target_kind
    ? html`${c.action === "replied" ? "Replied to" : "Commented on"} ${ownerPhrase(ctx, c.target_owner_id, c.owner_name, c.author_id)} ${c.target_kind}${c.group_name && html` in <em>${c.group_name}</em>`}`
    : summary(c.title, ctx.me.name);
  return html`<article class="card">
  <header>
    <span class="badge badge-comment">${c.action === "replied" ? "reply" : "comment"}</span>
    <span class="what">${what}</span>
    <time>${fmtDatetime(c.created_at)}</time>
  </header>
  ${!c.author_is_me && c.author_name && html`<p class="meta">Posted anonymously as ${c.author_name}</p>`}
  ${c.text ? html`<div class="text">${linkify(c.text)}</div>`
    : html`<p class="meta">Facebook didn't include the text of this comment in the export.</p>`}
  ${collage(c.media)}
  ${safeUrl(c.link_url) && !(c.text || "").includes(c.link_url) &&
    html`<p class="link"><a href="${c.link_url}" target="_blank" rel="noopener noreferrer">${c.link_url}</a></p>`}
</article>`;
}

export function reactionRow(ctx, r) {
  const verb = { Like: "Liked", Love: "Loved" }[r.reaction] ?? `Reacted ${r.reaction} to`;
  return html`<li class="reaction">
  <span class="emoji" title="${r.reaction}">${EMOJI[r.reaction] ?? "👍"}</span>
  <span class="what">${verb} ${ownerPhrase(ctx, r.target_owner_id, r.owner_name)} ${r.target_kind || "post"}${r.group_name && html` in <em>${r.group_name}</em>`}</span>
  <time>${fmtDatetime(r.created_at)}</time>
  ${safeUrl(r.url) && html`<a class="out" href="${r.url}" target="_blank" rel="noopener noreferrer" title="Open on Facebook">↗</a>`}
</li>`;
}

function pageUrl(ctx, n) {
  const url = new URL(ctx.url);
  url.searchParams.set("page", n);
  return url.pathname + url.search;
}

export function pager(ctx, { page, hasNext, total }) {
  return html`<nav class="pager">
  ${page > 1 ? html`<a href="${pageUrl(ctx, page - 1)}">← Previous</a>` : raw("<span></span>")}
  <span class="meta">${number(total)} total · page ${page}</span>
  ${hasNext ? html`<a href="${pageUrl(ctx, page + 1)}">Next →</a>` : raw("<span></span>")}
</nav>`;
}

// Like the original templates: a value attribute only when the label differs from it.
export function options(values, selected, label = null) {
  return values.map((v) => (label
    ? html`<option value="${v}" ${v === selected && raw("selected")}>${label(v)}</option>`
    : html`<option ${v === selected && raw("selected")}>${v}</option>`));
}

export function yearSelect(years, year, label = "All years") {
  return html`<select name="year" data-autosubmit data-search="Type a year" aria-label="Year">
  <option value="">${label}</option>
  ${options(years, year)}
</select>`;
}

export const feed = (items, render, empty) =>
  html`<div class="feed">${items.length ? items.map(render) : html`<p class="empty">${empty}</p>`}</div>`;

/** The owner's box for a new post, top of Posts. compose.js does the work; without it, it does nothing. */
/** Write a post, with photos. In a group, `action` is where it goes, and `max` how many photos it takes. */
export function composer({ action = null, max = null, placeholder = "Write something, or add photos", host = null } = {}) {
  // The owner's own composer signs its posts (afterwrd 2: compose.js), so its @ list is of people with an identity; so
  // does a signed group's (step 6c: `host`, the group's identity, with `action` where it goes).
  return html`<form class="card composer" id="composer" ${action ? html`data-action="${action}" data-max="${max}"` : raw(" data-signs")}${host ? html` data-host="${host}" data-signs` : ""}>
  <textarea name="text" data-draft="post:${action ?? "here"}" rows="2" maxlength="5000" placeholder="${placeholder}" aria-label="New post"></textarea>
  <ul class="picked" hidden></ul>
  <fieldset class="poll-maker" hidden>
    <legend class="hidden">Poll</legend>
    <ol class="poll-options">
      ${[1, 2].map((n) => html`<li><input name="option" maxlength="${MAX_OPTION}" placeholder="Option ${n}" aria-label="Option ${n}"></li>`)}
    </ol>
    <button type="button" class="chip add-option">Add an option</button>
    <label class="tick"><input type="checkbox" name="multiple"> Let people pick more than one</label>
    <label class="closes"><span>Closes on <span class="meta">(if you like)</span></span><input type="date" name="closes"></label>
    <button type="button" class="chip remove-poll">Remove the poll</button>
  </fieldset>
  <p class="error" role="alert"></p>
  <div class="actions">
    <label class="chip">${raw(icon("photos"))}<span>Add photos</span><input type="file" accept="image/*" multiple class="hidden"></label>
    <button type="button" class="chip add-poll">${raw(icon("poll"))}<span>Poll</span></button>
    <span class="status meta" role="status"></span>
    <button class="post">Post</button>
  </div>
</form>
<script type="module" src="${asset("/static/compose.js")}" integrity="${integrity("/static/compose.js")}"></script>`;
}

/**
 * Mute (or, `muted`, Unmute) for `person` (mutes.js), going back to `back`. No asking first: it's undone as easily, and
 * nobody's told.
 */
export const muteButton = ({ person, name, back, muted = false }) => muted
  ? html`<form method="post" action="/_admin/mutes/${person}/unmute"><input type="hidden" name="back" value="${back}"><button>Unmute ${name}</button></form>`
  : html`<form method="post" action="/_admin/mutes"><input type="hidden" name="person" value="${person}"><input type="hidden" name="name" value="${name}">
    <input type="hidden" name="back" value="${back}"><button>Mute ${name}</button></form>`;

/**
 * A Block button for `person` (blocks.js) (asks first: ui.js), going back to `back`. `look`: the button's class. A friend's ends
 * the friendship too.
 */
export const blockButton = ({ person, name, back, friend = false, look = "block" }) => html`<form method="post" action="/_admin/blocks"
    data-confirm="Block ${name}? ${friend ? "You'll stop being friends. " : ""}You won't see what they write, or hear from them. They won't be told you've blocked them."
    data-confirm-ok="Block"><input type="hidden" name="person" value="${person}"><input type="hidden" name="name" value="${name}">
    <input type="hidden" name="back" value="${back}"><button class="${look}">Block</button></form>`;
