// A group's signed members list (afterwrd 2, step 6b: src/members.js): a button with data-group-record="<kind>" (join,
// approve, remove, role, leave) signs that record in this browser and has the owner's site pass it on. The site says
// first where the list is up to (what the record says it saw); the button says what it's about: data-group (the group's
// number here) or data-link (an invite link, to join), data-about (a member's join), data-role (for role), and
// data-ask (a question to ask first). Then the page opens again, or where the site says.
import { makeRecord } from "../records.js";
import { savedKey } from "../browserkey.js";
import { askFirst } from "./confirm.js";
import { CANT_SIGN } from "./sign.js";

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
  return data;
}

document.addEventListener("click", async (e) => {
  const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.("button[data-group-record]"));
  if (!button) return;
  e.preventDefault();
  const d = button.dataset;
  const error = document.getElementById("error") ?? button.parentElement;
  try {
    if (d.ask && !(await askFirst(d.ask, { ok: d.askOk ?? "OK" }))) return;
    button.disabled = true;
    const key = await savedKey();
    if (!key?.person || key.expires < Date.now() / 1000) throw new Error(CANT_SIGN);
    const kind = d.groupRecord;
    const joining = kind === "join";
    const at = await post(joining ? "/_groups/join/point" : `/_groups/${d.group}/point`, joining ? { link: d.link } : {});
    const fields = { kind, author: key.person, host: at.host, item: at.item, seen: at.seen ?? null, prev: at.prev ?? null,
      ...(d.about && { about: d.about }), ...(at.role_at && ["approve", "remove", "role"].includes(kind) && { role_at: at.role_at }) };
    const made = await makeRecord(fields, kind === "role" ? { role: d.role } : joining ? { name: at.name } : undefined, key);
    const done = await post(joining ? "/_groups/join" : `/_groups/${d.group}/records`, { sent: made.sent, ...(joining && { link: d.link }) });
    if (joining) location.assign(`/groups/${done.id}`);
    else if (done.go) location.assign(done.go);
    else location.reload();
  } catch (err) {
    button.disabled = false;
    if (error) error.textContent = /** @type {Error} */ (err).message;
  }
});
