// Reading a friend's shared Facebook archive and albums from this one: they come as ActivityStreams from their /_p/
// routes, in signed calls (friendcalls.js and share.js on their side). Everything is checked here and turned into plain
// shapes for the pages; anything malformed is dropped, and every address must be on their own site. (Their signed posts
// come by friendcopies.js.) Photos and videos are shown from the signed links their site gives ("afterwrd:fetch"),
// which the browser loads straight from there.
import { POST_KEY_RE, seconds } from "../public/static/activity.js";
import { HASH_RE } from "./media.js";
import { callFriend } from "./calls.js";

const text = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);

/** A path on their site after `prefix`, or null. */
const own = (site, url, prefix) => (typeof url === "string" && url.startsWith(site + prefix) ? url.slice(site.length + prefix.length) : null);

/**
 * Their signed link for a file, if it's exactly that and nothing more (it ends up in pages, even in style="…"): `hash`
 * too, which comes from what they sent, must be a file's hash and nothing else.
 */
export const signedLink = (site, link, hash) => (typeof link === "string" && HASH_RE.test(hash ?? "") && link.startsWith(`${site}/files/${hash}?`)
  && /^\?exp=\d{1,12}&sig=[\w-]{43}$/.test(link.slice(`${site}/files/${hash}`.length)) ? link : null);

export function parseMedia(m, site) {
  const hash = own(site, m?.url, "/files/");
  if (!["Image", "Video"].includes(m?.type) || !HASH_RE.test(hash ?? "")) return null;
  const src = signedLink(site, m["afterwrd:fetch"], hash);
  if (!src) return null;
  const thumb = own(site, m.preview?.url, "/files/");
  const thumbSrc = HASH_RE.test(thumb ?? "") ? signedLink(site, m.preview["afterwrd:fetch"], thumb) : null;
  return {
    hash, kind: m.type === "Video" ? "video" : "photo", src, thumbSrc: thumbSrc ?? src,
    width: count(m.width), height: count(m.height), description: text(m.name, 5000), created_at: seconds(m.published),
  };
}

/** One of their Facebook posts, as their site sent it; null if it isn't one. */
export function parseNote(note, site) {
  const key = own(site, note?.id, "/posts/");
  const created = seconds(note?.published);
  if (note?.type !== "Note" || !POST_KEY_RE.test(key ?? "") || created === null) return null;
  const attachments = Array.isArray(note.attachment) ? note.attachment.slice(0, 100) : [];
  const link = attachments.find((a) => a?.type === "Link" && /^https?:\/\//.test(a.href ?? ""));
  return {
    key,
    created_at: created,
    text: text(note.content, 60_000) || null,
    title: text(note.summary, 1000),
    kind: text(note["afterwrd:kind"], 30) ?? "status",
    link_url: link ? text(link.href, 2000) : null,
    place: text(note.location?.name, 300),
    group: text(note.context?.name, 300),
    // People tagged in it on Facebook (a name only).
    tags: (Array.isArray(note.tag) ? note.tag.slice(0, 50) : []).filter((t) => t?.href === undefined).map((t) => text(t?.name, 100)).filter(Boolean),
    photos: attachments.map((m) => parseMedia(m, site)).filter(Boolean),
  };
}

/** Who their site says its owner is: name, profile picture (`avatar`) and cover. */
function parseActor(actor, site) {
  return {
    name: text(actor?.name, 100)?.trim() || null,
    avatar: actor?.icon ? parseMedia(actor.icon, site) : null,
    cover: actor?.image ? parseMedia(actor.image, site) : null,
  };
}

/** Calls a friend's site (`connection`), signed by this one (`from`: its address). */
const call = (env, from, connection, path) => callFriend(env, from, connection.origin, path);

export async function friendPosts(env, from, connection, page) {
  const data = await call(env, from, connection, `/_p/posts?page=${page}`);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 100) : [];
  const { avatar, cover } = parseActor(data?.attributedTo, connection.origin);
  return {
    avatar, cover,
    posts: items.map((n) => parseNote(n, connection.origin)).filter(Boolean),
    paging: { page, total: count(data?.totalItems) ?? 0, hasNext: data?.["afterwrd:hasNext"] === true },
  };
}

/** One of their Facebook posts; null if their site says it isn't there (or isn't shown to this one). */
export async function friendPost(env, from, connection, key) {
  let data;
  try {
    data = await call(env, from, connection, `/_p/posts/${key}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const post = parseNote(data, connection.origin);
  if (post?.key !== key) throw new Error("Their site sent something unexpected.");
  return post;
}

export async function friendAlbums(env, from, connection) {
  const data = await call(env, from, connection, "/_p/albums");
  const items = Array.isArray(data?.items) ? data.items.slice(0, 2000) : [];
  return items.flatMap((a) => {
    const key = text(a?.["afterwrd:key"], 20);
    return key && /^(\d+|other|videos)$/.test(key) ? [{
      key, name: text(a.name, 300) ?? "Album", count: count(a.totalItems) ?? 0,
      first_ts: seconds(a.published), last_ts: seconds(a.updated), cover: a.icon ? parseMedia(a.icon, connection.origin) : null,
    }] : [];
  });
}

export async function friendAlbum(env, from, connection, key, page) {
  const data = await call(env, from, connection, `/_p/albums/${key}?page=${page}`);
  const items = Array.isArray(data?.orderedItems) ? data.orderedItems.slice(0, 500) : [];
  return {
    key, name: text(data?.name, 300) ?? "Album", description: text(data?.summary, 5000),
    first_ts: seconds(data?.published), last_ts: seconds(data?.updated), total: count(data?.totalItems) ?? 0,
    media: items.map((m) => parseMedia(m, connection.origin)).filter(Boolean),
    paging: { page, total: count(data?.totalItems) ?? 0, hasNext: data?.["afterwrd:hasNext"] === true },
  };
}

export async function friendPhoto(env, from, connection, hash) {
  const site = connection.origin;
  const data = await call(env, from, connection, `/_p/photos/${hash}`);
  const m = parseMedia(data, site);
  if (!m || m.hash !== hash) throw new Error("Their site sent something unexpected.");
  const album = data["afterwrd:album"];
  const neighbour = (h) => (typeof h === "string" && HASH_RE.test(h) ? h : null);
  return {
    ...m,
    album: album && /^(\d+|other|videos)$/.test(album.key ?? "") ? {
      key: album.key, name: text(album.name, 300) ?? "Album", total: count(album.totalItems) ?? 0, index: count(album.index) ?? 1,
    } : null,
    prev: neighbour(data["afterwrd:prev"]),
    next: neighbour(data["afterwrd:next"]),
    post: data["afterwrd:postedWith"] ? parseNote(data["afterwrd:postedWith"], site) : null,
    // afterwrd 2: a photo in their signed post (share.js): opened there instead.
    inItem: /^[A-Za-z0-9_-]{43}$/.test(data["afterwrd:item"]?.post ?? "") && Number.isSafeInteger(data["afterwrd:item"].index)
      ? { post: data["afterwrd:item"].post, index: data["afterwrd:item"].index } : null,
  };
}
