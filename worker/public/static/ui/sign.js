// Signing what the owner does on a page (afterwrd 2: docs/signed-conversations.md): a form marked data-sign="<kind>"
// (views/items.js) is turned into a record, signed with this browser's key (browserkey.js), and sent as its `sent`
// field. Its data-sign-* attributes say what the record says besides its words: the item, its host, the point in the
// item's list this page saw, the owner's own newest record on it, and what an edit or delete is about.
// "photo-delete" (a photo's page) signs two: the delete on the photo's own list (`sent`), and the owner's change to
// its post, listing the photos left (`change`, from the data-sign-post-* attributes).
// Forms sent in place are signed by inplace.js; others here, as they're sent (after any "Are you sure?": confirm.js
// sends the form again).
import { makeRecord } from "../records.js";
import { savedKey } from "../browserkey.js";

export const CANT_SIGN = "This browser can't sign for you yet. Sign out and sign in again, or set up signing in Your devices.";

const fieldsOf = (d, prefix, kind, key) => ({
  kind, author: key.person, host: d[`${prefix}Host`], item: d[`${prefix}Item`],
  seen: { n: Number(d[`${prefix}SeenN`]), h: d[`${prefix}SeenH`] }, prev: d[`${prefix}Prev`] || null,
  ...(d[`${prefix}About`] ? { about: d[`${prefix}About`] } : {}),
});

/** The signed fields a form sends ({sent} and, for some, more), each JSON. Throws CANT_SIGN without a key. */
export async function signForm(form, body) {
  const key = await savedKey();
  if (!key?.person || key.expires < Date.now() / 1000) throw new Error(CANT_SIGN);
  const d = form.dataset;
  const kind = d.sign === "photo-delete" ? "delete" : d.sign;
  const text = body.get("text");
  const content = kind === "comment" || kind === "edit" ? { text: String(text ?? "").replace(/\r\n?/g, "\n").trim() } : undefined;
  const fields = { sent: JSON.stringify((await makeRecord(fieldsOf(d, "sign", kind, key), content, key)).sent) };
  if (d.sign === "photo-delete") {
    const photos = JSON.parse(d.signPostPhotos ?? "[]");
    fields.change = JSON.stringify((await makeRecord(fieldsOf(d, "signPost", "change", key), { photos }, key)).sent);
  }
  return fields;
}

// Signed forms that aren't sent in place: signed, then sent as forms are.
document.addEventListener("submit", async (e) => {
  const form = /** @type {HTMLFormElement} */ (e.target);
  if (e.defaultPrevented || !form.matches("form[data-sign]:not([data-inplace])")) return;
  e.preventDefault();
  try {
    for (const [name, value] of Object.entries(await signForm(form, new FormData(form)))) {
      form.append(Object.assign(document.createElement("input"), { type: "hidden", name, value }));
    }
    form.submit();
  } catch (err) {
    const note = Object.assign(document.createElement("p"), { className: "form-error", textContent: err.message });
    note.setAttribute("role", "alert");
    form.after(note);
  }
});
