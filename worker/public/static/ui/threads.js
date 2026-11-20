// A post's comments, behind its "Comments" (or "Comment") button (views/items.js): opened in place, read from the
// post's own page, so Home only loads the comments someone wants to see. Words half-written there before, and kept on
// this device (drafts.js), are put back.
import { restoreDrafts } from "./drafts.js";

document.addEventListener("toggle", async (e) => {
  const details = /** @type {HTMLDetailsElement} */ (e.target);
  if (!(details instanceof HTMLDetailsElement) || !details.matches("details.comments[data-thread]") || !details.open) return;
  const section = details.querySelector("section.thread");
  if (!section || section.children.length) return;
  try {
    const res = await fetch(details.dataset.thread, { cache: "no-store" });
    if (!res.ok) return;
    const fresh = new DOMParser().parseFromString(await res.text(), "text/html").getElementById(section.id);
    if (!fresh) return;
    section.replaceWith(document.adoptNode(fresh));
    restoreDrafts(fresh);
  } catch {}
}, true);
