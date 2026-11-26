// Notifications on this device (Your devices; src/push.js): turning them on and off, whether the lock screen shows
// what it's about or only who it's from, and whether mentions buzz it too. They're only for invitations, changes to
// events the owner hasn't said no to, and (unless turned off here) someone mentioning them, or @here in a group. On an iPhone or iPad this needs afterwrd added to the home screen first; Android and computers can do it in
// the browser too.
// Also, on Home, once afterwrd is opened from the home screen: one offer to turn them on (data-offer), until they're on,
// blocked, or "Not now" on this device.
const LATER = "afterwrd-notify-later";

const installed = matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
const apple = /iPhone|iPad/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
  return data;
}
const keyBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const deviceName = () => {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : apple ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "A device";
  return `${kind}${installed ? " (home screen)" : " (browser)"}`;
};
/** Whether this device's notifications are on, as this site has it ({on, preview, mentions}). */
async function stateOf(registration) {
  const subscription = await registration.pushManager.getSubscription();
  // The site may have forgotten this device (its notifications stopped reaching it): then it's off, and can be asked again.
  return subscription ? post("/_push/devices/state", { endpoint: subscription.endpoint }) : { on: false };
}
/** Turns them on for this device (asking for permission: straight from a tap, as some phones only ask then). */
async function turnOn(registration, key) {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !(await post("/_push/devices/state", { endpoint: subscription.endpoint })).on) {
    await subscription.unsubscribe(); // made for a key this site no longer has, or forgotten: start again
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await post("/_push/devices", { ...subscription.toJSON(), name: deviceName(), preview: true });
}

/** Home's offer: shown only in the home-screen app, where they're not on, not blocked, and not put off on this device. */
async function offerOnce(box) {
  let later = false;
  try { later = localStorage.getItem(LATER) === "1"; } catch {}
  if (!installed || later || !supported() || Notification.permission === "denied") return;
  await navigator.serviceWorker.register("/static/app/push-sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  if ((await stateOf(registration)).on) return;
  const status = /** @type {HTMLElement} */ (box.querySelector(".notify-said"));
  box.hidden = false;
  box.querySelector('[data-do="on"]')?.addEventListener("click", async () => {
    status.textContent = "";
    try {
      await turnOn(registration, /** @type {string} */ (box.dataset.key));
    } catch (err) {
      if (Notification.permission !== "denied") { status.textContent = /** @type {Error} */ (err).message; return; }
    }
    const on = (await stateOf(registration).catch(() => ({ on: false }))).on;
    box.querySelector(".row")?.remove();
    status.textContent = on ? "Turned on. Change them any time in Your devices, behind your picture."
      : "Notifications are blocked for afterwrd in this device's settings. Allow them there, then turn them on in Your devices.";
  });
  box.querySelector('[data-do="later"]')?.addEventListener("click", () => {
    try { localStorage.setItem(LATER, "1"); } catch {}
    box.remove();
  });
}

async function notifications(box) {
  const status = document.getElementById("notify-status");
  const problem = document.getElementById("notify-error");
  const on = box.querySelector('[data-do="on"]');
  const off = box.querySelector('[data-do="off"]');
  const previewBox = document.getElementById("notify-preview");
  const preview = previewBox.querySelector("input");
  const mentionsBox = document.getElementById("notify-mentions");
  const mentions = mentionsBox.querySelector("input");
  const say = (text) => { status.textContent = text; };

  if (!supported()) {
    if (apple && !installed) {
      status.textContent = "On an iPhone or iPad, add afterwrd to your home screen first, then open it from there and come back here. ";
      status.append(Object.assign(document.createElement("a"), { href: "/app", textContent: "Show me how" }));
    } else {
      say("This browser can't show notifications.");
    }
    return;
  }

  await navigator.serviceWorker.register("/static/app/push-sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  async function show() {
    const state = await stateOf(registration);
    const blocked = Notification.permission === "denied";
    say(state.on ? "Notifications are on for this device."
      : blocked ? "Notifications are blocked for afterwrd in this device's settings. Allow them there, then come back."
      : "Notifications are off for this device.");
    on.hidden = state.on || blocked;
    off.hidden = !state.on;
    previewBox.hidden = !state.on;
    preview.checked = state.preview !== false;
    mentionsBox.hidden = !state.on;
    mentions.checked = state.mentions !== false;
    document.getElementById("notify-android").hidden = !(state.on && /Android/.test(navigator.userAgent));
  }
  // Straight from the tap: some phones only ask for permission in answer to one.
  on.addEventListener("click", async () => {
    problem.textContent = "";
    try {
      await turnOn(registration, box.dataset.key);
    } catch (err) {
      if (Notification.permission !== "denied") problem.textContent = err.message;
    }
    await show();
  });
  off.addEventListener("click", async () => {
    problem.textContent = "";
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await post("/_push/devices/forget", { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    await show();
  });
  preview.addEventListener("change", async () => {
    problem.textContent = "";
    const subscription = await registration.pushManager.getSubscription();
    try {
      await post("/_push/devices/preview", { endpoint: subscription?.endpoint, preview: preview.checked });
    } catch (err) {
      problem.textContent = err.message;
      await show();
    }
  });
  mentions.addEventListener("change", async () => {
    problem.textContent = "";
    const subscription = await registration.pushManager.getSubscription();
    try {
      await post("/_push/devices/mentions", { endpoint: subscription?.endpoint, mentions: mentions.checked });
    } catch (err) {
      problem.textContent = err.message;
      await show();
    }
  });
  await show();
}

// Started once everything above is set up.
const box = document.getElementById("notify");
if (box?.hasAttribute("data-offer")) offerOnce(box).catch(() => {});
else if (box) notifications(box).catch((err) => { document.getElementById("notify-status").textContent = `Couldn't check this device: ${err.message}`; });

export {};
