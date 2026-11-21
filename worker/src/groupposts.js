// A group's posts as signed items (afterwrd 2, step 6c: docs/signed-conversations.md, "6c in detail"), on the group's
// own site. Each post is an item this site hosts, written and signed by a member, exactly as a friend's post is hosted
// by their own site (items.js, friendhost.js). Members' sites call these with signed calls (groupmembers.js
// signedMember: members who joined with an identity, and are in), keep copies of the newest (groupcopies.js), and read
// a post's whole list from here when it's opened.
//   POST /_p/items           {sent, photos: [sent…], files: [{src, thumbSrc}…], delegation, profile?}: a member's new
//                            post (or event), its photos signed first as items of their own (as on a person's site),
//                            with signed links to the files on the member's site, which this site copies, as before.
//   GET  /_p/items?since=<t> posts changed since `t` (this site's clock), oldest change first, up to 50, with the
//                            group as the member sees it (its name, members and their role)
//   GET  /_p/items?before=<time>   the 20 posts made before `time`, newest first (a group's older pages)
//   GET  /_p/items?id=<id>   one post, as those come
//   GET  /_p/items/<id>      one post's (or photo's) whole list, with the identities, delegations and signed names of
//                            everyone in it, and, for an admin who removed something or called it off, the owner's signed
//                            `role` making them admin (with their `join`), so readers needn't ask for the members list
//   GET  /_p/items/<id>/dates/<date>   one date's list of a repeating event (step 6d: its answers and calling off),
//                            with what /_p/items/<id> sends with it
//   POST /_p/records/check   what became of the member's records here (sentchecks.js answerCheck)
//   POST /_p/records         {sent, delegation, profile?}: the member's own comment, edit, delete, vote, answer, end or
//                            change, or (an admin, or the group's owner) a remove or calloff; an answer or calloff with
//                            `date` goes on that date's list, which starts with it
// A post's list follows lists.js GroupRules: what's removed is removed by the group's admins or owner. Notes go out
// from here (fat notes, through the Outbox, groupNoteFor): a comment to the post's writer, those who've commented and
// those it mentions; a new post that mentions people to them; @here to everyone; an event's change or calling off to
// those going or who might.
import { MAX_COMMENT } from "./archive/comments.js";
import { finishedAt } from "./calendar.js";
import { delegationsFor, itemForFriend, keyOf, peopleFor } from "./friendhost.js";
import { signedLink } from "./friends.js";
import { closedGroup, copyPhotos, GROUP_BYTES, groupGone, groupObject, HERE_LIMITS, isAdmin, MAX_GROUP_PHOTOS, MAX_GROUP_TEXT, PHOTO_BYTES, POST_RATE, theGroup, THUMB_BYTES } from "./groups.js";
import { groupSelf, membersNow, signedMember, theirs } from "./groupmembers.js";
import { DAILY_RECORDS_SAID, listEntries, overDailyRecords, readList, takeRecord, tombstone, tombstoneDates } from "./hosted.js";
import { checkProfile, identityState } from "./identities.js";
import { eventTrouble, pollTrouble } from "./itemkinds.js";
import { dateOver, ID_RE, itemGone, kindPlan, lookupsFor, photosOf, refreshDate, refreshItem, sentRecord } from "./items.js";
import { ownIdentity } from "./keys.js";
import { rateWindow } from "./limits.js";
import { dateList, parseListId, signHead } from "./lists.js";
import { says } from "./mentions.js";
import { answerCheck, mineSince } from "./sentchecks.js";
import { outbox } from "./outbox.js";
import { DATE_RE, parseRecord } from "../public/static/records.js";
import { fingerprintOf, fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";
import { selfHosted } from "./hosting.js";
import { ownUsage } from "./allowances.js";

const SINCE_PAGE = 50;
const BEFORE_PAGE = 20;
const PHOTO_FIELDS = ["hash", "thumb_hash", "width", "height", "size"];
const KINDS = new Set(["comment", "edit", "delete", "vote", "answer", "end", "change", "remove", "calloff"]);

/**
 * This group as host: its identity and hosting key, its members list's id, and its owner (from its identity); null
 * before it has an identity.
 */
async function hostOf(env) {
  const self = await groupSelf(env);
  const own = self && (await ownIdentity(env.DB));
  return self && own?.state.current.owner ? { ...self, owner: String(own.state.current.owner) } : null;
}

/**
 * The group's side of GroupRules (lists.js): its owner, and who's an admin at a point in its members list. Only a
 * remove or a calloff asks, so the members list is read only for those (`admins`).
 */
async function groupRules(env, self, admins) {
  if (!admins) return { owner: self.owner, admin: () => false };
  const roles = await membersNow(env, self);
  return {
    owner: self.owner,
    admin: (person, at) => roles.roleOf(person) === "admin" && Boolean(at) && Number.isSafeInteger(at.n) && roles.heads.get(at.n) === at.h
      && (roles.changedAt.get(person) ?? 0) <= at.n,
  };
}

/** A member's signed name, if they sent one: kept, to name them to others in the group. */
async function keepProfile(env, person, profile) {
  if (!profile) return;
  const state = await identityState(env, person);
  if (state && (await checkProfile(profile, state))) {
    await env.DB.prepare("UPDATE identities SET profile = ? WHERE person = ?").bind(JSON.stringify(profile), person).run();
  }
}

export async function handleGroupItems(request, env, url) {
  if (await groupGone(env)) return json({ error: "This group has closed." }, 410);
  const member = await signedMember(request, env, url);
  const group = member && (await theGroup(env.DB));
  if (!member || !group) return json({ error: "Not a member of this group." }, 401);
  if (!member.approved_at) {
    const owner = await env.DB.prepare("SELECT name FROM group_members WHERE role = 'owner' LIMIT 1").first();
    return json({ error: `Waiting for ${owner?.name ?? "the group"} to let you in.` }, 403);
  }
  const self = await hostOf(env);
  if (!self) return json({ error: "This group isn't ready yet." }, 409);
  const db = env.DB;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;
  // Closed (step 6e: groups.js): read-only for its last 30 days, but for members deleting what they wrote.
  const shut = Boolean(closedGroup(group));
  if (request.method === "POST" && url.pathname === "/_p/items") return shut ? json({ error: "This group has closed." }, 409) : newPost(env, url, self, group, member, body);
  if (request.method === "POST" && url.pathname === "/_p/records") return memberRecord(env, url, self, member, body, { shut });
  // What became of the member's records here (sentchecks.js): while closing, too.
  if (request.method === "POST" && url.pathname === "/_p/records/check") {
    const answer = await answerCheck(env, String(member.identity), body, { host: self.person });
    return json(answer, answer.status ?? 200);
  }
  if (request.method === "GET" && url.pathname === "/_p/items") {
    const before = Number(url.searchParams.get("before") ?? 0) || 0;
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    // ?id=: one post, as the others come (a member opening one older than their site keeps).
    const only = ID_RE.test(url.searchParams.get("id") ?? "") ? url.searchParams.get("id") : null;
    const { results } = only
      ? await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
        WHERE i.type = 'post' AND i.id = ?`).bind(only).all()
      : before
      ? await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
        WHERE i.type = 'post' AND i.created_at < ? ORDER BY i.created_at DESC LIMIT ?`).bind(before, BEFORE_PAGE + 1).all()
      : await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
        WHERE i.type = 'post' AND i.changed_at > ? ORDER BY i.changed_at LIMIT ?`).bind(since, SINCE_PAGE + 1).all();
    const size = before ? BEFORE_PAGE : SINCE_PAGE;
    const more = results.length > size;
    const rows = results.slice(0, size);
    // Photo links for this member (share.js), as a friend's site gives a friend's; and, since this site isn't the
    // writer's, the signed records that make each post what it is now (memberItem).
    const items = await Promise.all(rows.map((r) => memberItem(env, url.origin, r, member)));
    const acting = [...new Set(items.flatMap((i) => i.records.map((x) => parseRecord(fromB64url(x.sent.record))))
      .filter((r) => r?.kind === "calloff" && r.author !== self.owner).map((r) => r.author))];
    const roles = acting.length ? await roleProofs(env, self, acting) : {};
    const gone = before || only ? [] : (await db.prepare("SELECT id FROM lists WHERE deleted_at > ? AND instr(id, '/') = 0").bind(since).all()).results.map((g) => String(g.id));
    // As friendhost.js: never up to this very second, so a change later this second isn't missed.
    const until = before || only ? null : more ? Number(rows.at(-1).changed_at) : Math.min(Number(rows.at(-1)?.changed_at ?? since), Math.max(since, now() - 1));
    const keys = [...items.flatMap((i) => [i.sent, ...i.records.map((x) => x.sent)]), ...Object.values(roles).flatMap((p) => [p.join, p.role])].map(keyOf);
    const authors = items.flatMap((i) => [i.sent, ...i.records.map((x) => x.sent)]).map((x) => parseRecord(fromB64url(x.record))?.author).filter(Boolean);
    return json({ v: 2, items, gone, until, more, roles, context: await groupObject(db, url.origin, group, member),
      delegations: await delegationsFor(db, keys), people: await peopleFor(db, [...new Set([...authors, self.owner])]),
      ...(!before && !only && { mine: await mineSince(db, String(member.identity), since) }),
      // To its owner, on Cloudflare: how busy this group's site has been this week, for their busy-account warning
      // (allowances.js), since it shares their account.
      ...(!before && !only && member.role === "owner" && !selfHosted(env) && { usage: await ownUsage(db) }) });
  }
  const one = /^\/_p\/items\/([A-Za-z0-9_-]{43})(?:\/dates\/(\d{4}-\d{2}-\d{2}))?$/.exec(url.pathname);
  if (request.method === "GET" && one) {
    // One date of a repeating event (step 6d): its own list, there once someone's answered (or called it off).
    if (one[2] && !DATE_RE.test(one[2])) return json({ error: "Not found." }, 404);
    if (one[2] && !(await db.prepare("SELECT 1 FROM lists WHERE id = ?").bind(dateList(one[1], one[2])).first())) {
      const event = await db.prepare("SELECT 1 FROM lists WHERE id = ? AND deleted_at IS NULL").bind(one[1]).first();
      return event ? json({ v: 2, empty: true }) : json({ error: "Not found." }, 404);
    }
    const list = await readList(db, one[2] ? dateList(one[1], one[2]) : one[1], { host: self });
    if (!list || list.owner === self.person) return json({ error: "Not found." }, 404); // not the members list: that's /_group/members
    if (list.deleted) return json({ error: "Deleted.", deleted: true }, 410);
    const records = list.entries.filter((e) => e.sent).map((e) => parseRecord(fromB64url(e.sent.record))).filter(Boolean);
    const acting = [...new Set(records.filter((r) => (r.kind === "remove" || r.kind === "calloff") && r.author !== self.owner && r.author !== self.person)
      .map((r) => r.author))];
    const roles = acting.length ? await roleProofs(env, self, acting) : {};
    const roleKeys = Object.values(roles).flatMap((p) => [p.join, p.role]).map((s) => keyOf(s));
    return json({ v: 2, owner: list.owner, entries: list.entries, signedHead: list.signedHead, checkpoint: list.checkpoint ?? null, roles,
      delegations: await delegationsFor(db, [...records.map((r) => r.key), ...roleKeys]),
      people: await peopleFor(db, [...new Set([...records.map((r) => r.author), self.owner])]) });
  }
  return json({ error: "Not found." }, 404);
}

/**
 * A post (an `items` row joined with its list's n and head) as `member` is sent it: as a friend's site sends one
 * (friendhost.js itemForFriend, with photo links for them), plus the signed records that make it what it is now (its
 * writer's edits and changes, and an admin calling it off), each with when it was taken, so a member's site works its
 * words and details out from what's signed, not from this site's say-so (friendcopies.js keepCopy).
 */
async function memberItem(env, origin, row, member) {
  const item = await itemForFriend(env, origin, row, Number(member.id));
  const records = [];
  for (const e of (await listEntries(env.DB, String(row.id))).slice(1)) {
    const r = e.sent && parseRecord(fromB64url(e.sent.record));
    if (!r) continue;
    const own = r.author === String(row.author) && ((r.kind === "edit" && r.about === String(row.id)) || r.kind === "change");
    if (own || r.kind === "calloff") records.push({ n: e.n, fp: e.fp, taken: e.taken, sent: e.sent });
  }
  // A repeating event's dates called off, each from its own list (step 6d), so members see which are off by signature.
  const tally = row.tally ? JSON.parse(String(row.tally)) : null;
  for (const [date, d] of Object.entries(tally?.dates ?? {})) {
    if (!d?.off) continue;
    const e = (await listEntries(env.DB, dateList(String(row.id), date))).find((x) => x.sent && parseRecord(fromB64url(x.sent.record))?.kind === "calloff");
    if (e) records.push({ n: e.n, fp: e.fp, taken: e.taken, date, sent: e.sent });
  }
  return { ...item, records };
}

/**
 * For each of `people` (admins who removed something or called it off), what shows they're an admin: the owner's
 * newest signed `role` record making them one, and the `join` it's about, both as the members list holds them.
 */
async function roleProofs(env, self, people) {
  const wanted = new Set(people);
  const joins = new Map();
  const out = {};
  for (const e of await listEntries(env.DB, self.list)) {
    const record = e.sent && parseRecord(fromB64url(e.sent.record));
    if (!record) continue;
    if (record.kind === "join" && wanted.has(record.author)) joins.set(e.fp, { person: record.author, sent: e.sent });
    if (record.kind === "role" && record.author === self.owner && joins.has(record.about)) {
      const j = joins.get(record.about);
      out[j.person] = { join: j.sent, role: e.sent };
    }
  }
  return out;
}

/**
 * What's wrong with who a member's record mentions (`got`: {record, content}), or null: only members, as its words say,
 * and @here (content `here`) only if they may use it.
 */
async function wrongMentions(env, got, text) {
  const listed = got.record.mentions ?? [];
  const shown = Array.isArray(got.content?.mentions) ? got.content.mentions : [];
  if (got.content?.here !== undefined && (got.content.here !== true || !says(text, "here"))) return "That says @here when its words don't.";
  if (!listed.length && !shown.length) return null;
  if (shown.length > listed.length || shown.some((m) => !listed.includes(m?.person) || typeof m.name !== "string" || !says(text, m.name))) {
    return "That mentions someone its words don't.";
  }
  const { results } = await env.DB.prepare(`SELECT identity FROM group_members WHERE approved_at IS NOT NULL
    AND identity IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(listed)).all();
  const members = new Set(results.map((r) => String(r.identity)));
  const own = await hostOf(env);
  if (own) members.add(own.owner);
  members.delete(got.record.author);
  return listed.every((p) => members.has(p)) ? null : "You can only mention people in this group.";
}

/**
 * @here on a new post (mentions.js, as before): its owner and admins may use it, or anyone if they've said so; within
 * the day's allowance for each member and the group, taken there and then. Returns {release} or {error, status}.
 */
async function takeHere(env, group, member) {
  const db = env.DB;
  if (!isAdmin(member) && !group.here_anyone) return { error: "Only the group's admins can use @here.", status: 403 };
  const at = now();
  const taken = await db.prepare(`INSERT INTO here_log (member_id, at) SELECT ?1, ?2
    WHERE (SELECT COUNT(*) FROM here_log WHERE member_id = ?1 AND at > ?2 - 86400) < ?3
      AND (?5 OR (SELECT COUNT(*) FROM here_log WHERE at > ?2 - 86400) < ?4)
    RETURNING rowid`).bind(member.id, at, HERE_LIMITS.member, HERE_LIMITS.group, isAdmin(member) ? 1 : 0).first();
  if (!taken) return { error: "@here has been used a lot today. Mention people by name instead.", status: 429 };
  await db.prepare("DELETE FROM here_log WHERE at < ?").bind(at - 2 * 86400).run();
  return { release: async () => { await db.prepare("DELETE FROM here_log WHERE rowid = ?").bind(taken.rowid).run(); } };
}

/** A new post's words and what it is, checked: a message saying what's wrong, or null. */
function postTrouble(self, member, post, photos, files) {
  const type = post?.content?.type;
  if (!post?.record || post.record.kind !== "item" || post.record.host !== self.person || post.record.author !== member.identity
    || post.record.audience || (type !== "post" && type !== "event")) return "That isn't a post for this group.";
  const text = typeof post.content.text === "string" ? post.content.text : "";
  if (text !== text.replace(/\r\n?/g, "\n").trim()) return "That post's words aren't as written.";
  if (text.length > MAX_GROUP_TEXT) return `Posts can be up to ${MAX_GROUP_TEXT} characters.`;
  const listed = Array.isArray(post.content.photos) ? post.content.photos : [];
  if (type === "event") {
    if (listed.length || post.content.poll !== undefined) return "An event can't have photos or a poll.";
    const wrong = eventTrouble(post.content.event, now(), { repeats: true });
    if (wrong) return wrong;
  } else {
    const wrong = pollTrouble(post.content.poll, now());
    if (wrong) return wrong;
    if (!text && !listed.length && !post.content.poll) return "Write something or add a photo.";
    if (post.content.poll && !text) return "Write the question your poll asks.";
  }
  if (listed.length > MAX_GROUP_PHOTOS) return `Up to ${MAX_GROUP_PHOTOS} photos in a group post.`;
  if (listed.length !== photos.length || files.length !== photos.length) return "That post's photos aren't all here.";
  return null;
}

/** A member's new post (POST /_p/items). */
async function newPost(env, url, self, group, member, body) {
  const db = env.DB;
  const mine = await theirs(env, String(member.identity), { sent: body?.sent, delegation: body?.delegation });
  if (mine.error) return json({ error: mine.error }, 400);
  const post = sentRecord(body.sent);
  const photosSent = Array.isArray(body.photos) ? body.photos.slice(0, MAX_GROUP_PHOTOS + 1) : [];
  const photos = photosSent.map(sentRecord);
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_GROUP_PHOTOS + 1) : [];
  const trouble = postTrouble(self, member, post, photos, files);
  if (trouble) return json({ error: trouble }, 400);
  const text = String(post.content.text ?? "");
  const listed = Array.isArray(post.content.photos) ? post.content.photos : [];
  // Each photo: the member's own item, as listed, and a signed link to its file (and thumbnail) on their own site.
  const copies = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p?.record || p.record.kind !== "item" || p.record.author !== member.identity || p.record.host !== self.person || p.content?.type !== "photo") {
      return json({ error: "That isn't a photo of yours." }, 400);
    }
    if (listed[i]?.item !== (await fingerprintOf("record", p.bytes)) || PHOTO_FIELDS.some((f) => listed[i][f] !== p.content[f])) {
      return json({ error: "That post's photos aren't the ones sent." }, 400);
    }
    const { hash, thumb_hash, size, width, height } = p.content;
    const side = (n) => Number.isSafeInteger(n) && n > 0 && n <= 20_000;
    const src = /^[0-9a-f]{64}$/.test(hash ?? "") && signedLink(String(member.origin), files[i]?.src, hash);
    const thumbSrc = /^[0-9a-f]{64}$/.test(thumb_hash ?? "") && signedLink(String(member.origin), files[i]?.thumbSrc, thumb_hash);
    if (!src || !thumbSrc || !side(width) || !side(height) || !Number.isSafeInteger(size) || size <= 0) return json({ error: "Unexpected photo details." }, 400);
    if (size > PHOTO_BYTES) return json({ error: "That photo is too big for a group." }, 400);
    copies.push({ hash, thumb_hash, src, thumbSrc, size });
  }
  const wrong = await wrongMentions(env, post, text);
  if (wrong) return json({ error: wrong }, 400);
  // The member's limits (posts, photos a day), and the group's room for photos.
  const at = now();
  const [recent, daily, photosToday, bytes] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM items WHERE author = ? AND type = 'post' AND created_at > ?").bind(member.identity, at - rateWindow(POST_RATE.seconds)),
    db.prepare("SELECT COUNT(*) AS n FROM items WHERE author = ? AND type = 'post' AND created_at > ?").bind(member.identity, at - 86400),
    db.prepare("SELECT COUNT(*) AS n FROM items WHERE author = ? AND type = 'photo' AND created_at > ?").bind(member.identity, at - 86400),
    db.prepare("SELECT (SELECT COALESCE(SUM(size), 0) FROM media WHERE item_id IS NOT NULL) + (SELECT COALESCE(SUM(size), 0) FROM group_photos) AS n"),
  ]);
  const n = (r) => Number(r.results[0]?.n ?? 0);
  const adding = copies.reduce((sum, f) => sum + f.size + THUMB_BYTES, 0);
  if (n(recent) >= POST_RATE.count || n(daily) >= POST_RATE.daily || n(photosToday) + copies.length > POST_RATE.photos || n(bytes) + adding > GROUP_BYTES) {
    return json({ error: "That's a lot of posts or photos for now, or the group is full of photos. Try again later." }, 429);
  }
  // A post is a record too (and each photo with it): within the member's records a day (hosted.js).
  if (await overDailyRecords(db, String(member.identity), "item", self.list)) return json({ error: DAILY_RECORDS_SAID }, 429);
  let release = async () => {};
  if (post.content.here === true) {
    const here = await takeHere(env, group, member);
    if (here.error) return json({ error: here.error }, here.status);
    release = here.release;
  }
  await keepProfile(env, String(member.identity), body.profile);
  const lookups = lookupsFor(env);
  const rules = await groupRules(env, self, false);
  const taken = [];
  const undo = async () => {
    for (const t of taken) { await tombstone(db, t.id); await itemGone(env, t.id); }
    await release();
  };
  for (let i = 0; i < photos.length; i++) {
    const answer = await takeRecord(db, { sent: photosSent[i], host: self, lookups, group: rules });
    if (answer.refused) { await undo(); return json({ error: answer.refused }, 400); }
    taken.push({ id: answer.entry.fp, at: answer.entry.taken, content: photos[i].content });
  }
  const answer = await takeRecord(db, { sent: body.sent, host: self, lookups, group: rules });
  if (answer.refused) { await undo(); return json({ error: answer.refused }, 400); }
  const id = answer.entry.fp;
  const event = post.content.type === "event";
  // The post's row, its photos' rows and files' rows, referenced before the files arrive, so none is cleared away
  // meanwhile; if anything goes wrong, the post and its photos go again.
  taken.push({ id });
  try {
    await db.batch([
      db.prepare(`INSERT INTO items (id, author, type, content, created_at, changed_at, author_last, audience, version, tally)
        VALUES (?, ?, 'post', ?, ?, ?, ?, 'group', ?, ?)`).bind(id, member.identity, JSON.stringify(post.content), answer.entry.taken, answer.entry.taken, id, id,
        post.content.poll ? JSON.stringify({ votes: {}, ended_at: null }) : event ? JSON.stringify({ answers: {} }) : null),
      ...taken.slice(0, -1).flatMap((t, i) => [
        db.prepare("INSERT INTO items (id, author, type, content, created_at, changed_at, author_last, audience) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'group')")
          .bind(t.id, member.identity, JSON.stringify(t.content), t.at, t.at, t.id),
        db.prepare("INSERT INTO item_photos (photo, post, position) VALUES (?, ?, ?)").bind(t.id, id, i),
        db.prepare(`INSERT INTO media (source, path, kind, created_at, width, height, hash, thumb_hash, size, type, item_id)
          VALUES ('afterwrd', ?, 'photo', ?, ?, ?, ?, ?, ?, 'image/jpeg', ?)`)
          .bind(`group/${t.content.hash}.jpg`, t.at, t.content.width, t.content.height, t.content.hash, t.content.thumb_hash, t.content.size + THUMB_BYTES, t.id),
      ]),
    ]);
    await copyPhotos(env, copies);
  } catch (error) {
    await undo();
    return json({ error: error.message }, 400);
  }
  // Those it mentions are told; @here tells everyone.
  if (post.content.here === true) await outbox(env).sendNote({ origin: url.origin, kind: "here", item: id, audience: "members" });
  else await queueToPeople(env, url.origin, { kind: "item", item: id, people: post.record.mentions ?? [], except: String(member.identity) });
  return json({ ok: true, id, receipt: answer.receipt });
}

/** A member's record on a post here (POST /_p/records). Once the group's closed (`shut`), only their own deletes. */
async function memberRecord(env, url, self, member, body, { shut = false } = {}) {
  const db = env.DB;
  const mine = await theirs(env, String(member.identity), { sent: body?.sent, delegation: body?.delegation });
  if (mine.error) return json({ error: mine.error }, 400);
  const got = sentRecord(body.sent);
  const { record, content } = got;
  const id = String(record.item ?? "");
  if (!KINDS.has(record.kind) || !ID_RE.test(id) || record.host !== self.person) return json({ error: "That didn't work." }, 400);
  if (shut && record.kind !== "delete") return json({ error: "This group has closed." }, 409);
  // At most so many a day from one member, across all the group's posts (hosted.js); never an admin's clear-up.
  if (await overDailyRecords(db, String(member.identity), String(record.kind), self.list)) return json({ error: DAILY_RECORDS_SAID }, 429);
  const item = await db.prepare("SELECT id, author, type, content, version, tally, audience FROM items WHERE id = ?").bind(id).first();
  if (!item) return json({ error: "That post isn't here any more." }, 404);
  const now_ = JSON.parse(String(item.content));
  if (content !== undefined) {
    const text = typeof content?.text === "string" ? content.text : "";
    if (record.kind === "comment" && (!text.trim() || text.length > MAX_COMMENT)) return json({ error: `Comments need 1 to ${MAX_COMMENT} characters.` }, 400);
    if (record.kind === "edit" && text.length > (record.about === id ? MAX_GROUP_TEXT : MAX_COMMENT)) return json({ error: "That's too long." }, 400);
    if (record.kind === "edit" && record.about === id && !text.trim() && now_.type !== "event" && (now_.poll || !now_.photos?.length)) {
      return json({ error: now_.poll ? "A poll needs its question." : "A post with no photos needs words." }, 400);
    }
    if (record.kind === "comment" || record.kind === "edit") {
      const wrong = await wrongMentions(env, got, text);
      if (wrong) return json({ error: wrong }, 400);
    }
  }
  if (record.kind === "edit" && record.about === id && now_.type === "event") return json({ error: "An event's words change with the event: use Change it." }, 400);
  if (record.kind === "calloff" && now_.type !== "event") return json({ error: "That isn't an event." }, 400);
  // A photo goes with its post: taking one out on its own would leave the post listing a photo that isn't there.
  if ((record.kind === "delete" || record.kind === "remove") && record.about === id && item.type === "photo") {
    return json({ error: "A photo goes with its post: delete or remove the whole post instead." }, 400);
  }
  if (record.date && item.type !== "post") return json({ error: "That isn't an event." }, 400);
  const plan = await kindPlan(env, item, now_, got, { guestIds: null, salt: null, isGuest: async () => true });
  if (plan.refused) return json({ error: plan.refused }, 409);
  await keepProfile(env, String(member.identity), body.profile);
  const rules = await groupRules(env, self, record.kind === "remove" || record.kind === "calloff");
  // One date of a repeating event (step 6d): its own list, started by the first answer to it, the event's writer's.
  const answer = await takeRecord(db, { sent: body.sent, host: self, lookups: lookupsFor(env), group: rules, owner: String(item.author) });
  if (answer.refused) {
    const said = { "Someone has replied since.": "Someone has replied since, so it can't be changed now.", "That's out of order.": "Something changed meanwhile. Try again." };
    return json({ error: said[answer.refused] ?? answer.refused }, 409);
  }
  if (answer.deleted) {
    // An event still to come: those going, or who might, are told it's off.
    if (now_.type === "event" && !now_.event?.cancelled && finishedAt(now_.event) > now()) {
      await queueToPeople(env, url.origin, { kind: "gone-off", item: id, people: answering(item.tally, now_.event), except: String(member.identity) });
    }
    // A repeating one's dates go with it.
    if (now_.event?.rrule) await tombstoneDates(db, id);
    // A post's photos go with it.
    for (const photo of await photosOf(db, id)) {
      await tombstone(db, photo);
      await itemGone(env, photo);
    }
    await itemGone(env, id);
    return json({ ok: true, deleted: true, n: answer.entry?.n ?? null });
  }
  if (record.date) {
    await refreshDate(db, id, record.date);
    // One date called off: those going that day, or who might, are told.
    if (record.kind === "calloff") {
      await queueToPeople(env, url.origin, { kind: "calloff", item: dateList(id, record.date), fp: answer.entry.fp,
        people: answering(item.tally, now_.event, record.date), except: String(member.identity) });
    }
    return json({ ok: true, receipt: answer.receipt ?? null, n: answer.entry?.n ?? null });
  }
  await refreshItem(db, id);
  if (record.kind === "comment") await queueComment(env, url.origin, id, item, record, answer.entry.fp);
  if ((record.kind === "change" && (plan.moved || plan.cancelled)) || record.kind === "calloff") {
    await queueToPeople(env, url.origin, { kind: record.kind, item: id, fp: answer.entry.fp, people: answering(item.tally, now_.event), except: String(member.identity) });
  }
  return json({ ok: true, receipt: answer.receipt ?? null, n: answer.entry?.n ?? null });
}

/**
 * Those going to an event, or who might (from its tally as stored). For a repeating one (step 6d), to `date`, or (with
 * none) to any of its dates still to come.
 */
function answering(tally, event = null, date = null) {
  const t = JSON.parse(String(tally ?? "{}")) ?? {};
  const coming = (answers) => Object.entries(answers ?? {}).filter(([, a]) => a?.answer === "going" || a?.answer === "maybe").map(([p]) => p);
  if (!event?.rrule) return coming(t.answers);
  const at = now();
  const dates = Object.entries(t.dates ?? {}).filter(([d, x]) => (date ? d === date : !x?.off && dateOver(event, d) > at));
  return [...new Set(dates.flatMap(([, x]) => coming(x?.answers)))];
}

/** Queues a note to members by who they are (`people`, person ids), apart from `except`. */
async function queueToPeople(env, origin, { kind, item, fp = null, people, except }) {
  const wanted = [...new Set(people)].filter((p) => p !== except);
  if (!wanted.length) return;
  const { results } = await env.DB.prepare(`SELECT id FROM group_members WHERE approved_at IS NOT NULL AND identity IN (SELECT value FROM json_each(?))
    ORDER BY id`).bind(JSON.stringify(wanted)).all();
  if (results.length) await outbox(env).sendNote({ origin, kind, item, fp, recipients: results.map((r) => Number(r.id)) });
}

/**
 * A comment on a post (or a photo in one): its writer, those who've commented there, and those it mentions are told,
 * apart from whoever wrote it.
 */
async function queueComment(env, origin, id, item, record, fp) {
  const people = new Set(record.mentions ?? []);
  // The post's writer: a photo's is the post's.
  people.add(String(item.author));
  for (const e of await listEntries(env.DB, id)) {
    const r = e.sent && parseRecord(fromB64url(e.sent.record));
    if (r?.kind === "comment") people.add(r.author);
  }
  await queueToPeople(env, origin, { kind: "comment", item: id, fp, people: [...people], except: record.author });
}

/**
 * Names for `people` as this group's members list has them (the name each signed into their join, or the owner's), for
 * members' sites that have no signed name or friend's name for someone (groupcopies.js).
 */
async function memberNames(env, people) {
  const { results } = await env.DB.prepare(`SELECT identity, name FROM group_members WHERE approved_at IS NOT NULL
    AND identity IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(people)).all();
  const own = await env.DB.prepare("SELECT name FROM group_members WHERE role = 'owner' LIMIT 1").first();
  const self = await hostOf(env);
  const out = Object.fromEntries(results.map((r) => [String(r.identity), String(r.name)]));
  if (self && own && people.includes(self.owner)) out[self.owner] = String(own.name);
  return out;
}

/**
 * A note (an Outbox row: {kind, item, fp}) as member `member` is sent it, or null if what it's about has gone meanwhile.
 * "item" and "here": a new post (with this member's photo links); "comment", "change", "calloff": a record on one, with
 * its place in the list and the group's receipt; "gone", "gone-off": a post deleted or removed.
 */
export async function groupNoteFor(env, note, member) {
  const db = env.DB;
  if (note.kind === "gone" || note.kind === "gone-off") return { v: 2, kind: "gone", item: note.item, cancelled: note.kind === "gone-off" };
  // The owner closed the group (step 6e): their `close` on the members list, with the group's receipt for it.
  if (note.kind === "closed") {
    const self = await groupSelf(env);
    const entries = self ? await listEntries(db, self.list) : [];
    const at = entries.findIndex((e) => e.fp === note.fp);
    const entry = entries[at];
    if (!entry?.sent) return null;
    const record = parseRecord(fromB64url(entry.sent.record));
    return { v: 2, kind: "closed", item: self.list,
      entry: { n: entry.n, fp: entry.fp, taken: entry.taken, prev: at > 0 ? entries[at - 1].head : "", sent: entry.sent },
      receipt: await signHead(self.privateKey, { host: self.person, list: self.list, n: entry.n, head: entry.head }),
      delegations: await delegationsFor(db, [record.key]), people: await peopleFor(db, [record.author]) };
  }
  if (note.kind === "item" || note.kind === "here") {
    const row = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
      WHERE i.id = ? AND i.type = 'post' AND l.deleted_at IS NULL`).bind(note.item).first();
    if (!row) return null;
    const item = await memberItem(env, String(note.origin), row, member);
    return { v: 2, kind: "item", item, here: note.kind === "here", delegations: await delegationsFor(db, [keyOf(item.sent)]),
      people: await peopleFor(db, [String(row.author)]), names: await memberNames(env, [String(row.author)]) };
  }
  const self = await groupSelf(env);
  // The record's list: the post's (or photo's), or one date's of a repeating event (step 6d).
  const where = parseListId(note.item);
  if (!self || !where) return null;
  const entries = await listEntries(db, note.item);
  const at = entries.findIndex((e) => e.fp === note.fp);
  const entry = entries[at];
  if (!entry?.sent) return null; // deleted since
  const record = parseRecord(fromB64url(entry.sent.record));
  const receipt = await signHead(self.privateKey, { host: self.person, list: note.item, n: entry.n, head: entry.head });
  const photo = where.date ? null : await db.prepare("SELECT post, position FROM item_photos WHERE photo = ?").bind(note.item).first();
  return {
    v: 2, kind: note.kind, item: where.item, ...(where.date && { date: where.date }),
    ...(photo && { photo: { post: String(photo.post), index: Number(photo.position) + 1 } }),
    entry: { n: entry.n, fp: entry.fp, taken: entry.taken, prev: at > 0 ? entries[at - 1].head : "", sent: entry.sent },
    receipt, delegations: await delegationsFor(db, [record.key]), people: await peopleFor(db, [record.author]),
    names: await memberNames(env, [record.author]),
  };
}
