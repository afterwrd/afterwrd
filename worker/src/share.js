// What this site shows a friend's site of the owner's Facebook archive and albums (friendcalls.js, in signed calls), so
// its owner can see them from their own site, as ActivityStreams (public/static/activity.js). The owner's signed posts
// go by friendhost.js instead; posts written on afterwrd before signing are the owner's alone until they're turned
// into signed posts (docs/signed-conversations.md, step 10), so they, and photos that came with them, aren't shown.
//   posts(page)      Facebook's posts, newest first, with photos, if the owner shares them
//   post(key)        one of those
//   albums()         the albums, with covers
//   album(key, page) one album's photos and videos
//   photo(hash)      one photo or video, the Facebook post it came with, and its neighbours
// Photos and videos aren't sent: each comes with a link signed here ("afterwrd:fetch") for that one friend, which
// their browser loads straight from this site for the next day or two, while they're still a friend (signedFile,
// checked in app.js).
// Every answer is for one friend (`peer`, their connection): their links to files are theirs alone. postShared and
// photoShared are the rule for what's shown.
import { actorId, iso, mediaObject, postId } from "../public/static/activity.js";
import { mediaSet } from "./archive/routes.js";
import { profilePictures } from "./photos.js";
import { fromBase64Url, now, randomToken, toBase64Url } from "./util.js";

const POSTS_PAGE = 30;
const PHOTOS_PAGE = 150;

// --- signed links to files ------------------------------------------------------------------------------------------

let mediaKey = null;
async function key(env) {
  if (!mediaKey) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('media_key', ?)").bind(randomToken()).run();
    const { value } = await env.DB.prepare("SELECT value FROM settings WHERE key = 'media_key'").first();
    mediaKey = await crypto.subtle.importKey("raw", fromBase64Url(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  return mediaKey;
}

const DAY = 86400;
const encode = (text) => new TextEncoder().encode(text);
const signature = async (env, hash, exp) =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encode(`${hash}.${exp}`))));

// A friend's link (signedFile with `friend`) keeps the shape every site checks for (friends.js signedLink:
// ?exp=<digits>&sig=<43 characters>, 32 bytes), so older friends' sites take it as they always have. Its 32 bytes are
// the friend's connection number (FRIEND_BYTES) and then as much of an HMAC of the file, the expiry and that number as
// fits. That message is unlike a plain link's, so neither can stand in for the other.
const FRIEND_BYTES = 4;
const friendMac = async (env, hash, exp, friend) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encode(`${hash}.${exp}.friend.${friend}`)));

/**
 * A link to one stored file that works without signing in until it expires.
 * - For a friend (`friend`: their connection's id, as in their site's copy of the feed): until the end of the next
 *   day (UTC), 24 to 48 hours, the same all day, and only while they're still a friend (signedFor). A day rather than
 *   an hour so the copies friends' sites keep stay usable, and aren't rewritten, for a day, and their browsers keep the
 *   photos (docs/speed-and-scale-plan.md, "Scale test").
 * - A profile picture or cover (`long`): six to seven days, so friends' sites can keep showing it.
 * - Anything else (a group's photos, or ones a group copies from a member's site): one to two hours, on the hour.
 * @param {any} env
 * @param {string} site
 * @param {string} hash
 * @param {{ long?: boolean, friend?: number | null }} [options]
 */
export async function signedFile(env, site, hash, { long = false, friend = null } = {}) {
  if (!long && Number.isSafeInteger(friend) && friend > 0 && friend < 2 ** 32) {
    const exp = (Math.floor(now() / DAY) + 2) * DAY;
    const sig = new Uint8Array(32);
    new DataView(sig.buffer).setUint32(0, friend);
    sig.set((await friendMac(env, hash, exp, friend)).subarray(0, sig.length - FRIEND_BYTES), FRIEND_BYTES);
    return `${site}/files/${hash}?exp=${exp}&sig=${toBase64Url(sig)}`;
  }
  const exp = long ? (Math.floor(now() / DAY) + 7) * DAY : (Math.floor(now() / 3600) + 2) * 3600;
  return `${site}/files/${hash}?exp=${exp}&sig=${await signature(env, hash, exp)}`;
}

/**
 * Whether a request for /files/<hash> carries a good, unexpired signature; returns seconds left, or 0. A friend's
 * link also needs them to be a friend still, so removing someone stops their links at once.
 */
export async function signedFor(env, hash, params) {
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  if (!Number.isSafeInteger(exp) || exp <= now() || !/^[\w-]{43}$/.test(sig)) return 0;
  const bytes = fromBase64Url(sig);
  if (await crypto.subtle.verify("HMAC", await key(env), bytes, encode(`${hash}.${exp}`))) return exp - now();
  // Never longer than a friend's link is ever signed for.
  if (exp > (Math.floor(now() / DAY) + 2) * DAY) return 0;
  const friend = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const mac = (await friendMac(env, hash, exp, friend)).subarray(0, bytes.length - FRIEND_BYTES);
  if (!crypto.subtle.timingSafeEqual(mac, bytes.subarray(FRIEND_BYTES))) return 0;
  const still = await env.DB.prepare("SELECT 1 FROM connections WHERE id = ? AND connected_at IS NOT NULL AND approved_at IS NOT NULL")
    .bind(friend).first();
  return still ? exp - now() : 0;
}

// --- what's shared --------------------------------------------------------------------------------------------------

/** The owner as a Person, with their profile picture (icon) and cover (image): see profilePictures. */
export async function ownerActor(env, site, name) {
  const db = env.DB;
  const pictures = await profilePictures(db);
  const pick = async (p) => {
    const m = p && await db.prepare("SELECT * FROM media WHERE id = ?").bind(p.id).first();
    return m ? media(env, site, m, { long: true }) : undefined;
  };
  return { type: "Person", id: actorId(site), name, icon: await pick(pictures.profile), image: await pick(pictures.cover) };
}

async function chosen(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sections'").first();
  return row ? JSON.parse(row.value) : [];
}

/** A photo or video for a friend's site (`friend`: their connection's id), or with a `long` link for any of them. */
async function media(env, site, m, { long = false, friend = null } = {}) {
  const object = mediaObject(site, m, { "afterwrd:fetch": await signedFile(env, site, m.hash, { long, friend }) });
  if (object.preview && m.thumb_hash) object.preview["afterwrd:fetch"] = await signedFile(env, site, m.thumb_hash, { long, friend });
  delete object.location; // where photos were taken stays here
  return object;
}

/** Facebook's posts as Notes for a friend (`peer`, their connection), with photos (signed links for them), tags and place. */
async function notes(env, site, posts, peer) {
  const db = env.DB;
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const marks = ids.map(() => "?").join(",");
  const [photos, tags] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE post_id IN (${marks}) AND hash IS NOT NULL ORDER BY created_at, id`).bind(...ids),
    db.prepare(`SELECT t.post_id, p.name FROM facebook_post_tags t JOIN facebook_people p ON p.id = t.person_id
      WHERE t.post_id IN (${marks})`).bind(...ids),
  ]);
  return Promise.all(posts.map(async (p) => ({
    type: "Note",
    id: postId(site, p.key),
    attributedTo: actorId(site),
    published: iso(p.created_at),
    summary: p.title || undefined,
    mediaType: "text/plain",
    content: p.text ?? "",
    attachment: [
      ...await Promise.all(photos.results.filter((m) => m.post_id === p.id).map((m) => media(env, site, m, { friend: peer.id }))),
      ...(p.link_url ? [{ type: "Link", href: p.link_url }] : []),
    ],
    tag: tags.results.filter((t) => t.post_id === p.id).map((t) => ({ type: "Mention", name: t.name })),
    location: p.place_name ? { type: "Place", name: p.place_name } : undefined,
    context: p.group_name ? { type: "Group", name: p.group_name } : undefined,
    "afterwrd:kind": p.kind ?? undefined,
  })));
}

/** Facebook's posts a friend (`peer`) may see, a page at a time, newest first: all, if the owner shares them; else none. */
export async function sharePosts(env, site, page, name, peer) {
  const db = env.DB;
  const shared = (await chosen(db)).includes("posts");
  const where = "WHERE p.source <> 'afterwrd'";
  const [count, rows] = shared ? await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`),
    db.prepare(`SELECT p.* FROM posts p ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ?1 OFFSET ?2`)
      .bind(POSTS_PAGE, (page - 1) * POSTS_PAGE),
  ]) : [{ results: [{ n: 0 }] }, { results: [] }];
  const total = Number(count.results[0].n);
  return {
    type: "OrderedCollectionPage", attributedTo: await ownerActor(env, site, name), totalItems: total, "afterwrd:page": page,
    "afterwrd:hasNext": page * POSTS_PAGE < total, orderedItems: await notes(env, site, rows.results, peer),
  };
}

/** One of Facebook's posts (by its key), if `peer` may see it; else null. */
export async function sharePost(env, site, key, name, peer) {
  const post = await env.DB.prepare("SELECT * FROM posts WHERE key = ?").bind(key).first();
  if (!post || !(await postShared(env.DB, post))) return null;
  return { ...(await notes(env, site, [post], peer))[0], attributedTo: await ownerActor(env, site, name) };
}

/** The albums the friend may see: all of them if Photos is published, otherwise just those made on afterwrd. */
async function setKeys(db) {
  const imported = (await chosen(db)).includes("photos");
  const { results } = await db.prepare(`SELECT id FROM albums ${imported ? "" : "WHERE source = 'afterwrd'"}`).all();
  return [...results.map((a) => String(a.id)), ...(imported ? ["other", "videos"] : [])];
}

// Photos that came with a post written on afterwrd before signing are that post's, and the owner's alone for now, so
// they're never in an album friends are shown. (A signed post's photos are items of their own: sharePhoto.)
const NOT_CHOSEN = "NOT EXISTS (SELECT 1 FROM posts q WHERE q.id = media.post_id AND q.source = 'afterwrd')";

async function setInfo(db, key) {
  const { where, ...rest } = mediaSet(key);
  const set = { ...rest, where: `${where} AND ${NOT_CHOSEN}` };
  const stats = await db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts,
    MAX(id) AS last_id FROM media WHERE ${set.where} AND hash IS NOT NULL`).bind(...set.params).first();
  const album = set.title === null ? await db.prepare("SELECT * FROM albums WHERE id = ?").bind(...set.params).first() : null;
  return { set, stats, name: set.title ?? album?.name, album };
}

export async function shareAlbums(env, site, peer) {
  const db = env.DB;
  const items = [];
  for (const key of await setKeys(db)) {
    const { set, stats, name, album } = await setInfo(db, key);
    if (!stats.count) continue;
    const cover = await db.prepare(`SELECT * FROM media WHERE ${album?.cover_media_id ? `id = ? AND ${NOT_CHOSEN}` : `${set.where} AND hash IS NOT NULL ORDER BY created_at DESC`} LIMIT 1`)
      .bind(...(album?.cover_media_id ? [album.cover_media_id] : set.params)).first();
    items.push({
      type: "Collection", name, totalItems: stats.count, "afterwrd:key": key,
      published: iso(stats.first_ts), updated: iso(stats.last_ts), icon: cover?.hash ? await media(env, site, cover, { friend: peer.id }) : undefined,
    });
  }
  return { type: "Collection", totalItems: items.length, items };
}

export async function shareAlbum(env, site, key, page, peer) {
  const db = env.DB;
  if (!(await setKeys(db)).includes(key)) return null;
  const { set, stats, name, album } = await setInfo(db, key);
  const { results } = await db.prepare(`SELECT * FROM media WHERE ${set.where} AND hash IS NOT NULL
    ORDER BY COALESCE(created_at, 0), id LIMIT ? OFFSET ?`).bind(...set.params, PHOTOS_PAGE, (page - 1) * PHOTOS_PAGE).all();
  return {
    type: "OrderedCollectionPage", name, summary: album?.description || undefined, totalItems: stats.count,
    published: iso(stats.first_ts), updated: iso(stats.last_ts), "afterwrd:key": key, "afterwrd:page": page,
    "afterwrd:hasNext": page * PHOTOS_PAGE < stats.count, orderedItems: await Promise.all(results.map((m) => media(env, site, m, { friend: peer.id }))),
  };
}

/** Whether friends may see this post: one of Facebook's, if the owner has shared those. */
async function postShared(db, post) {
  return post.source !== "afterwrd" && (await chosen(db)).includes("posts");
}

/** The album (or Facebook set) a photo is shown in: share.js setKeys' key for it; null for none. */
const setKey = (m) => (m.album_id ? String(m.album_id) : m.source !== "facebook" ? null : m.kind === "video" ? "videos" : "other");

const postById = (db, id) => db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first();

/**
 * Whether friends may see this photo or video: it's in an album they're shown, or it came with a post they're shown,
 * and it didn't come with a post written here before signing. Anything else isn't theirs to see, even if they know
 * its fingerprint.
 */
async function photoShared(db, m) {
  const post = m.post_id ? await postById(db, m.post_id) : null;
  if (post?.source === "afterwrd") return false;
  const key = setKey(m);
  if (key && (await setKeys(db)).includes(key)) return true;
  return Boolean(post) && postShared(db, post);
}

export async function sharePhoto(env, site, hash, peer) {
  const db = env.DB;
  // A picture both imported and posted on afterwrd is shown as afterwrd's.
  const m = await db.prepare("SELECT * FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1").bind(hash).first();
  if (!m || !(await photoShared(db, m))) return null;
  const key = setKey(m);
  const neighbours = {};
  if (key && (await setKeys(db)).includes(key)) {
    const { set, stats, name } = await setInfo(db, key);
    const order = "(COALESCE(created_at, 0), id)";
    const at = [m.created_at ?? 0, m.id];
    const [prev, next, before] = await db.batch([
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)
        ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT hash FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} > (?, ?)
        ORDER BY COALESCE(created_at, 0), id LIMIT 1`).bind(...set.params, ...at),
      db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${set.where} AND hash IS NOT NULL AND ${order} < (?, ?)`).bind(...set.params, ...at),
    ]);
    Object.assign(neighbours, {
      "afterwrd:album": { key, name, totalItems: stats.count, index: before.results[0].n + 1 },
      "afterwrd:prev": prev.results[0]?.hash, "afterwrd:next": next.results[0]?.hash,
    });
  }
  // afterwrd 2: a photo in a signed post is an item of its own, whose comments are signed (items.js): where it is, so
  // the friend's site opens it there (and it takes no comments here).
  if (m.item_id) {
    const at = await db.prepare("SELECT post, position FROM item_photos WHERE photo = ?").bind(m.item_id).first();
    if (at) return { ...await media(env, site, m, { friend: peer.id }), ...neighbours, "afterwrd:item": { post: String(at.post), index: Number(at.position) + 1 } };
  }
  // The post it came with, if that's one the friend may see.
  const withPost = m.post_id && await postById(db, m.post_id);
  const post = withPost && (await postShared(db, withPost)) ? withPost : null;
  return {
    ...await media(env, site, m, { friend: peer.id }),
    ...neighbours,
    "afterwrd:postedWith": post ? (await notes(env, site, [post], peer))[0] : undefined,
  };
}
