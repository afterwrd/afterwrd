// Telling whoever runs a space about something (reports.js; docs/safety-plan.md 3.3): the form, and what's been raised,
// for those who look after it (the owner's own posts at /reports; a group's admins at /groups/<id>/reports).
import { REASONS, MAX_NOTE, MAX_WORD } from "../reports.js";
import { fmtAgo, fmtDatetime } from "./format.js";
import { html } from "./html.js";
import { page } from "./layout.js";

/** "Tell the admins" or "Tell Ann": what's wrong, anything to add, and whether to be named. */
export function reportFormPage(ctx, { where, place, to, placeName, item, about, post, back, what }) {
  const them = where === "group" ? "the admins" : to;
  return page(ctx, `Tell ${them}`, html`
<h1>Tell ${them}</h1>
<p class="meta">${where === "group" ? html`Only the admins of ${placeName} see this.` : html`Only ${to} sees this.`} Whoever wrote it isn't told.</p>
<blockquote class="reported"><strong>${what.name}</strong> wrote${what.post ? " a post" : ""}:
  ${what.text || (what.photos ? `${what.photos} photo${what.photos === 1 ? "" : "s"}` : "(nothing)")}</blockquote>
<form method="post" action="/_admin/reports/send" class="report">
  <input type="hidden" name="where" value="${where}"><input type="hidden" name="place" value="${place}">
  <input type="hidden" name="item" value="${item}"><input type="hidden" name="about" value="${about}">
  <input type="hidden" name="post" value="${post}"><input type="hidden" name="back" value="${back}">
  <fieldset>
    <legend>What's wrong?</legend>
    ${Object.entries(REASONS).map(([key, label]) => html`<label><input type="radio" name="reason" value="${key}" required> ${label}</label>`)}
  </fieldset>
  <p class="meta">If it might be illegal, you can report it outside afterwrd too: <a href="/help">Getting help</a>.</p>
  <label>Anything to add? <span class="meta">(if you like)</span>
    <textarea name="note" rows="3" maxlength="${MAX_NOTE}"></textarea></label>
  <label><input type="checkbox" name="named" value="1" checked> Let ${them} see it was me</label>
  <p class="meta">Untick this and ${them} won't see it was you, and ${where === "group" ? html`the group's site` : html`${to}'s site`} keeps no
    record of who sent it (though whoever runs it could change that, as they could anything else there).</p>
  <p><button class="chip primary">Tell ${them}</button> <a class="chip" href="${back}">Cancel</a></p>
</form>`);
}

/**
 * What's been raised, for whoever looks after it: open first, then what was dealt with lately. `where`: "own" (the
 * owner's posts) or "group" ({group: {id, name}}). Remove is where the thing is (Go to it); Leave it is here.
 */
export function reportsPage(ctx, { where, group = null, reports }) {
  const link = (r) => (where === "group" ? `/groups/${group.id}/posts/${r.post}#c-${r.about}` : `/posts/${r.post}#c-${r.about}`);
  // Who raised it: those named, and whether anyone chose not to be (not how many: one person could, again another day).
  const by = (r) => (r.reporters.length ? `by ${r.reporters.join(", ")}${r.unnamed ? ", and without a name" : ""}` : "without a name");
  const done = (r) => (r.outcome === "removed" ? "Removed" : r.outcome === "member" ? "Its writer was removed from the group" : "Left")
    + (r.handledByName ? ` by ${r.handledByName}` : "");
  const open = reports.filter((r) => r.open);
  return page(ctx, "Things to look at", html`
<h1>Things to look at</h1>
<p class="meta">${where === "group" ? html`What members of ${group.name} have raised with its admins. Every admin sees this.`
  : html`Comments on your posts that friends have raised with you.`} Whoever wrote something isn't told it was raised.</p>
${open.length === 0 && html`<p class="empty">Nothing waiting.</p>`}
<ul class="reports">
${reports.map((r) => html`<li class="card report${r.open ? " open" : ""}" id="r-${r.about}">
  <p><strong>${r.authorName}</strong> wrote${r.copy.kind === "item" ? " a post" : ""}:</p>
  <blockquote>${r.copy.text || (r.copy.photos ? `${r.copy.photos} photo${r.copy.photos === 1 ? "" : "s"}` : "(nothing)")}</blockquote>
  <p>${r.reasons.join(" · ")}<span class="meta"> · raised ${by(r)} · <time title="${fmtDatetime(r.first)}">${fmtAgo(r.first)}</time></span></p>
  ${r.notes.map((n) => html`<p class="note">“${n}”</p>`)}
  ${r.open ? html`<p><a class="chip" href="${link(r)}">Go to it</a> <span class="meta">to remove it${where === "group" ? ", or remove its writer from Members" : ""}.</span></p>
  <form method="post" action="/_admin/reports/leave">
    <input type="hidden" name="where" value="${where}"><input type="hidden" name="place" value="${group?.id ?? ""}">
    <input type="hidden" name="about" value="${r.about}"><input type="hidden" name="back" value="${ctx.url.pathname}">
    <label>A word back to whoever raised it <span class="meta">(if you like)</span>
      <textarea name="word" rows="2" maxlength="${MAX_WORD}"></textarea></label>
    <button class="chip">Leave it</button>
  </form>` : html`<p class="meta">${done(r)}${r.handledAt ? html` · ${fmtAgo(r.handledAt)}` : ""}${r.word ? html` · “${r.word}”` : ""}</p>`}
</li>`)}
</ul>`);
}
