// Download everything (src/export.js): reads every table a page at a time, turns it into ActivityStreams
// documents (../activity.js), and writes them and every photo and video into a zip, straight to a file where
// the browser allows it (Chrome, Edge) and in memory otherwise. The rows themselves go in too (site/), with the
// thumbnails, so another afterwrd site can take the whole site in (src/move.js, ../import/move.js).
/* global zip */
import {
  actorId, commentAuthor, commentId, commentNote, CONTEXT, editedFields, groupId, groupPostId, iso, mediaObject, postId, targetId, tidy,
} from "../activity.js";

const EXTENSIONS = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};
const TABLES = ["settings", "facebook_people", "albums", "posts", "facebook_post_tags", "facebook_comments",
  "facebook_reactions", "media", "facebook_tagged_photos", "comments", "comments_elsewhere", "polls", "poll_votes",
  "connections", "friend_links", "users", "groups", "group_mine", "post_versions", "comment_versions",
  "comments_elsewhere_versions", "events", "event_answers", "post_audience", "events_elsewhere",
  // afterwrd 2: signed posts and photos, their lists, and what the owner has signed and sent (src/export.js).
  "items", "item_photos", "lists", "list_pages", "sent", "own_identity", "item_guests"];
/** JSON from base64url (a signed record's content), or null. */
const fromB64json = (text) => {
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))); } catch { return null; }
};

const form = /** @type {HTMLFormElement} */ (document.getElementById("export"));
const status = document.getElementById("status");
const error = document.getElementById("error");
const button = /** @type {HTMLButtonElement} */ (document.getElementById("go"));
const site = location.origin;

async function rows(table) {
  const all = [];
  let after = 0;
  do {
    const response = await fetch(`/_admin/export/rows?table=${table}&after=${after}`);
    if (!response.ok) throw new Error(`Couldn't read ${table} (the site said ${response.status}).`);
    const page = await response.json();
    all.push(...page.rows);
    after = page.next;
  } while (after);
  return all;
}

const unique = (media) => [...new Map(media.filter((m) => m.hash).map((m) => [m.hash, m])).values()];
const fileFor = (m) => `media/${m.hash}${EXTENSIONS[m.type] ?? ""}`;
// Thumbnails, which only a move needs: the media rows name them (thumb_hash), and the extension says their type.
const thumbsOf = (media) => [...new Set(media.map((m) => m.thumb_hash).filter(Boolean))];
const megabytes = (n) => `${(n / 1e6).toLocaleString("en-GB", { maximumFractionDigits: n < 1e7 ? 1 : 0 })} MB`;

// Sizes for the label, and a note where the download has to fit in memory.
rows("media").then((list) => {
  const files = unique(list);
  if (files.length) {
    document.getElementById("size").textContent = `(${files.length.toLocaleString("en-GB")} files, ${megabytes(files.reduce((n, m) => n + (m.size ?? 0), 0))})`;
  }
}).catch(() => {});
if (!window.showSaveFilePicker) document.getElementById("memory").hidden = false;

/** Every document in the download, keyed by its name in the zip. */
function documents(t) {
  const owner = t.users[0] ?? { name: "Owner" };
  const me = t.facebook_people.find((p) => p.is_me);
  const people = new Map(t.facebook_people.map((p) => [p.id, p]));
  const users = new Map(t.users.map((u) => [u.id, u]));
  const byHash = new Map(t.media.filter((m) => m.hash).map((m) => [m.hash, m]));
  const media = (m) => mediaObject(site, m, { "afterwrd:file": fileFor(m) });
  const person = (id) => (people.get(id) ? { type: "Person", name: people.get(id).name } : undefined);
  const link = (url) => (url ? { type: "Link", href: url } : undefined);
  const picture = (key, fallbackId) => {
    const chosen = t.settings.find((s) => s.key === key)?.value;
    const m = (chosen && byHash.get(chosen)) || t.media.find((x) => x.id === fallbackId && x.hash);
    return m ? media(m) : undefined;
  };

  // What edited posts and comments said before (src/edits.js), oldest first, by what they belong to.
  const earlierOf = (rows, column) => {
    const map = new Map();
    for (const v of [...rows].sort((a, b) => a.id - b.id)) {
      if (!map.has(v[column])) map.set(v[column], []);
      map.get(v[column]).push(v);
    }
    return (id) => map.get(id) ?? [];
  };
  const postEarlier = earlierOf(t.post_versions, "post_id");
  const commentEarlier = earlierOf(t.comment_versions, "comment_id");
  const elsewhereEarlier = earlierOf(t.comments_elsewhere_versions, "comment_id");

  // Comments written on this site, by what they're on.
  const threads = new Map();
  for (const c of t.comments) {
    const user = users.get(c.author_id);
    const row = { ...c, name: user?.name ?? c.author_name, author_is_owner: Boolean(c.author_id), earlier: commentEarlier(c.id) };
    if (!threads.has(c.target)) threads.set(c.target, []);
    threads.get(c.target).push(commentNote(site, row, commentAuthor(site, row)));
  }
  const replies = (target) => {
    const items = threads.get(target);
    return items?.length ? { type: "Collection", totalItems: items.length, items } : undefined;
  };
  const collection = (items, extra = {}) => ({ "@context": CONTEXT, type: "OrderedCollection", totalItems: items.length, ...extra, orderedItems: items });
  const newest = (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0);

  // A poll in a post written here (src/polls.js), as a Question: each option with how many chose it, and who.
  const poll = (p) => {
    const q = t.polls.find((x) => x.post_id === p.id);
    if (!q) return undefined;
    const votes = t.poll_votes.filter((v) => v.post_id === q.post_id);
    const who = (v) => (v.voter === "site" ? { type: "Person", id: actorId(site), name: owner.name } : { type: "Person", id: actorId(v.voter), name: v.name });
    return {
      type: "Question",
      [q.multiple ? "anyOf" : "oneOf"]: JSON.parse(q.options).map((name, i) => {
        const chose = votes.filter((v) => v.choices & (1 << i));
        return { type: "Note", name, replies: { type: "Collection", totalItems: chose.length }, "afterwrd:voters": chose.map(who) };
      }),
      endTime: iso(q.closes_at), closed: iso(q.closed_at ?? (q.closes_at && q.closes_at * 1000 < Date.now() ? q.closes_at : undefined)),
      votersCount: votes.length,
    };
  };
  // An event (src/events.js, src/calendar.js eventObject), as sent between sites.
  const eventFields = (e) => ({
    type: "Event", name: e.title, startTime: iso(e.starts_at), endTime: iso(e.ends_at ?? undefined), "afterwrd:allDay": Boolean(e.all_day),
    "afterwrd:timeZone": e.time_zone, location: e.place ? { type: "Place", name: e.place } : undefined, "afterwrd:cancelled": iso(e.cancelled_at ?? undefined),
  });
  const friend = (id) => {
    const c = t.connections.find((x) => x.id === id);
    return c ? { type: "Person", id: actorId(c.origin), name: c.name } : { type: "Person", name: "A friend you're no longer connected with" };
  };
  // The owner's event in a post, with who was invited and what each answered.
  const event = (p) => {
    const e = t.events.find((x) => x.post_id === p.id);
    if (!e) return undefined;
    const answer = (id) => t.event_answers.find((a) => a.post_id === p.id && a.connection_id === id)?.answer;
    return { ...eventFields(e), "afterwrd:invited": t.post_audience.filter((a) => a.post_id === p.id)
      .map((a) => ({ ...friend(a.connection_id), "afterwrd:answer": answer(a.connection_id) })) };
  };
  // afterwrd 2: signed posts and photos (src/items.js). Each one's comments are worked out from its list, as its pages
  // do: in order, with each comment's words now and what they were; deleted and removed ones left out. A signed
  // comment's address is its item's, then # and the record's fingerprint, the same in whoever's download it's in.
  const ownPerson = t.own_identity[0]?.person ?? null;
  const byIdentity = new Map(t.connections.filter((c) => c.identity).map((c) => [c.identity, c]));
  const authorOf = (person) => (person === ownPerson ? { type: "Person", id: actorId(site), name: owner.name }
    : byIdentity.get(person) ? { type: "Person", id: actorId(byIdentity.get(person).origin), name: byIdentity.get(person).name }
      : { type: "Person", "afterwrd:identity": person });
  const entriesOf = (list) => t.list_pages.filter((pg) => pg.list === list).sort((a, b) => a.page - b.page)
    .flatMap((pg) => JSON.parse(pg.entries));
  const signedReplies = (list) => {
    const comments = [];
    const byFp = new Map();
    for (const e of entriesOf(list)) {
      if (!e.sent) continue;
      const record = fromB64json(e.sent.record);
      const content = e.sent.content ? fromB64json(e.sent.content) : null;
      if (!record) continue;
      if (record.kind === "comment") {
        const c = { type: "Note", id: `${postId(site, list)}#${e.fp}`, attributedTo: authorOf(record.author), inReplyTo: postId(site, list),
          published: iso(e.taken), mediaType: "text/plain", content: content?.text ?? "", earlier: [] };
        byFp.set(e.fp, c);
        comments.push(c);
      } else if (record.kind === "edit" && byFp.has(record.about)) {
        const c = byFp.get(record.about);
        c.earlier.push({ text: c.content, replaced_at: e.taken });
        c.content = content?.text ?? c.content;
        c.edited_at = e.taken;
      } else if ((record.kind === "delete" || record.kind === "remove") && byFp.has(record.about)) {
        byFp.get(record.about).gone = true;
      }
    }
    const items = comments.filter((c) => !c.gone).map(({ earlier, edited_at: at, gone, ...c }) => ({ ...c, ...editedFields({ edited_at: at, earlier }) }));
    return items.length ? { type: "Collection", totalItems: items.length, items } : undefined;
  };
  const signedMedia = (photo) => t.media.find((m) => m.item_id === photo && m.hash);
  const signedPosts = t.items.filter((i) => i.type === "post").map((i) => {
    const content = JSON.parse(i.content);
    const photos = t.item_photos.filter((p) => p.post === i.id).sort((a, b) => a.position - b.position).map((p) => signedMedia(p.photo)).filter(Boolean);
    const tally = i.tally ? JSON.parse(i.tally) : null;
    // A signed poll, with how many chose each option (who chose what is in signed.json's lists), and a signed event,
    // with who was invited and what each answered (step 4d: src/itemkinds.js).
    const votes = Object.values(tally?.votes ?? {});
    const poll = content.poll && { type: "Question", [content.poll.multiple ? "anyOf" : "oneOf"]: content.poll.options.map((name, n) => ({
      type: "Note", name, replies: { type: "Collection", totalItems: votes.filter((m) => m & (1 << n)).length } })),
      endTime: iso(content.poll.closes_at ?? undefined), closed: iso(tally?.ended_at ?? undefined), votersCount: votes.length };
    const answers = tally?.answers ?? {};
    const event = content.event && { ...eventFields({ ...content.event, cancelled_at: content.event.cancelled ? content.event.cancelled_at : undefined }),
      "afterwrd:invited": t.item_guests.filter((g) => g.item === i.id).map((g) => ({ ...friend(g.connection_id), "afterwrd:answer": answers[g.person]?.answer })) };
    return { type: "Note", id: postId(site, i.id), attributedTo: actorId(site), published: iso(i.created_at), mediaType: "text/plain",
      content: content.text ?? "", attachment: photos.map(media), "afterwrd:source": "afterwrd", "afterwrd:signed": true, created_at: i.created_at,
      ...(poll && { "afterwrd:poll": poll }), ...(event && { "afterwrd:event": event }),
      ...editedFields({ edited_at: i.edited_at, earlier: i.earlier ? JSON.parse(i.earlier) : [] }), replies: signedReplies(i.id) };
  });
  const postIds = new Map();
  const posts = [...t.posts].sort(newest).map((p) => {
    const { key } = p;
    postIds.set(p.id, postId(site, key));
    return {
      type: "Note",
      id: postId(site, key),
      attributedTo: actorId(site),
      published: iso(p.created_at),
      summary: p.title || undefined,
      mediaType: "text/plain",
      content: p.text ?? "",
      attachment: [...t.media.filter((m) => m.post_id === p.id && m.hash).map(media), link(p.link_url)].filter(Boolean),
      tag: t.facebook_post_tags.some((x) => x.post_id === p.id)
        ? t.facebook_post_tags.filter((x) => x.post_id === p.id).map((x) => ({ type: "Mention", name: people.get(x.person_id)?.name })) : undefined,
      location: p.place_name || p.latitude != null
        ? { type: "Place", name: p.place_name || undefined, "afterwrd:address": p.place_address || undefined,
          latitude: p.latitude ?? undefined, longitude: p.longitude ?? undefined } : undefined,
      context: p.group_name ? { type: "Group", name: p.group_name } : undefined,
      "afterwrd:kind": p.kind,
      "afterwrd:onWallOf": person(p.target_id),
      "afterwrd:source": p.source,
      ...editedFields({ ...p, earlier: postEarlier(p.id) }),
      "afterwrd:facebookId": p.fbid || undefined,
      "afterwrd:poll": poll(p),
      "afterwrd:event": event(p),
      // Who could see it: all friends, unless it was for some only (an event, for those invited).
      "afterwrd:audience": p.audience === "chosen" ? "chosen" : undefined,
      replies: replies(key),
    };
  });

  const albums = new Map(t.albums.map((a) => [a.id, a]));
  const photos = [...t.media].filter((m) => m.hash).sort(newest).map((m) => ({
    ...media(m),
    "afterwrd:album": albums.get(m.album_id)?.name,
    "afterwrd:postedWith": m.item_id ? postId(site, t.item_photos.find((p) => p.photo === m.item_id)?.post ?? "") : postIds.get(m.post_id),
    // A photo in a signed post has its own signed comments (src/items.js), at its own item's address.
    ...(m.item_id ? { "afterwrd:item": postId(site, m.item_id), replies: signedReplies(m.item_id) } : { replies: replies(`photo-${m.hash}`) }),
  }));

  return {
    "profile.json": {
      "@context": CONTEXT,
      type: "Person",
      id: actorId(site),
      url: actorId(site),
      name: owner.name,
      "afterwrd:facebookName": me?.name,
      // The picture and cover chosen on afterwrd, or else Facebook's.
      icon: picture("profile_hash", me?.profile_media_id),
      image: picture("cover_hash", me?.cover_media_id),
      "afterwrd:sections": JSON.parse(t.settings.find((s) => s.key === "sections")?.value ?? "[]"),
    },
    "posts.json": collection([...posts, ...signedPosts.map(({ created_at: at, ...p }) => ({ ...p, _at: at }))]
      .sort((a, b) => (Date.parse(b.published ?? 0) || 0) - (Date.parse(a.published ?? 0) || 0)).map(({ _at, ...p }) => p), { name: "Posts" }),
    "photos.json": collection(photos, { name: "Photos and videos" }),
    "albums.json": collection(t.albums.map((a) => {
      const inIt = t.media.filter((m) => m.album_id === a.id && m.hash);
      // Facebook says when its albums last changed and which photo is the cover; afterwrd's go by their newest photo.
      const cover = t.media.find((m) => m.id === a.cover_media_id && m.hash) ?? [...inIt].sort(newest)[0];
      return {
        type: "Collection",
        name: a.name,
        summary: a.description || undefined,
        published: iso(a.created_at),
        updated: iso(a.last_modified ?? [...inIt].sort(newest)[0]?.created_at),
        "afterwrd:source": a.source,
        "afterwrd:cover": cover ? `${site}/photos/sha256/${cover.hash}` : undefined,
        items: inIt.map((m) => `${site}/photos/sha256/${m.hash}`),
      };
    }), { name: "Albums" }),
    "facebook-comments.json": collection([...t.facebook_comments].sort(newest).map((c) => ({
      type: "Note",
      attributedTo: c.author_id && c.author_id !== me?.id ? person(c.author_id) : actorId(site),
      published: iso(c.created_at),
      summary: c.title || undefined,
      mediaType: "text/plain",
      content: c.text ?? undefined,
      attachment: [...t.media.filter((m) => m.comment_id === c.id && m.hash).map(media), link(c.link_url)].filter(Boolean),
      context: c.group_name ? { type: "Group", name: c.group_name } : undefined,
      "afterwrd:action": c.action,
      // Facebook's download doesn't say which post a comment was on; this is what it does say.
      "afterwrd:on": c.target_kind || c.target_owner_id
        ? { type: "Object", "afterwrd:kind": c.target_kind || undefined, attributedTo: person(c.target_owner_id) } : undefined,
    })), { name: "Your comments on Facebook" }),
    "facebook-likes.json": collection([...t.facebook_reactions].sort(newest).map((r) => ({
      type: "Like",
      actor: actorId(site),
      published: iso(r.created_at),
      summary: r.title || undefined,
      object: r.url || { type: "Object", "afterwrd:kind": r.target_kind || undefined, attributedTo: person(r.target_owner_id) },
      context: r.group_name ? { type: "Group", name: r.group_name } : undefined,
      "afterwrd:reaction": r.reaction,
      "afterwrd:facebookId": r.fbid || undefined,
    })), { name: "Your likes and reactions on Facebook" }),
    "facebook-tagged.json": collection([...t.facebook_tagged_photos].sort(newest).map((x) => ({
      type: "Image", url: x.url || undefined, published: iso(x.created_at), attributedTo: person(x.owner_id),
      "afterwrd:facebookId": x.fbid || undefined,
    })), { name: "Photos you're tagged in on Facebook" }),
    "facebook-people.json": collection(t.facebook_people.filter((p) => !p.is_me).map((p) => ({
      type: "Person", name: p.name, "afterwrd:friendSince": iso(p.friend_since), "afterwrd:unfriendedAt": iso(p.unfriended_at),
    })), { name: "People from your Facebook download" }),
    "connections.json": collection(t.connections.map((c) => ({
      type: "Person", id: actorId(c.origin), url: actorId(c.origin), name: c.name, "afterwrd:connectedAt": iso(c.connected_at),
      // Who they are in the Facebook download, if linked on Friends.
      "afterwrd:facebookName": t.friend_links.find((l) => l.connection_id === c.id)?.person_name || undefined,
    })), { name: "Friends' afterwrd sites you're connected with" }),
    "groups.json": collection(t.groups.map((g) => ({
      type: "Group", id: groupId(g.origin, g.remote_id), name: g.name, summary: g.about || undefined,
      "afterwrd:owner": { type: "Person", name: g.host_name }, "afterwrd:role": g.role || undefined, "afterwrd:joinedAt": iso(g.joined_at),
    })), { name: "Groups you're in (each is its own site, which keeps everything in it)" }),
    // Friends' events you were invited to, and groups' events you said you'd go to, as your site last heard of them.
    ...(t.events_elsewhere.length ? { "events-elsewhere.json": collection([...t.events_elsewhere].sort((a, b) => a.starts_at - b.starts_at).map((e) => {
      const g = e.group_id ? t.groups.find((x) => x.id === e.group_id) : null;
      const c = e.connection_id ? t.connections.find((x) => x.id === e.connection_id) : null;
      return { ...eventFields(e),
        url: c ? postId(c.origin, e.post_key) : g ? groupPostId(g.origin, g.remote_id, e.post_id) : undefined,
        attributedTo: c ? friend(c.id) : undefined, context: g ? groupId(g.origin, g.remote_id) : undefined,
        "afterwrd:date": e.date || undefined, // which date of a repeating group event
        "afterwrd:answer": e.answer ?? undefined, "afterwrd:invitedAt": iso(e.invited_at ?? undefined) };
    }), { name: "Friends' and groups' events on your calendar" }) } : {}),
    "groups-elsewhere.json": collection([...signedInGroups(), ...[...t.group_mine].sort((a, b) => b.created_at - a.created_at).map((m) => {
      const post = groupPostId(m.site, m.remote_group, m.post_id);
      return {
        type: "Note", id: m.kind === "post" ? post : `${post}#c${m.remote_id}`, attributedTo: actorId(site),
        inReplyTo: m.kind === "post" ? undefined : post, context: groupId(m.site, m.remote_group),
        published: iso(m.created_at), mediaType: "text/plain", content: m.text ?? "",
        "afterwrd:poll": m.poll ? (({ options, multiple, closes_at: closes }) => ({ type: "Question",
          [multiple ? "anyOf" : "oneOf"]: options.map((name) => ({ type: "Note", name })), endTime: iso(closes) }))(JSON.parse(m.poll)) : undefined,
      };
    })], { name: "What you've posted and said in groups (the originals are kept on each group's site)" }),
    "comments-elsewhere.json": collection([...t.comments_elsewhere].filter((c) => c.site).sort((a, b) => b.created_at - a.created_at)
      .map((c) => ({
        type: "Note",
        id: commentId(c.site, c.target, c.remote_id),
        attributedTo: actorId(site),
        inReplyTo: targetId(c.site, c.target),
        published: iso(c.created_at),
        mediaType: "text/plain",
        content: c.text,
        ...editedFields({ ...c, earlier: elsewhereEarlier(c.id) }),
      })).concat(sentComments()), { name: "Your comments on friends' sites (the originals are kept there)" }),
    // afterwrd 2: what proves it all, as signed, for anyone to check (docs/signed-conversations.md): the owner's identity,
    // every list this site holds (each entry's record exactly as signed), and what they've signed and sent elsewhere.
    "signed.json": {
      "afterwrd:identity": { person: ownPerson, chain: t.own_identity[0] ? JSON.parse(t.own_identity[0].chain) : [] },
      "afterwrd:lists": t.lists.map((l) => ({ id: l.id, owner: l.owner, n: l.n, head: l.head, deleted: Boolean(l.deleted_at), entries: entriesOf(l.id) })),
      "afterwrd:sent": t.sent.map((x) => ({ host: x.host, item: x.item, kind: x.kind, fp: x.fp, sent: JSON.parse(x.record), receipt: x.receipt ? JSON.parse(x.receipt) : null })),
    },
  };

  /**
   * What the owner signed in groups with an identity (sent, step 6c): their posts and comments there, newest first, with
   * their words now (edits applied; deleted ones left out). Photos are named by the post they're in.
   */
  function signedInGroups() {
    const byGroup = new Map(t.groups.filter((g) => g.identity).map((g) => [g.identity, g]));
    const out = new Map();
    for (const x of [...t.sent].sort((a, b) => a.created_at - b.created_at)) {
      const g = byGroup.get(x.host);
      const sent = JSON.parse(x.record);
      const record = fromB64json(sent.record);
      const content = sent.content ? fromB64json(sent.content) : null;
      if (!g || !record) continue;
      const post = groupPostId(g.origin, g.remote_id, x.item);
      if (x.kind === "item" && content?.type !== "photo") {
        out.set(x.fp, { type: "Note", id: post, attributedTo: actorId(site), context: groupId(g.origin, g.remote_id), published: iso(x.created_at),
          mediaType: "text/plain", content: content?.text ?? "", "afterwrd:signed": true, earlier: [], edited_at: null,
          ...(content?.event && { "afterwrd:event": content.event }),
          ...(content?.poll && { "afterwrd:poll": { type: "Question", [content.poll.multiple ? "anyOf" : "oneOf"]: content.poll.options.map((name) => ({ type: "Note", name })),
            endTime: iso(content.poll.closes_at ?? undefined) } }) });
      } else if (x.kind === "comment") {
        out.set(x.fp, { type: "Note", id: `${post}#${x.fp}`, attributedTo: actorId(site), inReplyTo: post, context: groupId(g.origin, g.remote_id),
          published: iso(x.created_at), mediaType: "text/plain", content: content?.text ?? "", "afterwrd:signed": true, earlier: [], edited_at: null });
      } else if (x.kind === "edit" && out.has(record.about)) {
        const c = out.get(record.about);
        c.earlier.push({ text: c.content, replaced_at: x.created_at });
        c.content = content?.text ?? c.content;
        c.edited_at = x.created_at;
      } else if (x.kind === "change" && out.has(record.item) && typeof content?.text === "string") {
        out.get(record.item).content = content.text;
      } else if (x.kind === "delete") out.delete(record.about);
    }
    return [...out.values()].reverse().map(({ earlier, edited_at: at, ...c }) => ({ ...c, ...editedFields({ edited_at: at, earlier }) }));
  }

  /** The owner's signed comments on friends' posts (sent), with their words now: edits applied, deleted ones left out. */
  function sentComments() {
    const out = new Map();
    for (const x of [...t.sent].sort((a, b) => a.created_at - b.created_at)) {
      const sent = JSON.parse(x.record);
      const record = fromB64json(sent.record);
      const content = sent.content ? fromB64json(sent.content) : null;
      const host = [...byIdentity.values()].find((c) => c.identity === x.host);
      if (!record || !host) continue;
      if (x.kind === "comment") {
        out.set(x.fp, { type: "Note", id: `${postId(host.origin, x.item)}#${x.fp}`, attributedTo: actorId(site), inReplyTo: postId(host.origin, x.item),
          published: iso(x.created_at), mediaType: "text/plain", content: content?.text ?? "", "afterwrd:signed": true, earlier: [], edited_at: null });
      } else if (x.kind === "edit" && out.has(record.about)) {
        const c = out.get(record.about);
        c.earlier.push({ text: c.content, replaced_at: x.created_at });
        c.content = content?.text ?? c.content;
        c.edited_at = x.created_at;
      } else if (x.kind === "delete") out.delete(record.about);
    }
    return [...out.values()].map(({ earlier, edited_at: at, ...c }) => ({ ...c, ...editedFields({ edited_at: at, earlier }) }));
  }
}

const README = (host, when, withMedia) => `afterwrd download of ${host}, made ${when}

Everything on the site, as ActivityStreams 2.0 JSON (https://www.w3.org/TR/activitystreams-core/), the format the
fediverse uses. afterwrd's own extra terms start "afterwrd:" (https://afterwrd.app/ns#).

  profile.json               who the site belongs to
  posts.json                 posts, from Facebook and written on afterwrd, each with the comments made on the site
  photos.json                every photo and video, with comments made on the site
  albums.json                albums, listing their photos by address
  comments-elsewhere.json    comments you've written on friends' afterwrd sites (the originals live there)
  signed.json                what proves your posts and comments are as you wrote them: your identity (keys only), every
                             signed list your site keeps (each comment, edit and delete exactly as its writer signed it),
                             and what you've signed and sent to friends' posts, with their sites' receipts
  connections.json           friends' afterwrd sites you're connected with
  groups.json                the groups you're in (each is its own site, which keeps everything in it)
  groups-elsewhere.json      what you've posted and said in groups (the originals live on the group's site)
  facebook-comments.json     your comments on Facebook
  facebook-likes.json        your likes and reactions on Facebook
  facebook-tagged.json       photos of you on Facebook (links only: Facebook doesn't include the images)
  facebook-people.json       people named in your Facebook download
${withMedia ? "  media/                     every photo and video, named by its SHA-256 fingerprint\n" : ""}  site/                      the site's own rows, for moving it to another afterwrd site (Import, Bring everything over)

Addresses. Everything has a permanent address on the site it belongs to:
  the site's owner     https://<site>/
  a post               https://<site>/posts/<post key>
  a photo or video     https://<site>/photos/sha256/<fingerprint>   (the file itself: https://<site>/files/<fingerprint>)
  a comment            <the post's or photo's address>#c<number>
  a group              https://<group's site>/groups/1
  a post in a group    https://<group's site>/groups/1/posts/<number>
A comment you wrote on a friend's post has the same address in your download (comments-elsewhere.json) as in
theirs (in the post's "replies"), and its "inReplyTo" is the address of their post. So two friends' downloads
can be matched up, and your conversations put back together, by address alone.

Facebook's own download doesn't say which post a comment or like was on, only whose it was and what kind
("afterwrd:on"), and when. Those keep what Facebook gave.

Photos: "afterwrd:file" is where each one is in media/ here. Text is plain, not HTML ("mediaType": "text/plain").

Edits: a post or comment that was changed after it was written has "updated" (when), and "afterwrd:earlier", what
it said before, oldest first, each with when it was replaced ("afterwrd:replaced").
`;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const withMedia = form.media.checked;
  const host = location.host;
  const date = new Date().toISOString().slice(0, 10);
  const name = `afterwrd-${host.replace(/[^\w.-]/g, "-")}-${date}`;
  error.textContent = "";
  // Ask where to save first, while the click still counts as the person's own.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: `${name}.zip`, types: [{ description: "Zip file", accept: { "application/zip": [".zip"] } }] });
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  button.disabled = true;
  try {
    status.textContent = "Reading the site…";
    const response = await fetch("/_admin/export/about");
    if (!response.ok) throw new Error(`Couldn't read the site (it said ${response.status}).`);
    const about = await response.json();
    const t = {};
    for (const table of TABLES) t[table] = await rows(table);

    zip.configure({ useWebWorkers: false });
    const writer = new zip.ZipWriter(handle ? await handle.createWritable() : new zip.BlobWriter("application/zip"));
    await writer.add(`${name}/README.txt`, new zip.TextReader(README(host, new Date().toLocaleString("en-GB"), withMedia)));
    for (const [file, doc] of Object.entries(documents(t))) {
      await writer.add(`${name}/${file}`, new zip.TextReader(JSON.stringify(tidy(doc), null, 2)));
    }
    await writer.add(`${name}/site/about.json`, new zip.TextReader(JSON.stringify({ ...about, media: withMedia, made: new Date().toISOString() }, null, 2)));
    for (const table of about.tables) {
      const list = t[table] ?? await rows(table);
      await writer.add(`${name}/site/${table}.json`, new zip.TextReader(JSON.stringify(list.map(({ _rowid, ...row }) => row))));
    }
    if (withMedia) {
      const files = unique(t.media);
      for (const [i, m] of files.entries()) {
        status.textContent = `Adding photos and videos: ${i + 1} of ${files.length}…`;
        const response = await fetch(`/files/${m.hash}`);
        if (!response.ok) throw new Error(`Couldn't fetch a photo (the site said ${response.status}).`);
        await writer.add(`${name}/${fileFor(m)}`, new zip.BlobReader(await response.blob()), { level: 0 });
      }
      const thumbs = thumbsOf(t.media);
      for (const [i, hash] of thumbs.entries()) {
        status.textContent = `Adding thumbnails: ${i + 1} of ${thumbs.length}…`;
        const response = await fetch(`/files/${hash}`);
        if (!response.ok) throw new Error(`Couldn't fetch a thumbnail (the site said ${response.status}).`);
        const blob = await response.blob();
        await writer.add(`${name}/site/thumbs/${hash}${EXTENSIONS[blob.type] ?? ""}`, new zip.BlobReader(blob), { level: 0 });
      }
    }
    status.textContent = "Finishing…";
    const result = await writer.close();
    if (!handle) {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(result), download: `${name}.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    status.textContent = "Done. Your download is saved.";
  } catch (err) {
    error.textContent = err.message;
    status.textContent = "";
  } finally {
    button.disabled = false;
  }
});
