// afterwrd 2's items as pages show them (step 4a: docs/signed-conversations.md): the owner's own posts, drawn as
// today's own posts are (the same markup as parts.js postCard and thread, so they look the same), with their comments
// behind a button: "Comments" when there are some, "Comment" when there are none. Every form that changes something
// is signed in the browser before it's sent (ui/sign.js, from the form's data-sign-* attributes): the comment box, Edit
// and Delete on a comment, and Edit and Delete on the post itself.
import { MAX_COMMENT } from "../archive/comments.js";
import { MAX_POST_TEXT } from "../edits.js";
import { fmtAgo, fmtDatetime, linkify } from "./format.js";
import { initial } from "./nav.js";
import { html, raw } from "./html.js";
import { layout, page } from "./layout.js";
import { friendFace } from "./friends.js";
import { collage, edited, moreMenu, menuEdit, ownerFace } from "./parts.js";

/** The data-sign-* attributes a signed form carries: what its record says besides its words. */
const signing = (kind, { item, host, seen, prev, about = null }) => raw(` data-sign="${kind}" data-sign-item="${item}" data-sign-host="${host}"`
  + ` data-sign-seen-n="${seen.n}" data-sign-seen-h="${seen.h}" data-sign-prev="${prev ?? ""}"${about ? ` data-sign-about="${about}"` : ""}`);

/** A Delete in the V menu, signed. `inplace`: "remove" (a post) or "refresh" (a comment: its post is drawn again). */
const signedDelete = (action, confirm, sign, { back, inplace }) => html`<form method="post" action="${action}" data-confirm="${confirm}" data-confirm-ok="Delete"${raw(inplace === "remove" ? ' data-inplace="remove"' : " data-inplace")}${signing("delete", sign)}>
    <input type="hidden" name="back" value="${back}"><button class="delete">Delete</button></form>`;

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
 * when something's sent from them (a photo's page), not the post they're in.
 */
export function itemThread(ctx, item, comments, list, { region = false, action = `/_admin/items/${item.id}/records`, owner = null } = {}) {
  const back = ctx.url.pathname + ctx.url.search;
  const sign = { item: item.id, host: list.host, seen: list.seen, prev: list.mine };
  const name = (c) => (c.author === list.me ? ctx.ownerName : c.name ?? "Someone");
  return html`<section class="thread" id="t-${item.id}" aria-label="Comments"${region && raw(' data-region=""')}>
  ${comments.map((c) => (c.state === "ok" ? html`<div class="comment" id="c-${c.fp}"${c.author !== list.me && raw(` data-person="${c.author}"`)}${c.author !== list.me && html` data-name="${name(c)}"`}>
    ${c.author === list.me ? ownerFace(ctx) : html`<span class="who who-${c.n % 6}" aria-hidden="true">${initial(name(c))}</span>`}
    <div class="bubble"><strong>${name(c)}</strong><span class="said">${linkify(c.text, c.mentions)}</span></div>
    <div class="under">
      <time title="${fmtDatetime(c.taken)}">${fmtAgo(c.taken)}</time>
      ${c.author === list.me && moreMenu([c.editable && menuEdit(`edit-c-${c.fp}`),
        signedDelete(action, "Delete this comment?", { ...sign, about: c.fp }, { back, inplace: "refresh" })])}
    </div>
    ${edited(c)}
    ${c.author === list.me && c.editable && signedEdit(`edit-c-${c.fp}`, `c-${c.fp}`, action, c.text, back, MAX_COMMENT, { ...sign, about: c.fp })}
  </div>` : html`<p class="comment gone meta" id="c-${c.fp}">${c.state === "deleted" ? "A comment was deleted."
      : c.state === "removed" ? (c.removedBy === list.me ? "You removed a comment." : c.removedByName ? `A comment was removed by ${c.removedByName}.` : "A comment was removed.")
        : c.state === "failed" ? "A comment here didn't pass its check, so it isn't shown." : "A comment here was left out."}</p>`))}
  <form class="say" method="post" action="${action}" data-inplace data-me="${ctx.ownerName}"${signing("comment", sign)}${owner && html` data-owner-person="${owner.person}" data-owner-name="${owner.name}"`}>
    <input type="hidden" name="back" value="${back}">
    <textarea name="text" data-draft="comment:${item.id}" rows="1" maxlength="${MAX_COMMENT}" required placeholder="Write a comment…" aria-label="Write a comment"></textarea>
    <button>Post</button>
  </form>
</section>`;
}

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
    ${sign && moreMenu([item.editable && menuEdit(`edit-i-${item.id}`),
      signedDelete(action, "Delete this post, its photos and its comments? This can’t be undone.", sign, { back, inplace: "remove" })])}
  </header>
  ${item.text && html`<div class="text">${linkify(item.text, item.mentions)}</div>`}
  ${edited(item)}
  ${sign && item.editable && signedEdit(`edit-i-${item.id}`, `i-${item.id}`, action, item.text, back, MAX_POST_TEXT, sign, { required: !item.media?.length })}
  ${collage(item.media, { back: `${back}#i-${item.id}` })}
  <details class="comments"${open && raw(" open")} data-thread="/posts/${item.id}">
    <summary>${item.comments > 0 ? "Comments" : "Comment"}</summary>
    ${thread && list ? itemThread(ctx, item, thread, list) : html`<section class="thread" id="t-${item.id}" aria-label="Comments"></section>`}
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
  // A photo opened from here pages through this post's photos, and ✕ comes back here.
  const stay = `?${new URLSearchParams({ in: "post", back: back ?? `${ctx.url.pathname}${ctx.url.search}#fi${c.id}-${item.id}` })}`;
  return html`<article class="card social from-friend" id="fi${c.id}-${item.id}" data-region="${page}" data-own-page data-who="${c.origin}" data-name="${c.name}">
  <header>
    ${friendFace(ctx, c)}
    <span class="what"><a href="/friend/${c.id}/posts"><strong>${c.name}</strong></a></span>
    <a class="when" href="${page}" title="${fmtDatetime(item.created_at)}"><time>${fmtAgo(item.created_at)}</time></a>
  </header>
  ${item.text && html`<div class="text">${linkify(item.text, item.mentions)}</div>`}
  ${edited(item)}
  ${n > 0 && html`<div class="collage collage-${Math.min(n, 4)}">
    ${item.photos.slice(0, 4).map((m, i) => html`<a href="${page}/photos/${i + 1}${stay}" class="tile"><img src="${m.thumbSrc}" alt="" loading="lazy"${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
      ${i === 3 && n > 4 && html`<span class="more">+${n - 4}</span>`}</a>`)}
  </div>`}
  ${problem && html`<p class="notice alert">${problem}</p>`}
  <details class="comments"${open && raw(" open")} data-thread="${page}">
    <summary>${item.comments > 0 ? "Comments" : "Comment"}</summary>
    ${thread && list ? itemThread(ctx, item, thread, list, { action: `/_admin/friend/${c.id}/items/${item.id}/records`, owner: { name: c.name, person: item.author } })
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
export function friendItemPhotoPage(ctx, { item, index, back, thread, list, problem }) {
  const c = item.connection;
  const m = item.photos[index - 1];
  const stay = `?${new URLSearchParams({ in: "post", back })}`;
  const base = `/friend/${c.id}/posts/${item.id}/photos`;
  const main = html`
<main class="theatre">
  <section class="stage">
    <img src="${m.src}" style="background-image: url('${m.thumbSrc}')" alt=""${m.width && html` width="${Number(m.width)}" height="${Number(m.height)}"`}>
    <a class="close" id="close" href="${back}" title="Back (Esc)" aria-label="Back to the post">✕</a>
    <span class="counter">${index} / ${item.photos.length}</span>
    ${index > 1 && html`<a class="nav prev" id="prev" href="${base}/${index - 1}${stay}" title="Previous (←)" aria-label="Previous"></a>`}
    ${index < item.photos.length && html`<a class="nav next" id="next" href="${base}/${index + 1}${stay}" title="Next (→)" aria-label="Next"></a>`}
  </section>
  <aside class="info">
    <a class="album-link" href="/friend/${c.id}/posts/${item.id}">${c.name}'s post</a>
    <time class="when">${fmtDatetime(item.created_at)}</time>
    <p class="meta"><a href="/friend/${c.id}/posts">${c.name}</a></p>
    <h2>Comments</h2>
    ${problem && html`<p class="notice alert">${problem}</p>`}
    ${thread && list && itemThread(ctx, { id: m.item }, thread, list, { region: true, action: `/_admin/friend/${c.id}/items/${m.item}/records`,
      owner: { name: c.name, person: item.author } })}
    <h2>Posted with</h2>${friendItemCard(ctx, item, { back })}
  </aside>
</main>
<script>
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const link = document.getElementById({ ArrowLeft: 'prev', ArrowRight: 'next', Escape: 'close' }[e.key]);
    if (link) link.click();
  });
</script>`;
  return layout(ctx, { title: c.name, bodyClass: "viewer", main });
}
