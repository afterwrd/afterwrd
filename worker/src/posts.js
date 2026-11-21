// Photos the owner adds on afterwrd: the helpers shared by signed posts (items.js) and albums (photos.js). Posts written
// on afterwrd before signing stay in `posts` (source 'afterwrd'), the owner's alone and read-only, until migration
// turns them into signed items (docs/signed-conversations.md, step 10).
import { photoKey } from "./archive/comments.js";
import { HASH_RE, mediaStore } from "./media.js";
import { now } from "./util.js";

const MAX_PHOTOS = 20;
const MAX_SIDE = 20_000;

// Albums afterwrd keeps for a purpose (albums.role): photos posted without an album of their own, and the owner's
// profile pictures and covers.
export const ROLE_ALBUMS = { posts: "Posted on afterwrd", profile: "Profile pictures", cover: "Cover photos" };

/** A statement making the album for `role` (ROLE_ALBUMS), unless there is one. */
export function roleAlbum(db, role) {
  return db.prepare(`INSERT INTO albums (source, name, created_at, role) SELECT 'afterwrd', ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM albums WHERE role = ?)`).bind(ROLE_ALBUMS[role], now(), role, role);
}

/**
 * Statements adding photos (in order) to an album: `albumId`, or else the one for `role`; and to the post whose
 * address is `postKey`, if given.
 */
export function addPhotos(db, photos, { albumId = null, role = null }) {
  return photos.map((f) => db.prepare(`INSERT INTO media (source, path, kind, created_at, width, height, album_id,
      hash, thumb_hash, size, type)
    VALUES ('afterwrd', ?, 'photo', ?, ?, ?, COALESCE(?, (SELECT id FROM albums WHERE role = ?)), ?, ?, ?, 'image/jpeg')`)
    .bind(`afterwrd/${f.hash}.jpg`, now(), f.width, f.height, albumId, role, f.hash, f.thumb_hash, f.size));
}

/**
 * Statements deleting the comments on these photos' pictures (photo-<sha256>), once no photo made on afterwrd shows
 * that picture any more. Run after the photos have gone.
 */
export const photoCommentsGone = (db, photos) => photos.map((f) => db.prepare(`DELETE FROM comments WHERE target = ?
  AND NOT EXISTS (SELECT 1 FROM media WHERE hash = ? AND source = 'afterwrd')`).bind(photoKey(f), f.hash));

/** An error message if these uploaded photos' details aren't right, or they aren't all stored yet; else null. */
export async function checkPhotos(env, photos, max = MAX_PHOTOS) {
  if (!Array.isArray(photos) || photos.length > max) return `Up to ${max} photos at a time.`;
  const side = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_SIDE;
  if (!photos.every((f) => f && HASH_RE.test(f.hash) && HASH_RE.test(f.thumb_hash) && side(f.width) && side(f.height)
    && Number.isSafeInteger(f.size) && f.size > 0)) {
    return "Unexpected photo details.";
  }
  const hashes = [...new Set(photos.flatMap((f) => [f.hash, f.thumb_hash]))];
  const stored = (await Promise.all([...new Set(hashes.map((h) => h[0]))].map((shard) =>
    mediaStore(env, shard).has(hashes.filter((h) => h[0] === shard))))).flat();
  return stored.length === hashes.length ? null : "Some photos didn't finish uploading. Try again.";
}

/** Deletes stored files nothing in the archive uses any more (a photo can share a file with an imported one). */
export async function removeUnusedFiles(env, files) {
  files = [...new Set(files.filter(Boolean))];
  if (!files.length) return;
  const marks = files.map(() => "?").join(",");
  // …including by an import under way, whose photos are waiting in media_next.
  const importing = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_next'").first();
  // …or, in a group's own Worker, by a post in the group (group_photos).
  const tables = importing ? ["media", "media_next", "group_photos"] : ["media", "group_photos"];
  const { results: used } = await env.DB.prepare(tables.map((t) => `SELECT hash FROM ${t} WHERE hash IN (${marks})
    UNION SELECT thumb_hash FROM ${t} WHERE thumb_hash IN (${marks})`).join(" UNION "))
    .bind(...tables.flatMap(() => [...files, ...files])).all();
  const unused = files.filter((h) => !used.some((u) => u.hash === h));
  await Promise.all([...new Set(unused.map((h) => h[0]))].map((shard) =>
    mediaStore(env, shard).remove(unused.filter((h) => h[0] === shard))));
}
