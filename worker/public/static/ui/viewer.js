// The photo viewer (body.viewer): moving to the next or previous photo takes the place of the one you were on, rather
// than adding to the page's history, so back (or ✕) returns to wherever you opened it from, not through every photo.
// ✕ goes back the same way when that's where it leads; opened from a link elsewhere, it goes where it says.

const FROM = "afterwrd-viewer-from";
const PAGING = "afterwrd-viewer-paging";
const pathOf = (href) => { try { const u = new URL(href, location.href); return u.origin === location.origin ? u.pathname + u.search : null; } catch { return null; } };
const store = (key, value) => { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch {} };
const read = (key) => { try { return sessionStorage.getItem(key); } catch { return null; } };

if (document.body?.classList.contains("viewer")) {
  // Where this run of photos was opened from: kept while paging through them, else the page that opened this one.
  if (read(PAGING)) store(PAGING, null);
  else store(FROM, pathOf(document.referrer));
  document.addEventListener("click", (e) => {
    const link = /** @type {HTMLAnchorElement | null} */ (/** @type {Element} */ (e.target).closest?.(".stage a.nav, .stage a.close"));
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (link.classList.contains("close")) {
      // Back to where it was opened, as it was (scrolled to the same place), if that's where ✕ leads.
      const from = read(FROM);
      store(FROM, null);
      if (from && from === pathOf(link.href) && history.length > 1) history.back();
      else location.href = link.href;
      return;
    }
    store(PAGING, "1");
    location.replace(link.href);
  });
}

export {};
