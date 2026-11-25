// Signing what the owner does on a page (afterwrd 2: docs/signed-conversations.md): a form marked data-sign="<kind>"
// (views/items.js) is turned into a record, signed with this browser's key (browserkey.js), and sent as its `sent`
// field. Its data-sign-* attributes say what the record says besides its words: the item, its host, the point in the
// item's list this page saw, the owner's own newest record on it, and what an edit or delete is about.
// "photo-delete" (a photo's page) signs two: the delete on the photo's own list (`sent`), and the owner's change to
// its post, listing the photos left (`change`, from the data-sign-post-* attributes). In a signed group (data-sign-group),
// an admin's "remove" or "calloff" also says where the members list was (role_at).
// Forms sent in place are signed by inplace.js; others here, as they're sent (after any "Are you sure?": confirm.js
// sends the form again).
import { audienceOf, makeRecord, pickedMentions } from "../records.js";
import { b64url } from "../signed.js";
import { savedKey } from "../browserkey.js";

export const CANT_SIGN = "This browser can't sign for you yet. Choose Let this browser sign, on Home or in Your devices.";

// One date of a repeating event (data-sign-date, step 6d) has a list of its own: its first answer saw nothing there
// (data-sign-seen-n empty).
const fieldsOf = (d, prefix, kind, key) => ({
  kind, author: key.person, host: d[`${prefix}Host`], item: d[`${prefix}Item`],
  seen: d[`${prefix}SeenN`] ? { n: Number(d[`${prefix}SeenN`]), h: d[`${prefix}SeenH`] } : null, prev: d[`${prefix}Prev`] || null,
  ...(d[`${prefix}About`] ? { about: d[`${prefix}About`] } : {}),
  ...(d[`${prefix}Version`] ? { version: d[`${prefix}Version`] } : {}),
  ...(d[`${prefix}Date`] ? { date: d[`${prefix}Date`] } : {}),
});

/**
 * An event form (data-sign="event-<op>": new, change, cancel, invite, uninvite) read by the site exactly as it will
 * check it (POST /_admin/events/read), then signed: the event as it now is, and, when who's invited changes, a salted
 * fingerprint of them (records.js audienceOf), whose salt goes with it. A new one is an `item`; the rest are `change`s.
 */
async function signEvent(form, body, key) {
  const d = form.dataset;
  const op = d.sign.slice("event-".length);
  const ask = new FormData();
  for (const [name, value] of body) ask.append(name, value);
  ask.set("op", op);
  ask.set("item", d.signItem ?? "");
  // A signed group's event (step 6c): for everyone in it, so nobody is picked.
  if (d.signGroup) ask.set("group", d.signGroup);
  const res = await fetch("/_admin/events/read", { method: "POST", body: ask });
  const got = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(got.error ?? "That didn't work. Try again.");
  let audience = null;
  let salt = null;
  if (got.guests) {
    salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    audience = { kind: "invited", fp: await audienceOf(salt, got.guests.map((g) => g.person)) };
  }
  const guests = got.guests?.map((g) => g.id) ?? null;
  if (op === "new") {
    const made = await makeRecord({ kind: "item", author: key.person, host: d.signHost || key.person, ...(audience && { audience }) },
      { type: "event", text: got.text, event: got.event }, key);
    return { made, guests, salt };
  }
  const made = await makeRecord({ ...fieldsOf(d, "sign", "change", key), ...(audience && { audience }) }, { event: got.event, text: got.text }, key);
  return { sent: JSON.stringify(made.sent), ...(guests && { guests: JSON.stringify(guests), salt }) };
}

/**
 * In a signed group (step 6c), an admin's remove or calloff says where the members list was when they acted (`role_at`),
 * as their own site has just checked it (POST /_groups/<id>/point).
 */
async function roleAt(d) {
  if (!d.signGroup || (d.sign !== "remove" && d.sign !== "calloff")) return {};
  const res = await fetch(`/_groups/${d.signGroup}/point`, { method: "POST" });
  const got = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(got.error ?? "That didn't work. Try again.");
  return got.role_at ? { role_at: got.role_at } : {};
}

/** The signed fields a form sends ({sent} and, for some, more), each JSON. Throws CANT_SIGN without a key. */
export async function signForm(form, body) {
  const key = await savedKey();
  if (!key?.person || key.expires < Date.now() / 1000) throw new Error(CANT_SIGN);
  const d = form.dataset;
  if (d.sign.startsWith("event-")) return /** @type {Record<string, string>} */ (await signEvent(form, body, key));
  // A vote (the options chosen: none takes it back), an answer (going, maybe or no), a poll's end.
  if (d.sign === "vote" || d.sign === "answer" || d.sign === "end") {
    const content = d.sign === "vote" ? { choices: body.getAll("choice").map(Number) } : d.sign === "answer" ? { answer: String(body.get("answer") ?? "") } : undefined;
    return { sent: JSON.stringify((await makeRecord(fieldsOf(d, "sign", d.sign, key), content, key)).sent) };
  }
  const kind = d.sign === "photo-delete" ? "delete" : d.sign;
  const text = body.get("text");
  const words = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  // A comment's mentions, as the @ list noted them (ui/mentions.js): in the record by identity, and named in its content.
  const { mentions, shown } = kind === "comment" ? pickedMentions(words, body.get("mentions")) : { mentions: [], shown: [] };
  const content = kind === "comment" || kind === "edit" ? { text: words, ...(shown.length && { mentions: shown }) } : undefined;
  const fields = { sent: JSON.stringify((await makeRecord({ ...fieldsOf(d, "sign", kind, key), ...(mentions.length && { mentions }), ...(await roleAt(d)) },
    content, key)).sent) };
  if (d.sign === "photo-delete") {
    const photos = JSON.parse(d.signPostPhotos ?? "[]");
    fields.change = JSON.stringify((await makeRecord(fieldsOf(d, "signPost", "change", key), { photos }, key)).sent);
  }
  return fields;
}

// Signed forms that aren't sent in place: signed, then sent as forms are. A new event goes to the site as a new post
// does (compose.js), then its page opens.
document.addEventListener("submit", async (e) => {
  const form = /** @type {HTMLFormElement} */ (e.target);
  if (e.defaultPrevented || !form.matches("form[data-sign]:not([data-inplace])")) return;
  e.preventDefault();
  try {
    if (form.dataset.sign === "event-new") {
      const key = await savedKey();
      if (!key?.person || key.expires < Date.now() / 1000) throw new Error(CANT_SIGN);
      const button = form.querySelector("button");
      if (button) button.disabled = true;
      const { made, guests, salt } = /** @type {any} */ (await signEvent(form, new FormData(form), key));
      // A signed group's (data-sign-to: step 6c) goes to the group, through the owner's own site.
      const res = await fetch(form.dataset.signTo || "/_admin/items", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sent: made.sent, guests, salt }) });
      const answer = await res.json().catch(() => ({}));
      if (button) button.disabled = false;
      if (!res.ok) throw new Error(answer.error ?? "That didn't work. Try again.");
      location.href = answer.go ?? `/posts/${answer.id}`;
      return;
    }
    // The button pressed is part of what's said (an answer's going, maybe or no), and form.submit() leaves it out.
    const submitter = /** @type {HTMLButtonElement | null} */ (/** @type {SubmitEvent} */ (e).submitter);
    const body = new FormData(form, submitter);
    for (const [name, value] of Object.entries(await signForm(form, body))) {
      form.append(Object.assign(document.createElement("input"), { type: "hidden", name, value }));
    }
    if (submitter?.name) form.append(Object.assign(document.createElement("input"), { type: "hidden", name: submitter.name, value: submitter.value }));
    form.submit();
  } catch (err) {
    const note = Object.assign(document.createElement("p"), { className: "form-error", textContent: err.message });
    note.setAttribute("role", "alert");
    form.after(note);
  }
});
