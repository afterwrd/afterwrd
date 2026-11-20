// The owner's own items (afterwrd 2, step 4a: docs/signed-conversations.md): posts written here, signed in the owner's
// browser, hosted in lists (hosted.js), and shown from `items`, which is worked out again from the list after every
// record (refreshItem).
//   POST /_admin/items                 {sent}: a new post, made and signed by the composer (compose.js)
//   POST /_admin/items/<id>/records    form: sent (JSON: a record signed in the browser, ui/sign.js), back: a comment,
//                                      an edit, a delete, on one of the owner's own items; then on to `back`
import { checkPhotos, removeUnusedFiles, roleAlbum } from "./posts.js";
import { hostingKey, ownIdentity } from "./keys.js";
import { identityState } from "./identities.js";
import { listEntries, readList, takeRecord, tombstone } from "./hosted.js";
import { parseRecord } from "../public/static/records.js";
import { decode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { MAX_POST_TEXT } from "./edits.js";
import { MAX_COMMENT } from "./archive/comments.js";
import { safeNext } from "./auth.js";
import { messagePage } from "./views/pages.js";
import { html, json, now, Refusal } from "./util.js";

export const ID_RE = /^[A-Za-z0-9_-]{43}$/;
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
      const mine = await env.DB.prepare("SELECT bytes, proof FROM delegations WHERE key = ?").bind(key).first()
        ?? await env.DB.prepare("SELECT bytes, proof FROM known_delegations WHERE key = ?").bind(key).first();
      return mine ? { bytes: String(mine.bytes), proof: JSON.parse(String(mine.proof)) } : null;
    },
  };
}

/** A record as stored in an entry ({sent}), read: {record, content} (content undefined once it's gone). */
function readEntry(e) {
  if (!e.sent) return null;
  const record = parseRecord(fromB64url(e.sent.record));
  const content = e.sent.content ? decode(fromB64url(e.sent.content)) : undefined;
  return record && { record, content };
}

const sentRecord = (sent) => {
  const bytes = typeof sent?.record === "string" ? fromB64url(sent.record) : null;
  return bytes && { bytes, record: parseRecord(bytes), content: sent.content ? decode(fromB64url(sent.content)) : undefined };
};
const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];

/**
 * A new post and its photos as the composer sends them (each photo an item of its own, signed first, then the post
 * listing them): a message saying what's wrong, or null. Checked in full before anything is taken.
 */
async function checkNewPost(env, host, post, photos) {
  if (!post?.record || post.record.kind !== "item" || post.record.author !== host.person || post.content?.type !== "post") return "That isn't a post of yours.";
  const text = typeof post.content.text === "string" ? post.content.text : "";
  if (text !== text.replace(/\r\n?/g, "\n").trim()) return "That post's words aren't as written.";
  if (text.length > MAX_POST_TEXT) return `Posts can be up to ${MAX_POST_TEXT} characters.`;
  const listed = Array.isArray(post.content.photos) ? post.content.photos : [];
  if (!text && !listed.length) return "Write something, or add photos.";
  if (listed.length !== photos.length) return "That post's photos aren't all here.";
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
  if (url.pathname === "/_admin/items") {
    const body = await request.json().catch(() => ({}));
    if (!host) return json({ error: "Set up signing first, in Your devices." }, 409);
    try { return json(await createItem(env, host, body.sent, Array.isArray(body.photos) ? body.photos : [])); } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  const on = /^\/_admin\/items\/([A-Za-z0-9_-]{43})\/(records|remove-photo)$/.exec(url.pathname);
  if (on) {
    const form = await request.formData().catch(() => new FormData());
    const back = new URL(safeNext(String(form.get("back") ?? "/"), url), url.origin);
    const parse = (name) => { try { return JSON.parse(String(form.get(name) ?? "")); } catch { return null; } };
    const sent = parse("sent");
    const refused = (message) => html(messagePage(message, { href: back.pathname + back.search, label: "Go back" }), 400);
    if (!host) return refused("Set up signing first, in Your devices.");
    if (!sent) return refused("This browser can't sign for you yet. Sign out and in again, or set it up in Your devices.");
    if (on[2] === "remove-photo") {
      const answer = await removePhoto(env, host, on[1], sent, parse("change"));
      if (answer.refused) return refused(answer.refused);
      return Response.redirect(`${url.origin}/posts/${answer.post}`, 303);
    }
    const answer = await recordOn(env, host, on[1], sent);
    if (answer.refused) return refused(answer.refused);
    if (answer.deleted) return Response.redirect(`${url.origin}/`, 303);
    back.hash = `i-${on[1]}`;
    return Response.redirect(back.href, 303);
  }
  return new Response("Not found", { status: 404 });
}

const NO_SIGNATURE = "This browser's signature didn't check. Sign out and in again.";

/** A new post with its photos (each an item, taken first): rows for each, and each photo's file. Returns {id}. */
async function createItem(env, host, sent, photosSent) {
  const post = sentRecord(sent);
  const photos = photosSent.slice(0, 21).map(sentRecord);
  const wrong = await checkNewPost(env, host, post, photos);
  if (wrong) throw new Refusal(wrong, 400);
  const lookups = lookupsFor(env);
  const taken = [];
  for (let i = 0; i < photos.length; i++) {
    const answer = await takeRecord(env.DB, { sent: photosSent[i], host, lookups });
    if (answer.refused) {
      for (const t of taken) await tombstone(env.DB, t.id);
      throw new Refusal(answer.refused === "That didn't check." ? NO_SIGNATURE : answer.refused, 400);
    }
    taken.push({ id: answer.entry.fp, at: answer.entry.taken, content: photos[i].content });
  }
  const answer = await takeRecord(env.DB, { sent, host, lookups });
  if (answer.refused) {
    for (const t of taken) await tombstone(env.DB, t.id);
    throw new Refusal(answer.refused === "That didn't check." ? NO_SIGNATURE : answer.refused, 400);
  }
  const id = answer.entry.fp;
  const db = env.DB;
  await db.batch([
    // The "Posted on afterwrd" album, if there are photos and it isn't there yet.
    ...(taken.length ? [roleAlbum(db, "posts")] : []),
    db.prepare(`INSERT INTO items (id, author, type, content, created_at, changed_at, author_last) VALUES (?, ?, 'post', ?, ?, ?, ?)`)
      .bind(id, host.person, JSON.stringify(post.content), answer.entry.taken, answer.entry.taken, id),
    ...taken.flatMap((t, i) => [
      db.prepare(`INSERT INTO items (id, author, type, content, created_at, changed_at, author_last) VALUES (?, ?, 'photo', ?, ?, ?, ?)`)
        .bind(t.id, host.person, JSON.stringify(t.content), t.at, t.at, t.id),
      db.prepare("INSERT INTO item_photos (photo, post, position) VALUES (?, ?, ?)").bind(t.id, id, i),
      db.prepare(`INSERT INTO media (source, path, kind, created_at, width, height, album_id, hash, thumb_hash, size, type, item_id)
        VALUES ('afterwrd', ?, 'photo', ?, ?, ?, (SELECT id FROM albums WHERE role = 'posts'), ?, ?, ?, 'image/jpeg', ?)`)
        .bind(`afterwrd/${t.content.hash}.jpg`, t.at, t.content.width, t.content.height, t.content.hash, t.content.thumb_hash, t.content.size, t.id),
    ]),
  ]);
  return { id };
}

/** The photo items of a post (in order), and the post a photo item is in. */
const photosOf = async (db, post) => (await db.prepare("SELECT photo FROM item_photos WHERE post = ? ORDER BY position").bind(post).all()).results.map((r) => String(r.photo));
const postOf = async (db, photo) => (await db.prepare("SELECT post FROM item_photos WHERE photo = ?").bind(photo).first())?.post ?? null;

/** Everything of an item gone from here: its row, and a photo's file (if nothing else uses it) and its place in its post. */
async function itemGone(env, id) {
  const db = env.DB;
  const files = (await db.prepare("SELECT hash, thumb_hash FROM media WHERE item_id = ?").bind(id).all()).results;
  await db.batch([
    db.prepare("DELETE FROM items WHERE id = ?").bind(id),
    db.prepare("DELETE FROM media WHERE item_id = ?").bind(id),
    db.prepare("DELETE FROM item_photos WHERE photo = ?").bind(id),
    // The "Posted on afterwrd" album goes once nothing's in it.
    db.prepare("DELETE FROM albums WHERE role = 'posts' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.album_id = albums.id)"),
  ]);
  await removeUnusedFiles(env, files.flatMap((f) => [String(f.hash), String(f.thumb_hash)]));
}

/** A record on one of the owner's own items, taken, and the item worked out again. {refused} if not; {deleted} if it was its writer deleting it. */
export async function recordOn(env, host, id, sent) {
  const item = await env.DB.prepare("SELECT id, type, content FROM items WHERE id = ?").bind(id).first();
  if (!item) return { refused: "That post isn't here any more." };
  const got = sentRecord(sent);
  if (!got?.record || got.record.item !== id) return { refused: "That didn't work. Try again." };
  const { record, content } = got;
  if (content !== undefined) {
    const text = typeof content?.text === "string" ? content.text : "";
    if (record.kind === "comment" && (!text.trim() || text.length > MAX_COMMENT)) return { refused: `Comments need 1 to ${MAX_COMMENT} characters.` };
    if (record.kind === "edit" && text.length > (record.about === id ? MAX_POST_TEXT : MAX_COMMENT)) return { refused: "That's too long." };
    // A post with no photos needs its words.
    if (record.kind === "edit" && record.about === id && !text.trim() && !JSON.parse(String(item.content)).photos?.length) {
      return { refused: "A post with no photos needs words." };
    }
  }
  const answer = await takeRecord(env.DB, { sent, host, lookups: lookupsFor(env) });
  if (answer.refused) {
    const said = { "Someone has replied since.": "Someone has replied since, so it can't be changed now.", "That's out of order.": "Something changed meanwhile. Try again." };
    return { refused: said[answer.refused] ?? answer.refused };
  }
  if (answer.deleted) {
    // A post's photos go with it: its delete covers them, so their lists are closed as its is.
    for (const photo of await photosOf(env.DB, id)) {
      await tombstone(env.DB, photo);
      await itemGone(env, photo);
    }
    await itemGone(env, id);
    return { deleted: true };
  }
  await refreshItem(env.DB, id);
  return { ok: true, receipt: answer.receipt, entry: answer.entry };
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
  const row = await db.prepare("SELECT author, content FROM items WHERE id = ?").bind(id).first();
  if (!row) return;
  const author = String(row.author);
  const entries = await listEntries(db, id);
  const read = entries.map((e) => ({ e, r: readEntry(e) }));
  const first = read[0]?.r;
  let content = first?.content ?? JSON.parse(String(row.content));
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
    // The owner's change to what isn't words: which photos a post has (one deleted from it).
    if (r.record.kind === "change" && r.record.author === author && Array.isArray(r.content?.photos)) content = { ...content, photos: r.content.photos };
  }
  comments = thread(read.map(({ e, r }) => ({ ...e, r })), { owner: author, item: id }).filter((c) => c.state === "ok").length;
  await db.prepare(`UPDATE items SET content = ?, earlier = ?, edited_at = ?, comments = ?, others = ?, author_last = ?, changed_at = ? WHERE id = ?`)
    .bind(JSON.stringify(content), earlier.length ? JSON.stringify(earlier) : null, editedAt, comments, others, authorLast, now(), id).run();
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
      const c = { fp: e.fp, n: e.n, author: record.author, text: content?.text ?? "", taken: e.taken, state: "ok", earlier: [], edited_at: null, mentions: record.mentions ?? [] };
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
  // A post's photos, each an item of its own, in the post's order: their files as pages draw them (media rows).
  const { results: media } = r.type === "post"
    ? await db.prepare(`SELECT m.id, m.hash, m.thumb_hash, m.width, m.height, m.kind, m.item_id FROM item_photos ip JOIN media m ON m.item_id = ip.photo
      WHERE ip.post = ? ORDER BY ip.position`).bind(String(r.id)).all()
    : { results: [] };
  return {
    id: String(r.id), author: String(r.author), type: String(r.type), text: content.text ?? "",
    media, photos: content.photos ?? [],
    created_at: Number(r.created_at), edited_at: r.edited_at ? Number(r.edited_at) : null,
    earlier: r.earlier ? JSON.parse(String(r.earlier)) : [], comments: Number(r.comments), others: Number(r.others),
    editable: now() - Number(r.created_at) < EDIT_SECONDS && Number(r.others) === 0,
    // For the signed forms on it (views/items.js): where its list is up to, and its writer's newest record on it.
    list: { host: String(r.author), me: String(r.author), seen: { n: Number(r.list_n), h: String(r.list_head) }, mine: String(r.author_last) },
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
