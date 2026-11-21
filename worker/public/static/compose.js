// The owner's composer on Home and Posts: text and up to 20 photos (prepared and uploaded by upload.js), and perhaps a
// poll (the text is its question; src/polls.js), then the post is signed here and saved (src/items.js). In a group, the
// form says where it goes and how many photos it takes (src/groups.js), and the post isn't signed yet.
import { call, picker, uploadPhotos } from "./upload.js";

const form = /** @type {HTMLFormElement} */ (document.getElementById("composer"));
const MAX_PHOTOS = Number(form.dataset.max) || 20;
const MAX_OPTIONS = 10;
const ACTION = form.dataset.action || null; // a group's; none for the owner's own signed posts
const input = /** @type {HTMLInputElement} */ (form.querySelector("input[type=file]"));
const status = /** @type {HTMLElement} */ (form.querySelector(".status"));
const error = /** @type {HTMLElement} */ (form.querySelector(".error"));
const button = /** @type {HTMLButtonElement} */ (form.querySelector("button.post"));
const picked = picker(input, /** @type {HTMLElement} */ (form.querySelector(".picked")), {
  max: MAX_PHOTOS,
  onChange: (list) => { error.textContent = list.length > MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos in a post.` : ""; },
});

// The poll: hidden until asked for.
const poll = /** @type {HTMLFieldSetElement} */ (form.querySelector(".poll-maker"));
const addPoll = /** @type {HTMLButtonElement} */ (form.querySelector(".add-poll"));
const options = /** @type {HTMLElement} */ (poll.querySelector(".poll-options"));
const addOption = /** @type {HTMLButtonElement} */ (poll.querySelector(".add-option"));
const closes = /** @type {HTMLInputElement} */ (poll.querySelector("input[name=closes]"));
const placeholder = form.text.placeholder;
const pad = (n) => String(n).padStart(2, "0");
const today = new Date();
closes.min = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

function showPoll(on) {
  poll.hidden = !on;
  addPoll.hidden = on;
  form.text.placeholder = on ? "Ask a question" : placeholder;
  if (on) (form.text.value.trim() ? options.querySelector("input") : form.text).focus();
  else addPoll.focus();
}
addPoll.addEventListener("click", () => showPoll(true));
poll.querySelector(".remove-poll").addEventListener("click", () => showPoll(false));
addOption.addEventListener("click", () => {
  const n = options.children.length + 1;
  if (n > MAX_OPTIONS) return;
  const item = document.createElement("li");
  const box = Object.assign(document.createElement("input"), { name: "option", maxLength: 100, placeholder: `Option ${n}` });
  box.setAttribute("aria-label", `Option ${n}`);
  item.append(box);
  options.append(item);
  box.focus();
  addOption.hidden = n >= MAX_OPTIONS;
});

/** The poll to send, or null; throws with a message if it isn't ready. */
function readPoll(text) {
  if (poll.hidden) return null;
  if (!text) throw new Error("Write the question your poll asks.");
  const list = [...options.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  if (list.length < 2) throw new Error("Give your poll at least two options.");
  // A closing day ends at midnight, wherever the person asking is.
  const day = closes.value ? new Date(`${closes.value}T23:59:59`) : null;
  if (day && !(day > new Date())) throw new Error("Pick a closing day that hasn't gone yet.");
  return { options: list, multiple: /** @type {HTMLInputElement} */ (poll.querySelector("input[name=multiple]")).checked, closes_at: day ? Math.floor(day.getTime() / 1000) : null };
}

function busy(on) {
  button.disabled = on;
  form.text.readOnly = on;
  input.disabled = on;
  poll.disabled = on;
  addPoll.disabled = on;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = form.text.value.trim();
  if (!text && !picked.length && poll.hidden) {
    form.text.focus();
    return;
  }
  if (picked.length > MAX_PHOTOS) return;
  let question;
  try {
    question = readPoll(text);
  } catch (err) {
    error.textContent = err.message;
    return;
  }
  busy(true);
  error.textContent = "";
  try {
    const photos = await uploadPhotos(picked.map((p) => p.file), (message) => { status.textContent = message; });
    status.textContent = "Posting…";
    // Who it mentions, as picked (ui/mentions.js): the site keeps those whose @name is still in the words.
    const mentions = /** @type {HTMLInputElement | null} */ (form.querySelector("input[name=mentions]"))?.value ?? null;
    if (!ACTION) {
      // The owner's own post (and any poll in it) is a record signed here, with this browser's key (src/items.js).
      // (Groups follow in a later step.)
      const [{ makeRecord, pickedMentions }, { savedKey }, { CANT_SIGN }] = await Promise.all([import("./records.js"), import("./browserkey.js"), import("./ui/sign.js")]);
      const key = await savedKey();
      if (!key?.person || key.expires < Date.now() / 1000) throw new Error(CANT_SIGN);
      // Each photo is an item of its own (its own page and comments), signed first; the post lists them.
      const fields = ["hash", "thumb_hash", "width", "height", "size"];
      const own = { kind: "item", author: key.person, host: key.person };
      const madePhotos = [];
      for (const p of photos) madePhotos.push(await makeRecord(own, { type: "photo", ...Object.fromEntries(fields.map((f) => [f, p[f]])) }, key));
      const listed = photos.map((p, i) => ({ item: madePhotos[i].fp, ...Object.fromEntries(fields.map((f) => [f, p[f]])) }));
      // Who it mentions: in the record by identity, and named in its content.
      const picked = pickedMentions(text, mentions);
      // A poll, as the site keeps one (polls.js readPoll): its options tidied, one choice or several, when it closes.
      const poll = question && { options: question.options.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean),
        multiple: question.multiple ? 1 : 0, closes_at: question.closes_at ?? null };
      const made = await makeRecord({ ...own, ...(picked.mentions.length && { mentions: picked.mentions }) },
        { type: "post", text, photos: listed, ...(poll && { poll }), ...(picked.shown.length && { mentions: picked.shown }) }, key);
      await call("/_admin/items", { sent: made.sent, photos: madePhotos.map((m) => m.sent) });
    } else {
      await call(ACTION, { text, photos, ...(question && { poll: question }), ...(mentions && { mentions }) });
    }
    window.afterwrdSent?.(form.text); // it's posted: no need to keep the words on this device (ui.js)
    location.href = location.pathname; // back to the page it was written on (Home or Posts), showing the new post
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
    busy(false);
  }
});
