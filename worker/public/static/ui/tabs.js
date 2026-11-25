// The header's tabs (Home, Photos, Friends, Groups, Events, Notifications) and the logo work as an app's tabs, so back
// doesn't retrace every tab you've been to: the page's history is only ever Home, then a tab, then the pages you opened
// from there. From Home, a tab adds one step, as a link does. From anywhere else, it doesn't add another:
//   - the logo (or Home) goes back to Home in the history, as you left it;
//   - the tab you opened from Home goes back to it, as it was (a group's post → Groups);
//   - another tab goes back to the page after Home and takes its place. A short cookie names that page and the tab:
//     asked for again, the site answers with a page that goes straight on instead of drawing it (app.js onwardPage);
//     shown from the browser's cache, the page's head goes on before it's drawn (nav.js onward()); brought back as it
//     was (the back/forward cache), this script goes on (below).
// So back from any tab is Home, and back from Home leaves afterwrd. (Places are taken, never added without a tap:
// Chrome skips back over a page that added one by itself.) Going back needs the Navigation API (Chrome, Edge, the
// home-screen app on Android) to find Home in the history; elsewhere, or with no Home behind (a page opened from a
// link), the tab takes this page's place instead, which gets most of the way. Without scripts: plain links, as before.

const ONWARD = "afterwrd_onward"; // app.js ONWARD_COOKIE
const TABS = "header.site nav.main a[href], header.site a.brand[href]";
const nav = /** @type {any} */ (globalThis).navigation;
/** A same-site address as path and query (no #part), or null. */
const pathOf = (href) => {
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin ? url.pathname + url.search : null;
  } catch { return null; }
};
/** Where a tab switch is going, through which page: {from, to}, or null to forget it. */
const setOnward = (way) => {
  document.cookie = `${ONWARD}=${way ? encodeURIComponent(JSON.stringify(way)) : ""}; path=/; max-age=${way ? 15 : 0}; samesite=strict`;
};
const onward = () => {
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ONWARD}=`))?.slice(ONWARD.length + 1);
  try { return value ? JSON.parse(decodeURIComponent(value)) : null; } catch { return null; }
};
const here = () => location.pathname + location.search;

document.addEventListener("click", (e) => {
  const link = /** @type {HTMLAnchorElement | null} */ (/** @type {Element} */ (e.target).closest?.(TABS));
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const to = pathOf(link.href);
  if (!to || location.pathname === "/") return; // from Home: an ordinary link, one step
  e.preventDefault();
  const entries = nav?.entries?.() ?? [];
  const now = nav?.currentEntry?.index ?? -1;
  let home = -1;
  for (let i = now - 1; i >= 0; i--) {
    if (pathOf(entries[i]?.url ?? "") === "/") { home = i; break; }
  }
  const after = entries[home + 1];
  if (home < 0 || home + 1 === now) { // no Home behind, or this is the page after it: the tab takes this page's place
    if (to === here()) location.reload();
    else location.replace(link.href);
    return;
  }
  if (to === "/") { nav.traverseTo(entries[home].key); return; }
  const from = pathOf(after?.url ?? "");
  if (from === to) { nav.traverseTo(after.key); return; } // the tab you opened from Home, as it was
  // Only through one of the site's pages (not an action or sign-in under /_, which the site doesn't answer that way).
  if (!from || from.startsWith("/_")) { location.replace(link.href); return; }
  setOnward({ from, to });
  nav.traverseTo(after.key);
});

// The page after Home brought back as it was (the back/forward cache, so the site wasn't asked), on the way to a tab:
// not shown, and its place taken.
addEventListener("pageshow", (e) => {
  if (!/** @type {PageTransitionEvent} */ (e).persisted) return;
  const way = onward();
  if (!way || way.from !== here()) return;
  setOnward(null);
  if (typeof way.to !== "string" || !way.to.startsWith("/") || way.to.startsWith("//")) return;
  document.documentElement.dataset.onward = "";
  // Not while the page is still being brought back: Chrome can drop a move started then. Tried again if it was.
  const from = here();
  const go = () => { if (here() === from) location.replace(way.to); };
  setTimeout(go, 0);
  setTimeout(go, 1500);
});
// Anywhere else, a cookie left over (the page wasn't reached) shouldn't send that page on later.
if (onward()) setOnward(null);

export {};
