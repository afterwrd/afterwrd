// Bringing what the owner wrote on afterwrd 1 over, signed (afterwrd 2, step 10: src/before.js), from Home, with no
// prompt: this browser's key is already allowed to sign for them. First their posts: the site prepares exactly what each
// says; this signs it, saying when it was first written (`before`), and sends it back, a post at a time. Then the
// comments they made before, on their own posts and friends', an item at a time, each following the last (prev). Then
// Home is shown again, with them in place.
import { audienceOf, makeRecord } from "../records.js";
import { b64url } from "../signed.js";
import { savedKey } from "../browserkey.js";

const line = document.getElementById("bring-over");
/** @param {string} text */
const say = (text) => { if (line) line.textContent = text; };

/** @param {"GET" | "POST"} method @param {object} [body] */
async function call(method, body) {
  const res = await fetch("/_admin/before", body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method });
  const got = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(got.error ?? "That didn't work.");
  return got;
}

/**
 * One post, as the site prepared it: each photo signed first (an item of its own), then the post listing them, and for
 * an event, who it's for as a salted fingerprint (records.js audienceOf).
 * @param {{ privateKey: CryptoKey, publicKey: string, person: string }} key @param {any} p
 */
async function bringOne(key, p) {
  const own = { kind: "item", author: key.person, host: key.person, before: p.before };
  const photos = [];
  for (const content of p.photos) photos.push(await makeRecord(own, content, key));
  const post = p.post;
  if (post.photos) post.photos.forEach((/** @type {any} */ photo, /** @type {number} */ i) => { photo.item = photos[i].fp; });
  let audience = null;
  let salt = null;
  if (p.guests) {
    salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    audience = { kind: "invited", fp: await audienceOf(salt, p.guests.map((/** @type {any} */ g) => g.person)) };
  }
  const made = await makeRecord({ ...own, ...(p.mentions.length && { mentions: p.mentions }), ...(audience && { audience }) }, post, key);
  return call("POST", { old: p.old, sent: made.sent, photos: photos.map((m) => m.sent),
    ...(p.guests && { guests: p.guests.map((/** @type {any} */ g) => g.id), salt }) });
}

/**
 * One item's comments from before, as the site prepared them (in the order they were written): each signed in turn,
 * following the one before (the first follows `prev`), all having seen the item as it is now.
 * @param {{ privateKey: CryptoKey, publicKey: string, person: string }} key @param {any} c
 */
async function bringComments(key, c) {
  let prev = c.prev;
  const records = [];
  for (const one of c.list) {
    const made = await makeRecord({ kind: "comment", author: key.person, host: c.host, item: c.item, seen: c.seen, prev, before: one.before }, { text: one.text }, key);
    records.push({ id: one.id, sent: made.sent });
    prev = made.fp;
  }
  return call("POST", { to: c.to, item: c.item, records });
}

(async () => {
  const key = await savedKey();
  if (!key?.person || key.expires < Date.now() / 1000) {
    say("Your posts from before afterwrd 2 come over once this device can sign for you: sign out and sign in again.");
    return;
  }
  let brought = 0;
  try {
    for (;;) {
      const { next, comments, left, waiting } = await call("GET");
      if (!next && comments) {
        say("Bringing the comments you wrote before afterwrd 2 over, signed on this device…");
        await bringComments(/** @type {any} */ (key), comments);
        brought++;
        continue;
      }
      if (!next) {
        if (brought) location.reload();
        else if (waiting) say(waiting === 1 ? "An event from before afterwrd 2 comes over once everyone it's for has moved to afterwrd 2 too."
          : `${waiting} events from before afterwrd 2 come over once everyone they're for has moved to afterwrd 2 too.`);
        else if (line) line.hidden = true; // nothing for this browser now (a friend's site that hasn't moved yet is asked again later)
        return;
      }
      say(`Bringing your posts from before afterwrd 2 over, signed on this device: ${left} to go…`);
      await bringOne(/** @type {any} */ (key), next);
      brought++;
    }
  } catch (error) {
    say(`Couldn't bring something from before afterwrd 2 over (${/** @type {Error} */ (error).message}). It'll try again next time you're here.`);
  }
})();
