// The owner's own items (afterwrd 2, step 4a: docs/signed-conversations.md): posts written here, signed in the owner's
// browser, hosted in lists (hosted.js), and shown from `items`, which is worked out again from the list after every
// record (refreshItem).
//   POST /_admin/items                 {sent}: a new post, made and signed by the composer (compose.js)
//   POST /_admin/items/<id>/records    form: sent (JSON: a record signed in the browser, ui/sign.js), back: a comment,
//                                      an edit, a delete, on one of the owner's own items; then on to `back`
import { checkPhotos, removeUnusedFiles, roleAlbum } from "./posts.js";
import { hostingKey, ownIdentity, ownMove } from "./keys.js";
import { identityState } from "./identities.js";
import { checkDelegation } from "./identity.js";
import { checkRecord } from "./records.js";
import { listEntries, readList, takeRecord, tombstone } from "./hosted.js";
import { parseRecord, WITH_CONTENT } from "../public/static/records.js";
import { decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { MAX_POST_TEXT } from "./edits.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { messagePage } from "./views/pages.js";
import { html, json, now, Refusal } from "./util.js";
import { says } from "./mentions.js";
import { queueChangeNotes, queueCommentNote, queueItemNote } from "./notes.js";
import { CHANGE_SECONDS, dateTally, eventShown, eventTrouble, pollShown, pollTrouble, workOut } from "./itemkinds.js";
import { dateList } from "./lists.js";
import { ANSWERS, cleanEvent, eventChanged, finishedAt, hasDate, onDate, ruleDates } from "./calendar.js";
import { choicesMask } from "./polls.js";
import { markRemoved } from "./reports.js";
import { audienceOf, writtenAt } from "../public/static/records.js";

export const ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** Until when an item brought over from afterwrd 1 takes no new comments (before.js), if that's still to come; else null. */
export const frozenUntil = (until) => (Number.isSafeInteger(Number(until)) && Number(until) > now() ? Number(until) : null);
const EDIT_SECONDS = 15 * 60;

/** This site as host: the owner's person id and the hosting key; null before signing is set up. */
export async function ownHost(env) {
  const own = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  return own ? { person: String(own.person), privateKey: (await hostingKey(env)).privateKey } : null;
}

/** How records here find writers' identities and browser keys (records.js lookups). */
export function lookupsFor(env) {
  return {
    async identityOf(person) {
      const own = await ownIdentity(env.DB);
      if (own?.person === person) return own.state;
      return identityState(env, person);
    },
    async delegationOf(key) {
      // The owner's keys only while they may sign here (signing out ends one at once); their keys that have stopped are
      // kept in known_delegations only to pass on with what they signed before (keys.js rememberOwn).
      const mine = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ?").bind(key).first()
        ?? await env.DB.prepare(`SELECT bytes, proof FROM known_delegations WHERE key = ?
          AND person != COALESCE((SELECT person FROM own_identity WHERE id = 1), '')`).bind(key).first();
      return mine ? { bytes: String(mine.bytes), proof: JSON.parse(String(mine.proof)) } : null;
    },
  };
}

/**
 * A writer's delegation as their site sent it beside what they signed ({bytes, proof}): checked against their identity
 * as allowing `key`. Returns {key, person, bytes, proof, expires}, or null. Nothing is kept: a delegation only says the
 * person's passkey vouched for a key, not that they hold it, so it's kept (keepKnown) once something that key signed has
 * been taken, never before.
 */
export async function sentDelegationOf(env, person, delegation, key) {
  const state = await identityState(env, person);
  const bytes = typeof delegation?.bytes === "string" ? fromB64url(delegation.bytes) : null;
  if (!state || !bytes || !key || (await checkDelegation(bytes, delegation.proof, state, now())) !== key) return null;
  const { expires } = decode(bytes);
  return { key, person, bytes: delegation.bytes, proof: delegation.proof, expires };
}

/** `lookups` that find `sent` (sentDelegationOf) for its own key before anything kept here. */
export function withDelegation(lookups, sent) {
  return { ...lookups, delegationOf: async (key) => (sent && key === sent.key ? { bytes: sent.bytes, proof: sent.proof } : lookups.delegationOf(key)) };
}

/**
 * Keeps `sent` (sentDelegationOf) to pass on with what its key signed, once something it signed has been taken here:
 * that proves its person holds the key. Never over another person's delegation for the same key.
 * @param {D1Database} db
 */
export async function keepKnown(db, sent) {
  if (!sent) return;
  await db.prepare(`INSERT INTO known_delegations (key, person, bytes, proof, expires_at, learnt_at)
    VALUES (?, ?, ?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER))
    ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, proof = excluded.proof, expires_at = excluded.expires_at,
      learnt_at = excluded.learnt_at WHERE known_delegations.person = excluded.person`)
    .bind(sent.key, sent.person, sent.bytes, JSON.stringify(sent.proof), sent.expires).run();
}

/**
 * Keeps `sent` (sentDelegationOf) if every one of `records` ([{sent}], kept to go into a list later) is signed with its key
 * by its person, as taking them would check. Whether they all were.
 */
export async function keepIfSigned(env, sent, records) {
  if (!sent || !records.length) return false;
  const lookups = { ...withDelegation(lookupsFor(env), sent), at: now() };
  for (const r of records) {
    const got = await checkRecord(r?.sent, lookups);
    if (!got || got.record.author !== sent.person || got.record.key !== sent.key) return false;
  }
  await keepKnown(env.DB, sent);
  return true;
}

/** A record as stored in an entry ({sent}), read: {record, content} (content undefined once it's gone). */
export function readEntry(e) {
  if (!e.sent) return null;
  const record = parseRecord(fromB64url(e.sent.record));
  const content = e.sent.content ? decode(fromB64url(e.sent.content)) : undefined;
  return record && { record, content };
}

export const sentRecord = (sent) => {
  const bytes = typeof sent?.record === "string" ? fromB64url(sent.record) : null;
  return bytes && { bytes, record: parseRecord(bytes), content: sent.content ? decode(fromB64url(sent.content)) : undefined };
};
const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];

/**
 * A new post and its photos as the composer sends them (each photo an item of its own, signed first, then the post
 * listing them): a message saying what's wrong, or null. Checked in full before anything is taken.
 */
async function checkNewPost(env, host, post, photos) {
  const type = post?.content?.type;
  if (!post?.record || post.record.kind !== "item" || post.record.author !== host.person || (type !== "post" && type !== "event")) return "That isn't a post of yours.";
  const text = typeof post.content.text === "string" ? post.content.text : "";
  if (text !== text.replace(/\r\n?/g, "\n").trim()) return "That post's words aren't as written.";
  if (text.length > MAX_POST_TEXT) return `Posts can be up to ${MAX_POST_TEXT} characters.`;
  const listed = Array.isArray(post.content.photos) ? post.content.photos : [];
  // An event (itemkinds.js): its details, for its guests only; a post may ask a poll.
  if (type === "event") {
    if (listed.length || post.content.poll !== undefined) return "An event can't have photos or a poll.";
    if (!post.record.audience) return "An event is for those invited.";
    const wrong = eventTrouble(post.content.event, now());
    if (wrong) return wrong;
  } else {
    if (post.record.audience) return "That isn't a post of yours.";
    const wrong = pollTrouble(post.content.poll, now());
    if (wrong) return wrong;
    if (!text && !listed.length && !post.content.poll) return "Write something, or add photos.";
    if (post.content.poll && !text) return "Write the question your poll asks.";
  }
  if (!text && !listed.length && type === "post") return "Write something, or add photos.";
  if (listed.length !== photos.length) return "That post's photos aren't all here.";
  const wrong = await wrongMentions(env, post, text, null);
  if (wrong) return wrong;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p?.record || p.record.kind !== "item" || p.record.author !== host.person || p.content?.type !== "photo") return "That isn't a photo of yours.";
    if (listed[i]?.item !== (await fingerprintOf("record", p.bytes)) || PHOTO_FIELDS.some((f) => listed[i][f] !== p.content[f])) return "That post's photos aren't the ones sent.";
  }
  return checkPhotos(env, photos.map((p) => p.content));
}

export async function handleItems(request, env, url, owner) {
  const host = await ownHost(env);
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  // Moved away (keys.js): nothing new here; its passkeys no longer sign for the owner anyway.
  const gone = await ownMove(env.DB, url.origin);
  if (gone?.done) {
    const said = `You've moved to ${new URL(gone.to).host}: post there.`;
    return url.pathname === "/_admin/items" ? json({ error: said }, 410) : html(messagePage(said, { href: gone.to, label: "Go there" }), 410);
  }
  if (url.pathname === "/_admin/items") {
    const body = await request.json().catch(() => ({}));
    if (!host) return json({ error: "Set up signing first, in Your devices." }, 409);
    try {
      const made = await createItem(env, host, body.sent, Array.isArray(body.photos) ? body.photos : [], { guests: body.guests, salt: body.salt });
      await queueItemNote(env, url.origin, made.id);
      return json(made);
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  // Comments off, and on again (docs/safety-plan.md 3.1): on a post and its photos. It's this site's own choice as their
  // host (hosted.js refuses comments meanwhile), so nothing's signed. Turned off again, it keeps when it first was.
  const comments = /^\/_admin\/items\/([A-Za-z0-9_-]{43})\/comments$/.exec(url.pathname);
  if (comments) {
    const form = await request.formData().catch(() => new FormData());
    const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
    const id = comments[1];
    if (!(await env.DB.prepare("SELECT 1 FROM items WHERE id = ? AND type = 'post'").bind(id).first())) {
      return html(messagePage("That post isn't here any more.", { href: back.pathname + back.search, label: "Go back" }), 404);
    }
    const off = form.get("off") === "1";
    await env.DB.prepare(`UPDATE items SET comments_off_at = ${off ? "COALESCE(comments_off_at, ?2)" : "NULL"}
      WHERE id = ?1 OR id IN (SELECT photo FROM item_photos WHERE post = ?1)`).bind(id, ...(off ? [now()] : [])).run();
    back.hash = `i-${id}`;
    return Response.redirect(back.href, 303);
  }
  const on = /^\/_admin\/items\/([A-Za-z0-9_-]{43})\/(records|remove-photo)$/.exec(url.pathname);
  if (on) {
    const form = await request.formData().catch(() => new FormData());
    const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
    const parse = (name) => { try { return JSON.parse(String(form.get(name) ?? "")); } catch { return null; } };
    const sent = parse("sent");
    const refused = (message) => html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), 400);
    if (!host) return refused("Set up signing first, in Your devices.");
    if (!sent) return refused("This browser can't sign for you yet. Choose Let this browser sign, on Home or in Your devices.");
    if (on[2] === "remove-photo") {
      const answer = await removePhoto(env, host, on[1], sent, parse("change"));
      if (answer.refused) return refused(answer.refused);
      return Response.redirect(`${url.origin}/posts/${answer.post}`, 303);
    }
    const answer = await recordOn(env, host, on[1], sent, url.origin, { guests: parse("guests"), salt: form.get("salt") });
    if (answer.refused) return refused(answer.refused);
    if (answer.deleted) return Response.redirect(`${url.origin}/`, 303);
    back.hash = `i-${on[1]}`;
    return Response.redirect(back.href, 303);
  }
  return new Response("Not found", { status: 404 });
}

const NO_SIGNATURE = "This browser's signature didn't check. Sign out and in again.";

export const MAX_GUESTS = 100; // friends invited to one event
const MAX_HOSTING = 100; // events the owner has coming up

/**
 * An event's guests as the owner's browser chose them (`ids`: connection ids, and the `salt` it made the record's
 * audience fingerprint with), checked: approved friends with an identity, no more than MAX_GUESTS, and exactly the
 * people the fingerprint (`fp`) says. Returns [{connection, person}], or a message saying what's wrong.
 */
export async function guestsFor(env, ids, salt, fp) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (list.length > MAX_GUESTS) return `You can invite up to ${MAX_GUESTS} friends to an event.`;
  if (typeof salt !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(salt)) return "That invitation list didn't work. Try again.";
  const { results } = list.length ? await env.DB.prepare(`SELECT id, identity FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND identity IS NOT NULL AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(list)).all() : { results: [] };
  if (results.length !== list.length) return "Someone you picked can't be invited yet.";
  const guests = results.map((r) => ({ connection: Number(r.id), person: String(r.identity) }));
  if ((await audienceOf(salt, guests.map((g) => g.person))) !== fp) return "That invitation list isn't the one signed.";
  return guests;
}

/** A new post with its photos (each an item, taken first): rows for each, and each photo's file. Returns {id}. */
async function createItem(env, host, sent, photosSent, { guests: guestIds = null, salt = null } = {}) {
  const post = sentRecord(sent);
  const photos = photosSent.slice(0, 21).map(sentRecord);
  const wrong = await checkNewPost(env, host, post, photos);
  if (wrong) throw new Refusal(wrong, 400);
  let guests = [];
  if (post.content.type === "event") {
    const upcoming = (await env.DB.prepare("SELECT content FROM items WHERE audience = 'invited'").all()).results
      .filter((r) => finishedAt(JSON.parse(String(r.content)).event) > now()).length;
    if (upcoming >= MAX_HOSTING) throw new Refusal(`You can have up to ${MAX_HOSTING} events coming up.`, 400);
    const checked = await guestsFor(env, guestIds, salt, post.record.audience.fp);
    if (typeof checked === "string") throw new Refusal(checked, 400);
    guests = checked;
  }
  return takePost(env, host, { sent, post, photosSent, photos, guests });
}

/**
 * Takes a post's photos (each an item of its own, first) and then the post, checked already, and writes their rows:
 * for the composer (createItem), and for posts brought over from afterwrd 1 (before.js: `bringing`, whose records say
 * when they were first written, `before`). `media`: brought over, the photos' rows already here (media ids, in order),
 * pointed at their items rather than added again. `frozen`: until when it takes no new comments (hosted.js). Returns
 * {id, photos (their item ids)}.
 * @param {Env} env @param {{ person: string, privateKey: CryptoKey }} host
 * @param {{ sent: any, post: any, photosSent: any[], photos: any[], guests: { connection: number, person: string }[] }} what
 * @param {{ bringing?: boolean, media?: number[] | null, frozen?: number | null }} [options]
 */
export async function takePost(env, host, { sent, post, photosSent, photos, guests }, { bringing = false, media = null, frozen = null } = {}) {
  const lookups = lookupsFor(env);
  const taken = [];
  for (let i = 0; i < photos.length; i++) {
    const answer = await takeRecord(env.DB, { sent: photosSent[i], host, lookups, bringing });
    if (answer.refused) {
      for (const t of taken) await tombstone(env.DB, t.id);
      throw new Refusal(answer.refused === "That didn't check." ? NO_SIGNATURE : answer.refused, 400);
    }
    taken.push({ id: answer.entry.fp, at: answer.entry.taken, written: photos[i].record.before ?? answer.entry.taken, content: photos[i].content });
  }
  const answer = await takeRecord(env.DB, { sent, host, lookups, bringing });
  if (answer.refused) {
    for (const t of taken) await tombstone(env.DB, t.id);
    throw new Refusal(answer.refused === "That didn't check." ? NO_SIGNATURE : answer.refused, 400);
  }
  const id = answer.entry.fp;
  const written = post.record.before ?? answer.entry.taken;
  const db = env.DB;
  await db.batch([
    // The "Posted on afterwrd" album, if there are photos and it isn't there yet.
    ...(taken.length && !media ? [roleAlbum(db, "posts")] : []),
    db.prepare(`INSERT INTO items (id, author, type, content, created_at, changed_at, author_last, audience, version, tally, before_until)
      VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, host.person, JSON.stringify(post.content), written, answer.entry.taken, id,
        post.record.audience ? "invited" : "friends", id, post.content.poll ? JSON.stringify({ votes: {}, ended_at: null })
          : post.content.type === "event" ? JSON.stringify({ answers: {} }) : null, frozen),
    ...(post.record.audience ? [db.prepare("UPDATE lists SET invited = 1 WHERE id = ?").bind(id)] : []),
    ...guests.map((g) => db.prepare("INSERT INTO item_guests (item, connection_id, person, added_at) VALUES (?, ?, ?, ?)")
      .bind(id, g.connection, g.person, answer.entry.taken)),
    ...taken.flatMap((t, i) => [
      db.prepare(`INSERT INTO items (id, author, type, content, created_at, changed_at, author_last, before_until) VALUES (?, ?, 'photo', ?, ?, ?, ?, ?)`)
        .bind(t.id, host.person, JSON.stringify(t.content), t.written, t.at, t.id, frozen),
      db.prepare("INSERT INTO item_photos (photo, post, position) VALUES (?, ?, ?)").bind(t.id, id, i),
      media ? db.prepare("UPDATE media SET item_id = ?, post_id = NULL WHERE id = ?").bind(t.id, media[i])
        : db.prepare(`INSERT INTO media (source, path, kind, created_at, width, height, album_id, hash, thumb_hash, size, type, item_id)
        VALUES ('afterwrd', ?, 'photo', ?, ?, ?, (SELECT id FROM albums WHERE role = 'posts'), ?, ?, ?, 'image/jpeg', ?)`)
        .bind(`afterwrd/${t.content.hash}.jpg`, t.at, t.content.width, t.content.height, t.content.hash, t.content.thumb_hash, t.content.size, t.id),
    ]),
  ]);
  return { id, photos: taken.map((t) => t.id) };
}

/** The photo items of a post (in order), and the post a photo item is in. */
export const photosOf = async (db, post) => (await db.prepare("SELECT photo FROM item_photos WHERE post = ? ORDER BY position").bind(post).all()).results.map((r) => String(r.photo));
const postOf = async (db, photo) => (await db.prepare("SELECT post FROM item_photos WHERE photo = ?").bind(photo).first())?.post ?? null;

/** Everything of an item gone from here: its row, and a photo's file (if nothing else uses it) and its place in its post. */
export async function itemGone(env, id) {
  const db = env.DB;
  const files = (await db.prepare("SELECT hash, thumb_hash FROM media WHERE item_id = ?").bind(id).all()).results;
  await db.batch([
    // An event for those invited: only they hear it's gone (friendhost.js `gone`), so nobody else learns it existed.
    db.prepare("UPDATE lists SET invited = 1 WHERE id = ?1 AND EXISTS (SELECT 1 FROM items WHERE id = ?1 AND audience = 'invited')").bind(id),
    db.prepare("INSERT OR REPLACE INTO item_uninvited (item, connection_id, at) SELECT item, connection_id, ? FROM item_guests WHERE item = ?").bind(now(), id),
    db.prepare("DELETE FROM items WHERE id = ?").bind(id),
    db.prepare("DELETE FROM media WHERE item_id = ?").bind(id),
    db.prepare("DELETE FROM item_photos WHERE photo = ?").bind(id),
    db.prepare("DELETE FROM item_guests WHERE item = ?").bind(id),
    // The "Posted on afterwrd" album goes once nothing's in it.
    db.prepare("DELETE FROM albums WHERE role = 'posts' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.album_id = albums.id)"),
  ]);
  await removeUnusedFiles(env, files.flatMap((f) => [String(f.hash), String(f.thumb_hash)]));
}

/**
 * What's wrong with who a record mentions (`got`: {record, content}), or null. Its content's `mentions` ({name, person})
 * must be in the record's and said in `text`. Who may be mentioned: on the owner's own new post (`item` null) or by
 * the owner on one of their items, their friends and anyone already in its thread; by someone else, the item's owner
 * and anyone already in its thread (as before: all the site tells).
 */
async function wrongMentions(env, got, text, item) {
  const listed = got.record.mentions ?? [];
  const shown = Array.isArray(got.content?.mentions) ? got.content.mentions : [];
  if (!listed.length && !shown.length) return null;
  if (shown.length > listed.length || shown.some((m) => !listed.includes(m?.person) || typeof m.name !== "string" || !says(text, m.name))) {
    return "That mentions someone its words don't.";
  }
  const own = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
  const allowed = new Set();
  if (item) {
    for (const e of await listEntries(env.DB, item)) {
      const r = readEntry(e)?.record;
      if (r) allowed.add(r.author);
    }
  }
  if (got.record.author === own?.person) {
    const { results } = await env.DB.prepare("SELECT identity FROM connections WHERE approved_at IS NOT NULL AND identity IS NOT NULL").all();
    for (const r of results) allowed.add(String(r.identity));
  }
  allowed.delete(got.record.author);
  return listed.every((p) => allowed.has(p)) ? null : "You can only mention people who can see this.";
}

/** Who a record mentions as pages show them: its content's {name, person}, for those its signed list names. */
export const shownMentions = (record, content) => (Array.isArray(content?.mentions) ? content.mentions : [])
  .filter((m) => typeof m?.name === "string" && (record?.mentions ?? []).includes(m.person)).slice(0, 10)
  .map((m) => ({ name: m.name.slice(0, 100), person: m.person }));

const MAX_DATES_OFF = 10; // dates of one repeating event called off a day, each telling those going that day

/** When one date of a repeating event (YYYY-MM-DD) is over. */
export const dateOver = (e, date) => finishedAt({ ...onDate(e, date), rrule: null });

/**
 * What a vote, an answer, a poll's end, an event's change or (in a group) its calling off on `item` (its row, and
 * `content` as it is now) would do, checked before it's taken: {refused}, or what it means ({guests} for a change that
 * says who's invited now, {moved}, {cancelled}). Anything else: {}. `isGuest(person)`: whether they may answer (in a
 * group, any member); otherwise the event's guests here.
 */
export async function kindPlan(env, item, content, { record, content: c }, { guestIds, salt, isGuest = null }) {
  const tally = item.tally ? JSON.parse(String(item.tally)) : null;
  const at = now();
  if (record.kind === "vote" || record.kind === "end") {
    const poll = content.poll;
    if (!poll) return { refused: "That post doesn't have a poll." };
    if (tally?.ended_at || (poll.closes_at && poll.closes_at <= at)) return { refused: "That poll has closed." };
    if (record.kind === "end") return {};
    if (record.version !== item.version) return { refused: "That poll has changed. Try again." };
    const mask = choicesMask(Array.isArray(c?.choices) ? c.choices : null, { options: JSON.stringify(poll.options), multiple: poll.multiple });
    return mask === null ? { refused: poll.multiple ? "Those aren't options in this poll." : "Pick one of the options." } : {};
  }
  if (content.type !== "event") return record.kind === "answer" ? { refused: "That isn't an event." } : {};
  const e = content.event;
  // One date of a repeating event (a group's, step 6d): answers are always to one date, and a calloff may be.
  const date = record.date ?? null;
  if (record.kind === "answer" || (record.kind === "calloff" && date)) {
    if (date && !e.rrule) return { refused: "That event doesn't repeat." };
    if (!date && e.rrule) return { refused: "This event repeats: say which date. (Your site may need updating.)" };
    if (date && !hasDate(e, date)) return { refused: "That isn't one of its dates." };
  }
  const day = date ? tally?.dates?.[date] ?? null : null;
  if (record.kind === "answer") {
    if (!ANSWERS.includes(c?.answer)) return { refused: "Answer going, maybe or no." };
    const guest = isGuest ? await isGuest(record.author)
      : await env.DB.prepare("SELECT 1 FROM item_guests WHERE item = ? AND person = ?").bind(item.id, record.author).first();
    if (!guest) return { refused: "That event isn't there any more." };
    if (e.cancelled) return { refused: "That event's been called off." };
    if (day?.off) return { refused: "That date's been called off." };
    if ((date ? dateOver(e, date) : finishedAt(e)) <= at) return { refused: "That event is over." };
    if (record.version !== item.version) return { refused: "That event has just changed. Have a look, then answer again." };
    return {};
  }
  if (record.kind === "calloff") {
    if (e.cancelled) return { refused: "That event's been called off." };
    if (date) {
      if (day?.off) return { refused: "That date's already been called off." };
      if (dateOver(e, date) <= at) return { refused: "That date is over." };
      // Each tells everyone going that day: a few a day at most.
      const today = Object.values(tally?.dates ?? {}).filter((d) => d?.off && d.off.at > at - 86400).length;
      if (today >= MAX_DATES_OFF) return { refused: `You can call off up to ${MAX_DATES_OFF} dates of an event a day. Try again tomorrow.` };
      return { date };
    }
    if (finishedAt(e) <= at) return { refused: "That event is over." };
    return { cancelled: true };
  }
  if (record.kind !== "change") return {};
  const event = cleanEvent(c?.event, { repeats: Boolean(e.rrule) });
  if (!event) return { refused: "That event isn't as written." };
  if (Boolean(event.rrule) !== Boolean(e.rrule)) {
    return { refused: e.rrule ? "An event can't stop repeating: call it off, and add it again if you like." : "An event can't start repeating: add one that repeats instead." };
  }
  if (typeof c.text === "string" && c.text.length > MAX_POST_TEXT) return { refused: `The words about it can be up to ${MAX_POST_TEXT} characters.` };
  if (e.cancelled) return { refused: "That event's been called off." };
  if (finishedAt(e) <= at) return { refused: "That event is over." };
  // A repeating one can't be moved to start on a day that's already over (its time of day can change, under way or not).
  if (event.rrule && ruleDates(event)[0] !== ruleDates(e)[0] && dateOver(event, ruleDates(event)[0]) < at) return { refused: "Its first date would already be over." };
  const moved = eventChanged(e, event);
  const cancelled = Boolean(event.cancelled);
  if (moved && finishedAt(event) <= at) return { refused: "That would be over already: pick a time still to come." };
  if (moved && tally?.moved_at && tally.moved_at > at - CHANGE_SECONDS) return { refused: "You've just changed this event. Try again in a few minutes." };
  let guests = null;
  if (record.audience) {
    const checked = await guestsFor(env, guestIds, salt, record.audience.fp);
    if (typeof checked === "string") return { refused: checked };
    guests = checked;
  }
  return { moved, cancelled, guests };
}

/**
 * A record on one of the owner's own items, taken, and the item worked out again. {refused} if not; {deleted} if it
 * was its writer deleting it. With `origin` (this site), a comment is noted to those who'll want to know (notes.js).
 */
export async function recordOn(env, host, id, sent, origin = null, { guests: guestIds = null, salt = null, delegation = null } = {}) {
  const item = await env.DB.prepare("SELECT id, type, content, version, tally, audience FROM items WHERE id = ?").bind(id).first();
  if (!item) return { refused: "That post isn't here any more." };
  const got = sentRecord(sent);
  if (!got?.record || got.record.item !== id) return { refused: "That didn't work. Try again." };
  const { record, content } = got;
  if (WITH_CONTENT.has(record.kind) !== (content !== undefined)) return { refused: "That didn't work. Try again." };
  const now_ = JSON.parse(String(item.content));
  if (content !== undefined) {
    const text = typeof content?.text === "string" ? content.text : "";
    if (record.kind === "comment" && (!text.trim() || text.length > MAX_COMMENT)) return { refused: `Comments need 1 to ${MAX_COMMENT} characters.` };
    if (record.kind === "edit" && text.length > (record.about === id ? MAX_POST_TEXT : MAX_COMMENT)) return { refused: "That's too long." };
    // A post with no photos needs its words (a poll, its question); an event needn't have any.
    if (record.kind === "edit" && record.about === id && !text.trim() && now_.type !== "event" && (now_.poll || !now_.photos?.length)) {
      return { refused: now_.poll ? "A poll needs its question." : "A post with no photos needs words." };
    }
    const wrong = await wrongMentions(env, got, text, id);
    if (wrong) return { refused: wrong };
  }
  // An event's words change with the event (its form: a change), at any time, not by the 15-minute edit.
  if (record.kind === "edit" && record.about === id && now_.type === "event") return { refused: "An event's words change with the event: use Change it." };
  // Votes, answers, a poll's end and an event's changes (itemkinds.js).
  const plan = await kindPlan(env, item, now_, got, { guestIds, salt });
  if (plan.refused) return plan;
  const answer = await takeRecord(env.DB, { sent, host, lookups: withDelegation(lookupsFor(env), delegation) });
  if (answer.refused) {
    const said = { "Someone has replied since.": "Someone has replied since, so it can't be changed now.", "That's out of order.": "Something changed meanwhile. Try again." };
    return { refused: said[answer.refused] ?? answer.refused };
  }
  // Taken, so its key is the writer's: kept, to pass on with it.
  await keepKnown(env.DB, delegation);
  // Removed: anything reported about it is dealt with (reports.js).
  if (record.kind === "remove") await markRemoved(env.DB, record.about, record.author);
  if (answer.deleted) {
    // An event still to come: its guests are told it's off, and their copies go (notes.js).
    if (now_.type === "event" && origin) {
      const { results } = await env.DB.prepare("SELECT connection_id FROM item_guests WHERE item = ?").bind(id).all();
      const off = !now_.event.cancelled && finishedAt(now_.event) > now();
      await queueChangeNotes(env, origin, id, null, { removed: results.map((r) => Number(r.connection_id)), cancelled: off });
    }
    // A post's photos go with it: its delete covers them, so their lists are closed as its is.
    for (const photo of await photosOf(env.DB, id)) {
      await tombstone(env.DB, photo);
      await itemGone(env, photo);
    }
    await itemGone(env, id);
    return { deleted: true };
  }
  // Those invited, as the change says now: added and taken back, with who's left told what's changed.
  if (plan.guests) {
    const at = answer.entry.taken;
    const before = new Map((await env.DB.prepare("SELECT connection_id, person FROM item_guests WHERE item = ?").bind(id).all()).results
      .map((r) => [Number(r.connection_id), String(r.person)]));
    const after = new Map(plan.guests.map((g) => [g.connection, g.person]));
    plan.added = [...after.keys()].filter((c) => !before.has(c));
    plan.removed = [...before.keys()].filter((c) => !after.has(c));
    await env.DB.batch([
      ...plan.added.flatMap((c) => [
        env.DB.prepare("INSERT INTO item_guests (item, connection_id, person, added_at) VALUES (?, ?, ?, ?)").bind(id, c, after.get(c), at),
        env.DB.prepare("DELETE FROM item_uninvited WHERE item = ? AND connection_id = ?").bind(id, c)]),
      ...plan.removed.flatMap((c) => [
        env.DB.prepare("DELETE FROM item_guests WHERE item = ? AND connection_id = ?").bind(id, c),
        env.DB.prepare("INSERT OR REPLACE INTO item_uninvited (item, connection_id, at) VALUES (?, ?, ?)").bind(id, c, at)]),
    ]);
  }
  await refreshItem(env.DB, id);
  if (origin && record.kind === "comment") await queueCommentNote(env, origin, id, record, answer.entry.fp);
  if (origin && record.kind === "change" && now_.type === "event") {
    await queueChangeNotes(env, origin, id, answer.entry.fp, { added: plan.added ?? [], removed: plan.removed ?? [] });
  }
  return { ok: true, receipt: answer.receipt, entry: answer.entry, record, content };
}

/**
 * One photo deleted from a post: a delete on the photo's own list (its comments go with it), then the owner's change
 * to the post, listing the photos left. Both signed in the browser (ui/sign.js). Returns {post} or {refused}.
 */
async function removePhoto(env, host, photo, sent, changeSent) {
  const post = await postOf(env.DB, photo);
  const change = sentRecord(changeSent);
  if (!post || !change?.record || change.record.kind !== "change" || change.record.item !== post) return { refused: "That photo isn't in a post here." };
  const left = (await photosOf(env.DB, post)).filter((p) => p !== photo);
  const listed = Array.isArray(change.content?.photos) ? change.content.photos.map((p) => p?.item) : null;
  if (!listed || JSON.stringify(listed) !== JSON.stringify(left)) return { refused: "Something changed meanwhile. Try again." };
  const { text } = JSON.parse(String((await env.DB.prepare("SELECT content FROM items WHERE id = ?").bind(post).first()).content));
  if (!left.length && !String(text ?? "").trim()) return { refused: "That's the post's only photo, and it has no words: delete the post instead." };
  const deleted = await recordOn(env, host, photo, sent);
  if (deleted.refused) return deleted;
  const changed = await takeRecord(env.DB, { sent: changeSent, host, lookups: lookupsFor(env) });
  if (changed.refused) return { refused: changed.refused };
  await env.DB.batch(left.map((p, i) => env.DB.prepare("UPDATE item_photos SET position = ? WHERE photo = ?").bind(i, p)));
  await refreshItem(env.DB, post);
  return { post };
}

/** Works an item's row out again from its list: its words now, what they were, its comments, and who else has written. */
export async function refreshItem(db, id) {
  const row = await db.prepare("SELECT author, content, audience, tally FROM items WHERE id = ?").bind(id).first();
  if (!row) return;
  const entries = await listEntries(db, id);
  // A poll's votes, an event's details as last changed and its guests' answers (itemkinds.js).
  const guests = row.audience === "invited"
    ? (await db.prepare("SELECT person FROM item_guests WHERE item = ?").bind(id).all()).results.map((r) => String(r.person)) : null;
  const w = itemFromList(id, row, entries, guests);
  // A repeating event's dates are worked out from their own lists (refreshDate): kept as they are.
  const dates = row.tally ? JSON.parse(String(row.tally)).dates : null;
  const tally = dates && w.tally ? JSON.stringify({ ...JSON.parse(w.tally), dates }) : w.tally;
  await db.prepare(`UPDATE items SET content = ?, earlier = ?, edited_at = ?, comments = ?, others = ?, author_last = ?, changed_at = ?,
    version = ?, tally = ? WHERE id = ?`)
    .bind(w.content, w.earlier, w.edited_at, w.comments, w.others, w.author_last, now(), w.version, tally, id).run();
}

/**
 * Works one date of a repeating event out again from its own list (lists.js dateList, step 6d), into the event's
 * `tally.dates`: that date's answers, whether it's called off and by whom, and where its list is up to (for members to
 * sign an answer to it). The event counts as changed, so members' sites ask for it again.
 */
export async function refreshDate(db, id, date) {
  const list = dateList(id, date);
  const [row, head] = await Promise.all([db.prepare("SELECT tally FROM items WHERE id = ?").bind(id).first(),
    db.prepare("SELECT n, head FROM lists WHERE id = ?").bind(list).first()]);
  if (!row || !head) return;
  const day = dateTally((await listEntries(db, list)).map((e) => ({ e, r: readEntry(e) })));
  const tally = JSON.parse(String(row.tally ?? "null")) ?? { answers: {} };
  tally.dates = { ...tally.dates, [date]: { ...day, list: { n: Number(head.n), head: String(head.head) } } };
  await db.prepare("UPDATE items SET tally = ?, changed_at = ? WHERE id = ?").bind(JSON.stringify(tally), now(), id).run();
}

/**
 * An item's row as its list says it should be (refreshItem; and a site taking a move, which works every row out again
 * rather than trust the download): {content, earlier, edited_at, comments, others, author_last, version, tally}, as
 * stored. `row`: its author, its content as stored (used only if its first record is gone), and its audience.
 */
export function itemFromList(id, row, entries, guests) {
  const author = String(row.author);
  const read = entries.map((e) => ({ e, r: readEntry(e) }));
  const worked = workOut(read, { id, author, guests });
  const tally = worked.tally && { ...worked.tally, ...(worked.movedAt ? { moved_at: worked.movedAt } : {}) };
  let content = read[0]?.r ? { ...worked.content, text: read[0].r.content?.text ?? "" } : JSON.parse(String(row.content));
  const earlier = [];
  let editedAt = null;
  let comments = 0;
  let others = 0;
  let authorLast = id;
  for (const { e, r } of read.slice(1)) {
    // A record gone (deleted or removed) isn't anyone's any more, as lists.js's edit rule has it: it doesn't hold the
    // post's words in place.
    if (!r) continue;
    if (r.record.author !== author) others++;
    else if (!e.by_host) authorLast = e.fp;
    if (r.record.kind === "edit" && r.record.about === id && r.record.author === author) {
      earlier.push({ text: content.text, replaced_at: e.taken });
      content = { ...content, text: r.content?.text ?? content.text };
      editedAt = e.taken;
    }
    // An event's words change with its details (the owner's change), at any time.
    if (r.record.kind === "change" && r.record.author === author && typeof r.content?.text === "string" && content.type === "event"
      && r.content.text !== content.text) {
      earlier.push({ text: content.text, replaced_at: e.taken });
      content = { ...content, text: r.content.text };
      editedAt = e.taken;
    }
    // The owner's change to what isn't words: which photos a post has (one deleted from it).
    if (r.record.kind === "change" && r.record.author === author && Array.isArray(r.content?.photos)) content = { ...content, photos: r.content.photos };
  }
  comments = thread(read.map(({ e, r }) => ({ ...e, r })), { owner: author, item: id }).filter((c) => c.state === "ok").length;
  if (content.type === "event") content = { ...content, event: worked.content.event };
  return { content: JSON.stringify(content), earlier: earlier.length ? JSON.stringify(earlier) : null, edited_at: editedAt, comments,
    others, author_last: authorLast, version: worked.version ?? null, tally: tally ? JSON.stringify(tally) : null };
}

/**
 * An item's comments as pages show them, from its list's entries (each with `r`, its record read): in order, each
 * with its words now (and what they were), or a marker: "deleted" (by whoever wrote it), "removed" (by the post's
 * owner or this site). Edits and deletes aren't comments: they change one.
 */
export function thread(entries, { owner, item }) {
  const comments = [];
  const byFp = new Map();
  for (const e of entries) {
    const r = e.r;
    // One whose signature doesn't check (a friend's site showed something its writer didn't sign): hidden, saying so.
    if (e.failed) { comments.push({ fp: e.fp, n: e.n, state: "failed", taken: e.taken }); continue; }
    if (!r) {
      // Gone: a comment whose words were thrown away. What became of it is said by a delete or removal after it.
      const c = { fp: e.fp, n: e.n, state: "gone", taken: e.taken };
      byFp.set(e.fp, c);
      if (e.n > 1) comments.push(c);
      continue;
    }
    const { record, content } = r;
    if (record.kind === "comment") {
      // Its time: when first written, for one brought over from afterwrd 1 (records.js `before`), else when taken.
      const c = { fp: e.fp, n: e.n, author: record.author, text: content?.text ?? "", taken: writtenAt(record, e.taken), state: "ok", earlier: [], edited_at: null, mentions: shownMentions(record, content) };
      byFp.set(e.fp, c);
      comments.push(c);
    } else if (record.kind === "edit" && record.about !== item) {
      const c = byFp.get(record.about);
      if (c && c.state === "ok" && c.author === record.author) {
        c.earlier.push({ text: c.text, replaced_at: e.taken });
        c.text = content?.text ?? c.text;
        c.edited_at = e.taken;
      }
    } else if (record.kind === "delete" || record.kind === "remove") {
      const c = byFp.get(record.about);
      if (c) { c.state = record.kind === "delete" ? "deleted" : "removed"; c.removedBy = record.author; c.text = ""; c.earlier = []; }
    }
  }
  // A comment that's gone with nothing signed saying why: left out. (Never happens here; a host's own pages say so anyway.)
  for (const c of comments) if (c.state === "gone") c.state = "left-out";
  // Whether each can still be changed: by its writer, within 15 minutes, and while nobody else has written after it
  // (what's been deleted since isn't anyone's: lists.js's edit rule, which the site holds it to).
  for (const c of comments) {
    if (c.state !== "ok") continue;
    const later = entries.some((e) => e.n > c.n && e.r && e.r.record.author !== c.author);
    c.editable = now() - c.taken < EDIT_SECONDS && !later;
  }
  void owner;
  return comments;
}

/** An item's list, read for its page: entries with records read, its owner, and where it's up to (for forms). */
export async function loadThread(env, id) {
  const host = await ownHost(env);
  const list = host && (await readList(env.DB, id, { host }));
  if (!list || list.deleted) return null;
  const entries = list.entries.map((e) => ({ ...e, r: readEntry(e) }));
  const last = entries.at(-1);
  return { entries, owner: list.owner, seen: { n: last.n, h: last.head } };
}

/** The owner's newest items for Home (newest first), with their photos as pages draw them. */
export async function ownItems(db, { limit = 30, before = null } = {}) {
  const { results } = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
    WHERE i.type = 'post' ${before ? "AND i.created_at < ?" : ""} ORDER BY i.created_at DESC LIMIT ?`)
    .bind(...(before ? [before, limit] : [limit])).all();
  return Promise.all(results.map((r) => itemFromRow(db, r)));
}

/** One of the owner's items by id, as pages draw it; null if it isn't here. */
export async function ownItem(db, id) {
  const row = await db.prepare("SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id WHERE i.id = ?").bind(id).first();
  return row ? itemFromRow(db, row) : null;
}

async function itemFromRow(db, r) {
  const content = JSON.parse(String(r.content));
  const tally = r.tally ? JSON.parse(String(r.tally)) : null;
  const author = String(r.author);
  // A poll's voters and an event's guests, named as the owner knows them (polls are public; everyone invited sees who's
  // coming); for an event, who's invited, and what became of each invitation.
  let poll = null;
  let event = null;
  if (content.poll) {
    const names = await namesFor(db, Object.keys(tally?.votes ?? {}));
    poll = pollShown(content.poll, tally, { viewer: author, names, me: author });
  } else if (content.type === "event") {
    const { results: guests } = await db.prepare(`SELECT g.connection_id AS id, g.person, g.delivery, c.name, c.origin FROM item_guests g
      JOIN connections c ON c.id = g.connection_id WHERE g.item = ? ORDER BY c.name COLLATE NOCASE`).bind(String(r.id)).all();
    const names = new Map(guests.map((g) => [String(g.person), String(g.name)]));
    event = { ...eventShown(content, tally, { names, me: author, version: r.version ? String(r.version) : null, invited: guests.length }),
      guests: guests.map((g) => ({ id: Number(g.id), name: String(g.name), from: String(g.origin), delivery: g.delivery ?? null,
        answer: tally?.answers?.[String(g.person)]?.answer ?? null })) };
    event.waiting = event.guests.filter((g) => !g.answer);
  }
  // A post's photos, each an item of its own, in the post's order: their files as pages draw them (media rows).
  const { results: media } = r.type === "post"
    ? await db.prepare(`SELECT m.id, m.hash, m.thumb_hash, m.width, m.height, m.kind, m.item_id FROM item_photos ip JOIN media m ON m.item_id = ip.photo
      WHERE ip.post = ? ORDER BY ip.position`).bind(String(r.id)).all()
    : { results: [] };
  return {
    poll, event, version: r.version ? String(r.version) : String(r.id),
    id: String(r.id), author, type: String(r.type), text: content.text ?? "",
    media, photos: content.photos ?? [], mentions: Array.isArray(content.mentions) ? content.mentions : [],
    created_at: Number(r.created_at), edited_at: r.edited_at ? Number(r.edited_at) : null,
    earlier: r.earlier ? JSON.parse(String(r.earlier)) : [], comments: Number(r.comments), others: Number(r.others),
    editable: now() - Number(r.created_at) < EDIT_SECONDS && Number(r.others) === 0,
    // For the signed forms on it (views/items.js): where its list is up to, and its writer's newest record on it.
    list: { host: String(r.author), me: String(r.author), seen: { n: Number(r.list_n), h: String(r.list_head) }, mine: String(r.author_last),
      frozenUntil: frozenUntil(r.before_until), commentsOff: r.comments_off_at !== null && r.comments_off_at !== undefined },
  };
}

/**
 * The owner's items for the Posts page (newest first): those from `from` to `to` (seconds; either may be null for no
 * limit), whose words match `q`, in `year` (UTC, as the archive's), at most `limit`, after skipping `offset`.
 */
export async function ownItemsWhere(db, { from = null, to = null, q = "", year = "", limit = 100, offset = 0 } = {}) {
  const where = ["i.type = 'post'"];
  const params = [];
  if (from !== null) { where.push("i.created_at >= ?"); params.push(from); }
  if (to !== null) { where.push("i.created_at < ?"); params.push(to); }
  if (q) { where.push("json_extract(i.content, '$.text') LIKE ?"); params.push(`%${q}%`); }
  if (year) { where.push("strftime('%Y', i.created_at, 'unixepoch') = ?"); params.push(year); }
  const { results } = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();
  return Promise.all(results.map((r) => itemFromRow(db, r)));
}

/** How many of the owner's items there are. */
export async function ownItemCount(db) {
  return Number((await db.prepare("SELECT COUNT(*) AS n FROM items WHERE type = 'post'").first())?.n ?? 0);
}

/**
 * A photo item for its page (archive photo page): the photo's own item (for its comments, signed), the post it's in,
 * and where it sits among that post's photos. null if `mediaId`'s photo isn't a photo item.
 */
export async function photoItem(env, mediaId) {
  const db = env.DB;
  const row = await db.prepare(`SELECT m.item_id AS photo, ip.post, ip.position, (SELECT COUNT(*) FROM item_photos WHERE post = ip.post) AS total
    FROM media m JOIN item_photos ip ON ip.photo = m.item_id WHERE m.id = ?`).bind(mediaId).first();
  if (!row) return null;
  const [photo, post, list] = await Promise.all([ownItem(db, String(row.photo)), ownItem(db, String(row.post)), loadThread(env, String(row.photo))]);
  if (!photo || !post || !list) return null;
  const neighbour = (position) => db.prepare(`SELECT m.* FROM item_photos ip JOIN media m ON m.item_id = ip.photo WHERE ip.post = ? AND ip.position = ?`)
    .bind(String(row.post), position).first();
  const [prev, next] = await Promise.all([neighbour(Number(row.position) - 1), neighbour(Number(row.position) + 1)]);
  const comments = thread(list.entries, { owner: photo.author, item: photo.id });
  const names = await namesFor(db, comments.flatMap((c) => [c.author, c.removedBy]));
  for (const c of comments) { if (c.author) c.name = names.get(c.author) ?? "Someone"; if (c.removedBy) c.removedByName = names.get(c.removedBy) ?? null; }
  return {
    photo, post, prev, next, index: Number(row.position) + 1, total: Number(row.total),
    thread: comments, list: { ...photo.list, seen: list.seen },
  };
}

/**
 * Names for the people who wrote on the owner's items: a friend's as the owner knows them (connections), anyone else's
 * as their signed profile says (identities, checked when it was kept). Missing ones are left out.
 */
export async function namesFor(db, people) {
  const list = [...new Set(people.filter(Boolean))];
  if (!list.length) return new Map();
  const json = JSON.stringify(list);
  const [friends, others] = await db.batch([
    db.prepare("SELECT identity AS person, name FROM connections WHERE identity IN (SELECT value FROM json_each(?))").bind(json),
    db.prepare("SELECT person, profile FROM identities WHERE person IN (SELECT value FROM json_each(?)) AND profile IS NOT NULL").bind(json),
  ]);
  const names = new Map();
  for (const r of others.results) {
    try { const p = JSON.parse(String(r.profile)); const said = JSON.parse(new TextDecoder().decode(fromB64url(p.bytes))); if (typeof said.name === "string") names.set(String(r.person), said.name.slice(0, 100)); } catch {}
  }
  for (const r of friends.results) names.set(String(r.person), String(r.name));
  return names;
}
