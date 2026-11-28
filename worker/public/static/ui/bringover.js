// Bringing what the owner wrote on afterwrd 1 over, signed (afterwrd 2, step 10: src/before.js), from Home, with no
// prompt: this browser's key is already allowed to sign for them. First their posts: the site prepares exactly what each
// says; this signs it, saying when it was first written (`before`), and sends it back, a post at a time. Then the
// comments they made before, on their own posts and friends', an item at a time, each following the last (prev). Then
// groups from before (step 10d): a `join` for one that has come over, and, for one the owner brought over, an
// `approve` for each of its old members waiting to be let in, as the owner's own approve button signs one
// (ui/groupsign.js). Then what the owner wrote in groups from before (step 10e): each post, then each post's comments.
// Then Home is shown again, with them in place.
import { audienceOf, makeRecord } from "../records.js";
import { b64url } from "../signed.js";
import { savedKey } from "../browserkey.js";

const line = document.getElementById("bring-over");
// The notice starts hidden (views/home.js), and shows only once there's something to say: most visits only ask
// friends' and groups' sites again, find nothing for this browser, and would otherwise flash it up and away.
/** @param {string} text */
const say = (text) => {
  if (!line) return;
  line.textContent = text;
  /** @type {HTMLElement} */ (line.closest(".notice") ?? line).hidden = false;
};

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

/** @param {string} path @param {object} body */
async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const got = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(got.error ?? "That didn't work.");
  return got;
}

/** A `join` for a group from before that has come over, as the site prepared it. @param {any} key @param {any} r */
async function rejoinGroup(key, r) {
  const made = await makeRecord({ kind: "join", author: key.person, host: r.host, item: r.item, seen: r.seen, prev: r.prev }, { name: r.name }, key);
  return call("POST", { rejoin: r.group, sent: made.sent });
}

/** Lets in old members of a group the owner brought over: an `approve` each, from where the list is up to then. @param {any} key @param {any} a */
async function approveOld(key, a) {
  for (const join of a.joins) {
    const at = await postJson(`/_groups/${a.group}/point`, {});
    const made = await makeRecord({ kind: "approve", author: key.person, host: at.host, item: at.item, seen: at.seen ?? null, prev: at.prev ?? null,
      about: join, ...(at.role_at && { role_at: at.role_at }) }, undefined, key);
    await postJson(`/_groups/${a.group}/records`, { sent: made.sent });
  }
}

/**
 * One of the owner's posts in a group from before (step 10e), as their site checked the group's offer against its own
 * copy: each photo signed first (an item of its own), then the post listing them, then each date of a repeating event
 * called off before (a `calloff` starting that date's list).
 * @param {{ privateKey: CryptoKey, publicKey: string, person: string }} key @param {any} g
 */
async function bringGroupPost(key, g) {
  const own = { kind: "item", author: key.person, host: g.host, before: g.before };
  const photos = [];
  for (const content of g.photos) photos.push(await makeRecord(own, content, key));
  const post = g.post;
  if (post.photos) post.photos.forEach((/** @type {any} */ photo, /** @type {number} */ i) => { photo.item = photos[i].fp; });
  const made = await makeRecord({ ...own, old: g.old }, post, key);
  const calloffs = [];
  for (const date of g.calloffs) {
    calloffs.push((await makeRecord({ kind: "calloff", author: key.person, host: g.host, item: made.fp, about: made.fp, date, seen: null, prev: null }, undefined, key)).sent);
  }
  return call("POST", { groupPost: g.id, sent: made.sent, photos: photos.map((m) => m.sent), calloffs });
}

/** One group post's comments from before, written by the owner (as bringComments). @param {any} key @param {any} c */
async function bringGroupComments(key, c) {
  let prev = c.prev;
  const records = [];
  for (const one of c.list) {
    const made = await makeRecord({ kind: "comment", author: key.person, host: c.host, item: c.item, seen: c.seen, prev, before: one.before }, { text: one.text }, key);
    records.push({ id: one.id, sent: made.sent });
    prev = made.fp;
  }
  return call("POST", { groupItem: c.item, records });
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
      const { next, comments, rejoin, approve, groupPost, groupComments, left, waiting } = await call("GET");
      if (!next && comments) {
        say("Bringing the comments you wrote before afterwrd 2 over, signed on this device…");
        await bringComments(/** @type {any} */ (key), comments);
        brought++;
        continue;
      }
      if (!next && rejoin) {
        say("Joining your groups from before afterwrd 2 again, signed on this device…");
        await rejoinGroup(key, rejoin);
        brought++;
        continue;
      }
      if (!next && approve) {
        say("Letting the people who were in your group before afterwrd 2 back in…");
        await approveOld(key, approve);
        brought++;
        continue;
      }
      if (!next && groupPost) {
        say("Bringing what you wrote in your groups before afterwrd 2 over, signed on this device…");
        await bringGroupPost(/** @type {any} */ (key), groupPost);
        brought++;
        continue;
      }
      if (!next && groupComments) {
        say("Bringing what you wrote in your groups before afterwrd 2 over, signed on this device…");
        await bringGroupComments(/** @type {any} */ (key), groupComments);
        brought++;
        continue;
      }
      if (!next) {
        if (brought) location.reload();
        else if (waiting) say(waiting === 1 ? "An event from before afterwrd 2 comes over once everyone it's for has moved to afterwrd 2 too."
          : `${waiting} events from before afterwrd 2 come over once everyone they're for has moved to afterwrd 2 too.`);
        // Nothing for this browser now (a friend's site that hasn't moved yet is asked again later): the whole notice
        // goes, not just its words, or an empty box is left.
        else if (line) /** @type {HTMLElement} */ (line.closest(".notice") ?? line).hidden = true;
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
