// afterwrd 2's items as pages show them (step 4a: docs/signed-conversations.md): the owner's own posts, drawn as
// today's own posts are (the same markup as parts.js postCard and thread, so they look the same), with their comments
// behind a button: "Comments" when there are some, "Comment" when there are none. Every form that changes something
// is signed in the browser before it's sent (ui/sign.js, from the form's data-sign-* attributes): the comment box, Edit
// and Delete on a comment, and Edit and Delete on the post itself.
import { nonce } from "../nonce.js";
import { MAX_COMMENT } from "../archive/comments.js";
import { frozenSaid } from "../hosted.js";
import { MAX_POST_TEXT } from "../edits.js";
import { fmtAgo, fmtDatetime, linkify } from "./format.js";
import { icon, initial } from "./nav.js";
import { html, raw } from "./html.js";
import { layout, page } from "./layout.js";
import { friendFace } from "./friends.js";
import { blockButton, collage, edited, moreMenu, menuEdit, muteButton, ownerFace, pollBlock } from "./parts.js";
import { eventBlock, eventForm, guestPicker, repeatingSigned } from "./events.js";
import { eventFormValues, finishedAt } from "../calendar.js";

/**
 * The data-sign-* attributes for a record of `kind` on item `item`, from where its list is up to (`list`: {host, seen,
 * mine}), as a string: for a poll's or an event's forms (pollBlock, eventBlock), and the event forms (ui/sign.js).
 */
// One date of a repeating event (`date`, step 6d) is signed on that date's own list, which may have nothing yet (no `seen`).
const signAttrs = (kind, list, item, { version = null, about = null, group = null, date = null } = {}) => ` data-sign="${kind}" data-sign-item="${item}" data-sign-host="${list.host}"`
  + ` data-sign-seen-n="${list.seen?.n ?? ""}" data-sign-seen-h="${list.seen?.h ?? ""}" data-sign-prev="${list.mine ?? ""}"${version ? ` data-sign-version="${version}"` : ""}`
  + `${about ? ` data-sign-about="${about}"` : ""}${group ? ` data-sign-group="${group}"` : ""}${date ? ` data-sign-date="${date}"` : ""}`;

const PUBLIC_POLL = "Everyone who can see this poll can see who chose what.";

/** The data-sign-* attributes a signed form carries: what its record says besides its words. */
const signing = (kind, { item, host, seen, prev, about = null }) => raw(` data-sign="${kind}" data-sign-item="${item}" data-sign-host="${host}"`
  + ` data-sign-seen-n="${seen.n}" data-sign-seen-h="${seen.h}" data-sign-prev="${prev ?? ""}"${about ? ` data-sign-about="${about}"` : ""}`);

/** A Delete in the V menu, signed. `inplace`: "remove" (a post) or "refresh" (a comment: its post is drawn again). */
const signedDelete = (action, confirm, sign, { back, inplace }) => html`<form method="post" action="${action}" data-confirm="${confirm}" data-confirm-ok="Delete"${raw(inplace === "remove" ? ' data-inplace="remove"' : " data-inplace")}${signing("delete", sign)}>
    <input type="hidden" name="back" value="${back}"><button class="delete">Delete</button></form>`;

/**
 * A Remove in the V menu, signed: in a signed group (step 6c), what an admin (or the group's owner) takes down. The
 * browser asks this site where the group's members list is up to first (ui/sign.js role_at).
 */
const signedRemove = (action, confirm, sign, { back, inplace, group }) => html`<form method="post" action="${action}" data-confirm="${confirm}" data-confirm-ok="Remove"${raw(inplace === "remove" ? ' data-inplace="remove"' : " data-inplace")}${signing("remove", sign)}${group && html` data-sign-group="${group}"`}>
    <input type="hidden" name="back" value="${back}"><button class="delete">Remove</button></form>`;

/** An edit box, as parts.js editBox, signed. */
const signedEdit = (id, home, action, text, back, max, sign, { required = true } = {}) => html`<div class="edit" id="${id}">
  <form method="post" action="${action}" data-inplace${signing("edit", sign)}>
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="${action}:${sign.about}" rows="3" maxlength="${max}" ${required && "required"} aria-label="New words">${text ?? ""}</textarea>
    <div class="edit-buttons"><button class="chip primary">Save</button><a class="chip" href="#${home}">Cancel</a></div>
    <span class="meta">Anyone who can see it can see what it said before.</span>
  </form>
</div>`;

/**
 * An item's comments (items.js thread), then a box to add one. `list`: {seen, owner, host, mine} (where the list is
 * up to, and this person's newest record on it, for the signed forms). `region`: the comments are what's drawn again
 * when something's sent from them (a photo's page), not the post they're in. `moderate`: {may(person)}: whose comments the
 * owner here may remove: on their own posts (OWN), anyone's; in a signed group, with `group` (its id here), as an admin
 * or the group's owner. `list.commentsOff`: its host has turned comments off, so only the item's writer has a box.
 */
/** A one-photo post's words, at the top of its photo's page (its page is the post's: photoComments). */
export const postWords = (post, postThread) => postThread && post?.text && html`<div class="caption">${linkify(post.text, post.mentions)}</div>`;

/** "From Ann's post: 'The first words…'", leading back to it: on a photo's page, when its post has several photos. */
export function fromPost(href, whose, text) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim();
  const short = words.length > 80 ? `${words.slice(0, 78).trimEnd()}…` : words;
  return html`<p class="from-post"><a href="${href}">From ${whose} post${short && html`: “${short}”`}</a></p>`;
}

/**
 * The comments on a photo's page. A post with one photo (`postThread`): the post's comments (its words are at the top,
 * postWords), which is where everyone reads them; any made on the photo itself before that are shown after, with no box of their
 * own. Otherwise the photo's own comments.
 */
export function photoComments(ctx, { post, photo, thread, list, postThread, action = undefined, postAction = undefined, opts = {} }) {
  if (postThread) {
    return html`<h2>Comments</h2>${itemThread(ctx, post, postThread.thread, postThread.list, { region: true, action: postAction, ...opts })}
    ${thread?.length > 0 && list && html`<h2>On this photo</h2>${itemThread(ctx, photo, thread, list, { action, ...opts, say: false })}`}`;
  }
  return html`<h2>Comments</h2>${thread && list && itemThread(ctx, photo, thread, list, { region: true, action, ...opts })}`;
}

/**
 * What opens a post's comments: a speech bubble and how many there are (just the bubble when there are none). Screen
 * readers hear "Comment" or "3 comments".
 */
export function commentsButton(count) {
  const n = Number(count) || 0;
  return html`<summary class="comments-button" aria-label="${n > 0 ? `${n} comment${n === 1 ? "" : "s"}` : "Comment"}">${raw(icon("comments"))}${n > 0 && html`<span class="n">${n}</span>`}</summary>`;
}

/**
 * How someone is known to the owner here, beside their name (names.js): "friend of Ann" or "your friend", "not your
 * friend Bob" (a look-alike), and a friend's new name.
 */
export const whoTags = (p) => html`${p.label && html`<span class="from">${p.label}</span>`}${p.warn && html`<span class="from warn">${p.warn}</span>`}${p.renamed
  && html`<span class="from">now calling themselves ${p.renamed}</span>`}`;

/**
 * A commenter's name (not the owner's own). A friend's leads to their page. Anyone else's, where the owner here could
 * ask them (on a friend's post, through that friend: `list.askVia.through`, connect.js passOnAsk; in a group, as a
 * member: `list.askVia.group`), opens a small menu: ask them to be friends, or where that's got to. `c.tie`: how the
 * owner stands with them (connect.js friendshipsOf).
 */
function commenterName(c, name, list, back) {
  const t = c.tie;
  if (!t) return html`<strong>${name}</strong>`;
  if (t.state === "friends") return html`<strong><a class="who-link" href="/friend/${t.id}">${name}</a></strong>`;
  if (t.state === "none" && !list.askVia) return html`<strong>${name}</strong>`;
  const what = t.state === "asked" ? html`<p class="meta">You've asked ${name} to be friends.</p>`
    : t.state === "invited" ? html`<a href="/friend">${name} is asking to be friends: decide on Friends</a>`
    : t.state === "asking" ? html`<form method="post" action="/_admin/connections/${t.id}/approve?back=${encodeURIComponent(back)}" data-stay
        data-said="You and ${name} are friends now."><button>Approve ${name}'s friend request</button></form>`
    : html`<form method="post" action="/_admin/connections/ask" data-stay data-said="Asked ${name} to be friends.">
        <input type="hidden" name="origin" value="${t.origin}">${list.askVia.through
          ? html`<input type="hidden" name="through" value="${list.askVia.through}">` : html`<input type="hidden" name="group" value="${list.askVia.group}">`}
        <input type="hidden" name="name" value="${name}"><input type="hidden" name="person" value="${c.author}"><input type="hidden" name="back" value="${back}">
        <button>Ask ${name} to be friends</button></form>`;
  return html`<details class="more who"><summary title="${name}"><strong>${name}</strong></summary><div class="menu">${what}</div></details>`;
}

export function itemThread(ctx, item, comments, list, { region = false, action = `/_admin/items/${item.id}/records`, owner = null, moderate = null, say = true, report = null } = {}) {
  const back = ctx.url.pathname + ctx.url.search;
  // Telling whoever runs it about a comment (reports.js): a group's admins, or the friend whose post it is (not about
  // their own comments).
  const tell = (c) => report && c.author !== owner?.person && html`<a href="${report.href}?${new URLSearchParams({ item: item.id, about: c.fp, post: report.post, back })}">${report.label}</a>`;
  const sign = { item: item.id, host: list.host, seen: list.seen, prev: list.mine };
  const name = (c) => (c.author === list.me ? ctx.ownerName : c.name ?? "Someone");
  return html`<section class="thread" id="t-${item.id}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((c) => (c.state === "ok" && c.blocked ? html`<p class="comment gone meta" id="c-${c.fp}">Hidden: someone you've blocked.</p>`
    : c.state === "ok" ? html`<div class="comment" id="c-${c.fp}"${c.author !== list.me && raw(` data-person="${c.author}"`)}${c.author !== list.me && html` data-name="${name(c)}"`}>
    ${c.author === list.me ? ownerFace(ctx) : html`<span class="who who-${c.n % 6}" aria-hidden="true">${initial(name(c))}</span>`}
    <div class="bubble">${c.author === list.me ? html`<strong>${name(c)}</strong>` : commenterName(c, name(c), list, back)}${c.author !== list.me && whoTags(c)}<span class="said">${linkify(c.text, c.mentions)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.taken)}">${fmtAgo(c.taken)}</time>
      ${c.author === list.me && moreMenu([c.editable && menuEdit(`edit-c-${c.fp}`),
        signedDelete(action, "Delete this comment?", { ...sign, about: c.fp }, { back, inplace: "refresh" })])}
      ${c.author !== list.me && c.author && moreMenu([moderate?.may(c.author) && signedRemove(action, moderate.group ? "Remove this comment? Everyone in the group will see it was removed by you."
        : "Remove this comment? Everyone who can see the post will see you removed it.",
        { ...sign, about: c.fp }, { back, inplace: "refresh", group: moderate.group }), tell(c), c.author !== owner?.person && blockButton({ person: c.author, name: name(c), back })])}
    </div>
    ${edited(c)}
    ${c.author === list.me && c.editable && signedEdit(`edit-c-${c.fp}`, `c-${c.fp}`, action, c.text, back, MAX_COMMENT, { ...sign, about: c.fp })}
  </div>` : html`<p class="comment gone meta" id="c-${c.fp}">${c.state === "deleted" ? "A comment was deleted."
      : c.state === "removed" ? (c.removedBy === list.me ? "You removed a comment." : c.removedByName ? `A comment was removed by ${c.removedByName}.` : "A comment was removed.")
        : c.state === "failed" ? "A comment here didn't pass its check, so it isn't shown." : "A comment here was left out."}</p>`))}
  ${!say ? "" : list.frozenUntil ? html`<p class="meta frozen">${frozenSaid(list.frozenUntil)}</p>`
    : list.commentsOff && item.author !== list.me ? html`<p class="meta comments-off">Comments are turned off.</p>`
    : html`${list.commentsOff && html`<p class="meta comments-off">You've turned comments off: only you can comment now.</p>`}<form class="say" method="post" action="${action}" data-inplace data-me="${ctx.ownerName}"${signing("comment", sign)}${owner && html` data-owner-person="${owner.person}" data-owner-name="${owner.name}"`}>
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="comment:${item.id}" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>`}
</section>`;
}

/** On the owner's own posts and photos, they may remove anyone else's comment (openly: lists.js Rules lets an item's owner). */
export const OWN = { may: () => true };

/** Comments off, or on again, on one of the owner's posts (items.js; docs/safety-plan.md 3.1): nothing to sign. */
const commentsSwitch = (id, off, back) => html`<form method="post" action="/_admin/items/${id}/comments" data-inplace>
    <input type="hidden" name="off" value="${off ? "0" : "1"}"><input type="hidden" name="back" value="${back}">
    <button>${off ? "Turn comments on" : "Turn comments off"}</button></form>`;

/**
 * One of the owner's own items, as Home and its page show it. `open`: its comments shown (its own page, or Home once
 * they've been opened); otherwise "Comments" or "Comment", which opens them in place (ui/threads.js), from its page.
 */
export function itemCard(ctx, item, { thread = null, list = item.list ?? null, open = false } = {}) {
  const back = ctx.url.pathname + ctx.url.search;
  const action = `/_admin/items/${item.id}/records`;
  const sign = list && { item: item.id, host: list.host, seen: list.seen, prev: list.mine, about: item.id };
  return html`<article class="card social own" id="i-${item.id}" data-region="/posts/${item.id}" data-own-page>
  <header>
    ${ownerFace(ctx)}
    <span class="what"><strong>You</strong></span>
    <a class="when" href="/posts/${item.id}" title="${fmtDatetime(item.created_at)}"><time>${fmtAgo(item.created_at)}</time></a>
    ${sign && moreMenu([item.editable && !item.event && menuEdit(`edit-i-${item.id}`), commentsSwitch(item.id, Boolean(list?.commentsOff), back),
      signedDelete(action, "Delete this post, its photos and its comments? This can’t be undone.", sign, { back, inplace: "remove" })], "More")}
  </header>
  ${item.text && html`<div class="text">${linkify(item.text, item.mentions)}</div>`}
  ${edited(item)}
  ${sign && item.editable && !item.event && signedEdit(`edit-i-${item.id}`, `i-${item.id}`, action, item.text, back, MAX_POST_TEXT, sign,
    { required: !item.media?.length || Boolean(item.poll) })}
  ${collage(item.media, { back: `${back}#i-${item.id}` })}
  ${item.poll && pollBlock(ctx, item.poll, { id: `poll-${item.id}`, action, whoNote: PUBLIC_POLL,
    sign: list ? signAttrs("vote", list, item.id, { version: item.version }) : "", closeAction: list ? action : null, closeSign: list ? signAttrs("end", list, item.id) : "" })}
  ${item.event && eventBlock(ctx, item.event, { href: `/posts/${item.id}`, full: open, ics: `/posts/${item.id}/event.ics`, edit: `/posts/${item.id}/event`,
    cancel: list ? action : null, cancelSign: list ? signAttrs("event-cancel", list, item.id) : "",
    cancelNote: "Call this event off? Everyone invited who hasn't said no will be told.", note: "Your event. Only the people you invite can see it." })}
  ${item.event && open && list && guestsSigned(ctx, item, list)}
  <details class="comments"${open && raw(" open")} data-thread="/posts/${item.id}">
    ${commentsButton(item.comments)}
    ${thread && list ? itemThread(ctx, item, thread, list, { moderate: OWN }) : html`<section class="thread" id="t-${item.id}" aria-label="Comments"></section>`}
  </details>
</article>`;
}

/** An item's own page: the item, its comments open. */
export function itemPage(ctx, { item, thread, list }) {
  return page(ctx, "Post", html`
<p class="crumbs"><a href="/">Home</a> /</p>
<div class="feed">${itemCard(ctx, item, { thread, list, open: true })}</div>`);
}

/**
 * Deleting one photo from a post (items.js removePhoto), from the photo's page: signed twice in the browser (ui/sign.js
 * "photo-delete"): a delete on the photo's own list, and the owner's change to the post listing the photos left.
 */
export function photoDelete(photoItem, post) {
  const photo = photoItem.photo;
  const left = post.photos.filter((p) => p.item !== photo.id);
  const attrs = raw(` data-sign="photo-delete" data-sign-item="${photo.id}" data-sign-host="${photo.list.host}" data-sign-seen-n="${photoItem.list.seen.n}"`
    + ` data-sign-seen-h="${photoItem.list.seen.h}" data-sign-prev="${photo.list.mine}" data-sign-about="${photo.id}"`
    + ` data-sign-post-item="${post.id}" data-sign-post-host="${post.list.host}" data-sign-post-seen-n="${post.list.seen.n}"`
    + ` data-sign-post-seen-h="${post.list.seen.h}" data-sign-post-prev="${post.list.mine}"`);
  return html`<form method="post" action="/_admin/items/${photo.id}/remove-photo" data-confirm="Delete this photo and its comments? This can’t be undone." data-confirm-ok="Delete"${attrs}
    data-sign-post-photos="${JSON.stringify(left)}"><button class="chip danger">Delete photo</button></form>`;
}

/**
 * A friend's signed post (friendcopies.js), as Home and their page show it: the same markup as a friend's post today
 * (friends.js remoteCard), its comments behind the button, read from its own page here, which reads and checks them
 * from their site. `thread`: its comments (open), with `list` for the signed forms.
 */
export function friendItemCard(ctx, item, { thread = null, list = null, open = false, problem = null, back = null } = {}) {
  const c = item.connection;
  const page = `/friend/${c.id}/posts/${item.id}`;
  const n = item.photos.length;
  // Votes and answers are signed here and passed on by this site (friendcopies.js relayRecord), from where its list is
  // up to: as its thread was just read, or as its site last sent it.
  const relay = `/_admin/friend/${c.id}/items/${item.id}/records`;
  const signing_ = list ?? item.list ?? null;
  // A photo opened from here pages through this post's photos, and ✕ comes back here.
  const stay = `?${new URLSearchParams({ in: "post", back: back ?? `${ctx.url.pathname}${ctx.url.search}#fi${c.id}-${item.id}` })}`;
  return html`<article class="card social from-friend" id="fi${c.id}-${item.id}" data-region="${page}" data-own-page data-who="${c.origin}" data-name="${c.name}">
  <header>
    ${friendFace(ctx, c)}
    <span class="what"><a href="/friend/${c.id}/posts"><strong>${c.name}</strong></a></span>
    <a class="when" href="${page}" title="${fmtDatetime(item.created_at)}"><time>${fmtAgo(item.created_at)}</time></a>
    ${!item.muted && moreMenu([muteButton({ person: item.author, name: c.name, back: `${ctx.url.pathname}${ctx.url.search}` })], "More")}
  </header>
  ${item.text && html`<div class="text">${linkify(item.text, item.mentions)}</div>`}
  ${edited(item)}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${item.photos.slice(0, 4).map((m, i) => html`<a href="${page}/photos/${i + 1}${stay}" class="tile"><img src="${m.thumbSrc}" alt="" loading="lazy"${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
      ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}</a>`)}
  </div>`}
  ${item.poll && pollBlock(ctx, item.poll, { id: `poll-${item.id}`, action: relay, whoNote: PUBLIC_POLL,
    sign: signing_ ? signAttrs("vote", signing_, item.id, { version: item.version }) : "" })}
  ${item.event && eventBlock(ctx, item.event, { href: page, full: open, ics: `${page}/event.ics`,
    answer: signing_ ? { action: relay, sign: signAttrs("answer", signing_, item.id, { version: item.version }) } : null,
    note: `${c.name}'s event. Only the people ${c.name} invited can see it.` })}
  ${problem && html`<p class="notice alert">${problem}</p>`}
  <details class="comments"${open && raw(" open")} data-thread="${page}">
    ${commentsButton(item.comments)}
    ${thread && list ? itemThread(ctx, item, thread, list, { action: `/_admin/friend/${c.id}/items/${item.id}/records`, owner: { name: c.name, person: item.author },
      report: { href: `/friend/${c.id}/report`, label: `Tell ${c.name}`, post: item.id } })
      : html`<section class="thread" id="t-${item.id}" aria-label="Comments"></section>`}
  </details>
</article>`;
}

/** A friend's signed post's own page here: the post, its comments read from their site and checked, open. */
export function friendItemPage(ctx, { item, thread, list, problem }) {
  return page(ctx, item.connection.name, html`
<p class="crumbs"><a href="/friend/${item.connection.id}/posts">${item.connection.name}</a> /</p>
<div class="feed">${friendItemCard(ctx, item, { thread, list, open: true, problem })}</div>`);
}

/**
 * A photo in a friend's signed post (friendcopies.js), from the post: the photo itself, from their site by its link,
 * paging through the post's photos, ✕ back to where it was opened from, and the photo's own comments (its own item,
 * read from their site and checked), then the post it's in.
 */
export function friendItemPhotoPage(ctx, { item, index, back, thread, list, problem, postThread = null, postProblem = null }) {
  const c = item.connection;
  const m = item.photos[index - 1];
  const stay = `?${new URLSearchParams({ in: "post", back })}`;
  const base = `/friend/${c.id}/posts/${item.id}/photos`;
  const main = html`
<main class="theatre">
  <section class="stage">
    <img src="${m.src}" style="background-image: url('${m.thumbSrc}')" alt=""${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
    <a class="close" id="close" href="${back}" title="Back (Esc)" aria-label="Back to the post">✕</a>
    ${item.photos.length > 1 && html`<span class="counter">${index} / ${item.photos.length}</span>`}
    ${index > 1 && html`<a class="nav prev" id="prev" href="${base}/${index - 1}${stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${index < item.photos.length && html`<a class="nav next" id="next" href="${base}/${index + 1}${stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="/friend/${c.id}/posts/${item.id}">${c.name}'s post</a>
    <time class="when">${fmtDatetime(item.created_at)}</time>
    <p class="meta"><a href="/friend/${c.id}/posts">${c.name}</a></p>
    ${postWords(item, postThread)}
    ${(postProblem ?? problem) && html`<p class="notice alert">${postProblem ?? problem}</p>`}
    ${photoComments(ctx, { post: item, photo: { id: m.item }, thread, list, postThread, action: `/_admin/friend/${c.id}/items/${m.item}/records`,
      postAction: `/_admin/friend/${c.id}/items/${item.id}/records`, opts: { owner: { name: c.name, person: item.author },
        report: { href: `/friend/${c.id}/report`, label: `Tell ${c.name}`, post: item.id } } })}
    ${!postThread && fromPost(`/friend/${c.id}/posts/${item.id}`, `${c.name}'s`, item.text)}
  </aside>
</main>
<script nonce="${nonce()}">
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: c.name, bodyClass: "viewer", main });
}

/**
 * On the owner's own event's page (afterwrd 2): who's invited, with their answers and what became of each invitation,
 * taking one back, and inviting more. Each changes who's invited, so each is signed (ui/sign.js event-uninvite,
 * event-invite): the event as it is, with a fingerprint of everyone now invited.
 */
function guestsSigned(ctx, item, list) {
  const e = item.event;
  const back = ctx.url.pathname + ctx.url.search;
  const over = e.cancelled_at || finishedAt(e) < Date.now() / 1000;
  const answers = { going: "Going", maybe: "Maybe", no: "Can't go" };
  const waiting = (g) => (g.delivery === "refused" ? "Their site didn't take the invitation: it may need updating"
    : g.delivery === "unreachable" ? "Their site couldn't be reached, so they haven't been told" : "Not answered yet");
  const action = `/_admin/items/${item.id}/records`;
  return html`<details class="guests" id="guests-${item.id}" open>
  <summary>Who's invited (${e.guests.length})</summary>
  ${e.guests.length ? html`<ul class="guest-list">${e.guests.map((g) => html`<li>
    <span class="name">${g.name}</span> <span class="meta">${g.answer ? answers[g.answer] : waiting(g)}</span>
    <form method="post" action="${action}" data-inplace${raw(signAttrs("event-uninvite", list, item.id))}
      data-confirm="Take back ${g.name}'s invitation? They won't see this event any more, and they aren't told." data-confirm-ok="Take it back">
      <input type="hidden" name="back" value="${back}"><input type="hidden" name="guest" value="${g.id}">
      <button class="chip">Take back</button></form>
  </li>`)}</ul>` : html`<p class="meta">Nobody yet.</p>`}
  ${!over && html`<form method="post" action="${action}" class="stack invite-more"${raw(signAttrs("event-invite", list, item.id))}>
    <input type="hidden" name="back" value="${back}">
    ${guestPicker(item.invitable ?? [], { none: e.guests.length ? "You've invited all your friends." : "You have no friends on afterwrd to invite yet." })}
    ${item.invitable?.length > 0 && html`<div class="actions-row"><button class="chip primary">Invite them</button></div>`}
  </form>`}
</details>`;
}

/** Changing the owner's own event (afterwrd 2): the form, signed as a change (ui/sign.js event-change). */
export function itemEventEditPage(ctx, { item, list }) {
  return page(ctx, "Change the event", html`
<p class="crumbs"><a href="/events">Events</a> /</p>
<section class="card">
  <h2>Change the event</h2>
  <p class="meta">If you change its name, time or place, everyone invited who hasn't said no is told. Its times are in
  ${item.event.time_zone.replace(/_/g, " ")} time.</p>
  ${eventForm({ action: `/_admin/items/${item.id}/records`, back: `/posts/${item.id}`, values: eventFormValues(item.event),
    text: item.text ?? "", submit: "Save", sign: signAttrs("event-change", list, item.id) })}
</section>`);
}

// --- a signed group's posts (step 6c: groupcopies.js) ----------------------------------------------------------------------

const ROLE_RUNS = new Set(["owner", "admin"]);
const EDIT_SECONDS = 15 * 60;

/**
 * Whom the owner here may remove things of in group `g` (its membership here, with its role), given its owner's identity
 * (`ownerPerson`): running it, anyone's but their own; as an admin, not the owner's.
 */
export const mayModerate = (g, ownerPerson, me) => (person) => ROLE_RUNS.has(g.role) && person !== me && (g.role === "owner" || person !== ownerPerson);

/**
 * A post in a signed group (groupcopies.js), as its page and the group's pages show it: as a friend's signed post is
 * drawn (friendItemCard), with its writer named, and, for the owner here, Edit and Delete on their own, and, running the
 * group, Remove on others' (and calling off their events).
 */
export function groupItemCard(ctx, g, item, { thread = null, list = null, open = false, problem = null, back = null, ownerPerson = null } = {}) {
  const base = `/groups/${g.id}/posts/${item.id}`;
  const relay = `/_groups/${g.id}/items/${item.id}/records`;
  const signing_ = list ?? item.list ?? null;
  const here = back ?? `${ctx.url.pathname}${ctx.url.search}`;
  const n = item.photos.length;
  const may = mayModerate(g, ownerPerson, signing_?.me ?? null);
  const sign = signing_ && { item: item.id, host: signing_.host, seen: signing_.seen, prev: signing_.mine, about: item.id };
  const editable = item.mine && !item.event && Date.now() / 1000 - item.created_at < EDIT_SECONDS && !item.comments && !(item.poll?.voters > 0);
  const stay = `?${new URLSearchParams({ in: "post", back: `${here}#gi-${item.id}` })}`;
  // From someone the owner's blocked (blocks.js): folded away.
  if (item.blocked && !item.mine) return html`<p class="card meta blocked" id="gi-${item.id}">Hidden: a post from someone you've blocked.</p>`;
  // From someone the owner's muted (mutes.js): one line, except on the post's own page, where it's what they came for.
  if (item.muted && !item.mine && !open) {
    return html`<p class="card meta muted" id="gi-${item.id}">A post from ${item.name}, whom you've muted. <a href="${base}">Show it</a></p>`;
  }
  return html`<article class="card social in-group" id="gi-${item.id}" data-region="${base}" data-own-page data-person="${item.author}" data-name="${item.mine ? ctx.ownerName : item.name}">
  <header>
    ${item.mine ? ownerFace(ctx) : html`<span class="who who-${item.created_at % 6}" aria-hidden="true">${initial(item.name)}</span>`}
    <span class="what"><strong>${item.mine ? "You" : item.name}</strong></span>
    <a class="when" href="${base}" title="${fmtDatetime(item.created_at)}"><time>${fmtAgo(item.created_at)}</time></a>
    ${sign && moreMenu([editable && menuEdit(`edit-gi-${item.id}`),
      item.mine && signedDelete(relay, "Delete this post, its photos and its comments? This can’t be undone.", sign, { back: `/groups/${g.id}`, inplace: "remove" }),
      !item.mine && may(item.author) && signedRemove(relay, "Remove this post, its photos and its comments from the group? This can’t be undone.", sign,
        { back: `/groups/${g.id}`, inplace: "remove", group: g.id }),
      !item.mine && html`<a href="/groups/${g.id}/report?${new URLSearchParams({ item: item.id, about: item.id, post: item.id, back: here })}">Tell the admins</a>`,
      !item.mine && muteButton({ person: item.author, name: item.name, back: open ? here : `/groups/${g.id}`, muted: item.muted })], "More")}
  </header>
  ${item.text && html`<div class="text">${linkify(item.text, item.here ? [...item.mentions, { name: "here" }] : item.mentions)}</div>`}
  ${edited(item)}
  ${sign && editable && signedEdit(`edit-gi-${item.id}`, `gi-${item.id}`, relay, item.text, here, MAX_POST_TEXT, sign, { required: !n || Boolean(item.poll) })}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${item.photos.slice(0, 4).map((m, i) => html`<a href="${base}/photos/${i + 1}${stay}" class="tile"><img src="${m.thumbSrc}" alt="" loading="lazy"${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
      ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}</a>`)}
  </div>`}
  ${item.poll && pollBlock(ctx, item.poll, { id: `poll-${item.id}`, action: relay, whoNote: "Everyone in the group can see who chose what.",
    sign: signing_ ? signAttrs("vote", signing_, item.id, { version: item.version }) : "",
    closeAction: item.mine && signing_ ? relay : null, closeSign: item.mine && signing_ ? signAttrs("end", signing_, item.id) : "" })}
  ${item.event?.rrule && repeatingSigned(ctx, item.event, { base, relay, full: open, edit: item.mine ? `${base}/edit` : null,
    sign: (kind, d) => {
      if (!signing_) return "";
      // Each date's own list, as the group last sent where it's up to (none yet: nobody has answered).
      const day = d?.list ?? { ...item.event.listBase, seen: null, mine: null };
      if (kind === "answer") return signAttrs("answer", day, item.id, { version: item.version, date: d.date });
      if (kind === "calloff") return item.mine || may(item.author) ? signAttrs("calloff", day, item.id, { about: item.id, group: item.mine ? null : g.id, date: d.date }) : "";
      return item.mine ? signAttrs("event-cancel", signing_, item.id, { group: g.id })
        : may(item.author) ? signAttrs("calloff", signing_, item.id, { about: item.id, group: g.id }) : "";
    } })}
  ${item.event && !item.event.rrule && eventBlock(ctx, item.event, { href: base, full: open, ics: `${base}/event.ics`, edit: item.mine ? `${base}/edit` : null,
    answer: signing_ ? { action: relay, sign: signAttrs("answer", signing_, item.id, { version: item.version }) } : null,
    cancel: signing_ && (item.mine || may(item.author)) ? relay : null,
    cancelSign: !signing_ ? "" : item.mine ? signAttrs("event-cancel", signing_, item.id, { group: g.id })
      : signAttrs("calloff", signing_, item.id, { about: item.id, group: g.id }),
    cancelNote: "Call this event off? Everyone going, or who might, will be told.", note: "Everyone in the group can see it." })}
  ${problem && html`<p class="notice alert">${problem}</p>`}
  <details class="comments"${open && raw(" open")} data-thread="${base}">
    ${commentsButton(item.comments)}
    ${thread && list ? itemThread(ctx, item, thread, list, { action: relay, moderate: { group: g.id, may },
      report: { href: `/groups/${g.id}/report`, label: "Tell the admins", post: item.id } })
      : html`<section class="thread" id="t-${item.id}" aria-label="Comments"></section>`}
  </details>
</article>`;
}

/**
 * A photo in a signed group's post: the photo, from the group's site by its link, paging through the post's photos,
 * ✕ back to where it was opened from, and the photo's own comments (its own item, read from the group and checked).
 */
export function signedGroupPhoto(ctx, { membership: g, group: info, item, index, back, thread, list, problem, ownerPerson, postThread = null, postProblem = null }) {
  const m = item.photos[index - 1];
  const stay = `?${new URLSearchParams({ in: "post", back })}`;
  const base = `/groups/${g.id}/posts/${item.id}/photos`;
  const main = html`
<main class="theatre">
  <section class="stage">
    <img src="${m.src}" style="background-image: url('${m.thumbSrc}')" alt=""${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
    <a class="close" id="close" href="${back}" title="Back (Esc)" aria-label="Back to the post">✕</a>
    ${item.photos.length > 1 && html`<span class="counter">${index} / ${item.photos.length}</span>`}
    ${index > 1 && html`<a class="nav prev" id="prev" href="${base}/${index - 1}${stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${index < item.photos.length && html`<a class="nav next" id="next" href="${base}/${index + 1}${stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="/groups/${g.id}">${info?.name ?? g.name}</a>
    <time class="when">${fmtDatetime(item.created_at)}</time>
    ${postWords(item, postThread)}
    ${(postProblem ?? problem) && html`<p class="notice alert">${postProblem ?? problem}</p>`}
    ${photoComments(ctx, { post: item, photo: { id: m.item }, thread, list, postThread, action: `/_groups/${g.id}/items/${m.item}/records`,
      postAction: `/_groups/${g.id}/items/${item.id}/records`, opts: { moderate: { group: g.id, may: mayModerate(g, ownerPerson, (postThread?.list ?? list)?.me) },
        report: { href: `/groups/${g.id}/report`, label: "Tell the admins", post: item.id } } })}
    ${!postThread && fromPost(`/groups/${g.id}/posts/${item.id}`, item.mine ? "your" : item.name ? `${item.name}'s` : "the", item.text)}
  </aside>
</main>
<script nonce="${nonce()}">
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: info?.name ?? g.name, bodyClass: "viewer", main });
}

/** Changing an event the owner here added to a signed group: the form, signed as a change (ui/sign.js event-change). */
export function groupItemEventForm(g, item, list) {
  // One that repeats can change how (step 6d), but can't stop; one that doesn't can't start.
  return eventForm({ action: `/_groups/${g.id}/items/${item.id}/records`, back: `/groups/${g.id}/posts/${item.id}`, values: eventFormValues(item.event),
    text: item.text ?? "", submit: "Save", sign: signAttrs("event-change", list, item.id, { group: g.id }), repeats: item.event.rrule ? "only" : false });
}
