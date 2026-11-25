// Back closes what's open first (the menu behind your picture, a small V menu), as in an app: Android's back gesture
// (or Escape) shuts it, and only the next back leaves the page. Chrome's CloseWatcher does this without adding to the
// page's history, so a back never does nothing. (Boxes that ask first are dialogs, which close on back by themselves.)
// Where there's no CloseWatcher, back leaves the page, as before.

/** @type {WeakMap<HTMLDetailsElement, any>} */
const watching = new WeakMap();
const Watcher = /** @type {any} */ (globalThis).CloseWatcher;
document.addEventListener("toggle", (e) => {
  const menu = /** @type {HTMLDetailsElement} */ (e.target);
  if (!Watcher || !menu.matches?.("details.more, details.me")) return;
  if (menu.open && !watching.has(menu)) {
    try {
      const watcher = new Watcher();
      watcher.onclose = () => { watching.delete(menu); menu.open = false; };
      watching.set(menu, watcher);
    } catch {} // too many open without a tap in between: back leaves the page, as without
  } else if (!menu.open && watching.has(menu)) {
    const watcher = watching.get(menu);
    watching.delete(menu);
    watcher.destroy();
  }
}, true);

export {};
