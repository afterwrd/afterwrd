// What a friend's site may ask of this one besides posts (friendhost.js) and notes (notes.js), always in a signed call
// (calls.js friendCalling: the calling site's identity, which must be a friend's):
//   POST /_p/disconnect           they've removed the owner here, or withdrawn their request, or declined this one's
//   POST /_p/introduce            {origin, name, content?}: their owner introduces the owner here to someone
//                                 (connect.js); either can then ask the other to be friends
//   POST /_p/ask-through          {origin}: their owner would like to be friends with someone who's a friend here
//                                 too; if they are, that site is introduced to them (connect.js passOnAsk)
//   POST /_p/check-token          their site asks for a one-hour read-only token to check this one by itself
//   POST /_p/check-soon           their site was just updated: check it soon (friendchecks.js)
//   POST /_p/check-failed         {site, version, found}: their site checked this one and found something
//   POST /_p/checked              {site, version}: their site checked this one and found it genuine (checks.js)
//   GET  /_p/posts?page=n         the owner's Facebook archive and albums, for their friend pages, through share.js:
//   GET  /_p/posts/<key>            Facebook's posts (if shared), one post, albums, an album's photos, one photo;
//   GET  /_p/albums                 files come as links signed for that friend. Nothing written on afterwrd before
//   GET  /_p/albums/<key>?page=n    signing: those posts are the owner's alone until they're turned into signed
//   GET  /_p/photos/<sha256>        posts (docs/signed-conversations.md, step 10)
// Check calls only ever come from sites on Cloudflare (hosting.js), so one from a self-hosted friend can only be made
// up: it gets nothing, as if there were no such call.
import { bodyBytes, bodyJson, friendCalling } from "./calls.js";
import { onCloudflare } from "./hosting.js";
import { CONTEXT, tidy } from "../public/static/activity.js";
import { shareAlbum, shareAlbums, sharePhoto, sharePost, sharePosts } from "./share.js";
import { ownerName } from "./sites.js";
import { json } from "./util.js";
import { passOnAsk, receiveIntroduction } from "./connect.js";
import { receiveChecked } from "./checks.js";
import { giveCheckToken, receiveCheckFailed, receiveCheckSoon } from "./friendchecks.js";
import { friendGone } from "./events.js";

const CHECKS = /^POST \/_p\/(check-token|check-soon|check-failed|checked)$/;
const SHARED = /^GET \/_p\/(posts|albums|albums\/(\d+|other|videos)|photos\/([0-9a-f]{64})|posts\/(post-\d+-[0-9a-f]{8}))$/;

/** Whether this module answers `route` ("METHOD /path"). */
export const friendCallRoute = (route) => route === "POST /_p/disconnect" || route === "POST /_p/introduce" || route === "POST /_p/ask-through" || CHECKS.test(route) || SHARED.test(route);

export async function handleFriendCalls(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const bytes = request.method === "POST" ? await bodyBytes(request) : null;
  if (request.method === "POST" && !bytes) return json({ error: "That's too big." }, 413);
  // Someone whose request the owner hasn't approved may still withdraw it.
  const caller = await friendCalling(request, env, url, bytes?.length ? bytes : null, { waiting: route === "POST /_p/disconnect" });
  if (caller instanceof Response) return caller;
  const peer = caller.connection;
  const db = env.DB;
  const body = bodyJson(bytes);

  if (route === "POST /_p/disconnect") {
    // The owner's copies of what they said on that site stay: they're theirs (sent; and comments_elsewhere from before
    // signing, until the clear-out after the 30 days to bring things over: clearout.js).
    await db.batch([
      ...friendGone(db, peer.id), // first: it reads who they were
      db.prepare("DELETE FROM connections WHERE id = ?").bind(peer.id),
      db.prepare("DELETE FROM friend_links WHERE connection_id = ?").bind(peer.id),
      db.prepare("DELETE FROM introductions WHERE connection_id = ?").bind(peer.id),
    ]);
    return json({ ok: true });
  }
  if (route === "POST /_p/introduce") return json(...(await receiveIntroduction(env, url, peer, body)));
  if (route === "POST /_p/ask-through") return json(...(await passOnAsk(env, url, peer, body)));
  if (CHECKS.test(route)) {
    if (!onCloudflare(peer.origin, env)) return json({ error: "Not found." }, 404);
    const [answer, status] = route === "POST /_p/check-token" ? await giveCheckToken(env, url, peer, body)
      : route === "POST /_p/check-soon" ? await receiveCheckSoon(env, peer, body)
      : route === "POST /_p/check-failed" ? await receiveCheckFailed(env, url, peer, body)
      : await receiveChecked(env, url, peer, body);
    return json(answer, status);
  }
  const page = Math.min(10_000, Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "", 10) || 1));
  if (route === "GET /_p/posts") return json(await sharePosts(env, url.origin, page, await ownerName(db), peer));
  if (route === "GET /_p/albums") return json(await shareAlbums(env, url.origin, peer));
  const shared = SHARED.exec(route);
  const found = shared[2] ? await shareAlbum(env, url.origin, shared[2], page, peer)
    : shared[3] ? await sharePhoto(env, url.origin, shared[3], peer)
    : await sharePost(env, url.origin, shared[4], await ownerName(db), peer);
  return found ? json(tidy({ "@context": CONTEXT, ...found })) : json({ error: "That isn't there any more." }, 404);
}
