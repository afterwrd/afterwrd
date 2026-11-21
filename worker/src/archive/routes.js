// The site's pages for the owner: their posts and photos (made on afterwrd, and from their Facebook download, in the
// same tables, told apart by `source`), Facebook's record of their life there (facebook_*), friends, groups and
// events. Of the Facebook download, only the sections chosen when importing are served.
import { blockedAmong, blockedList } from "../blocks.js";
import { connectionById, friendEvents, friendItem, friendItems, friendThread, noteAnswer, pullFriends, pullItems, pullNew, rememberPicture } from "../friendcopies.js";
import { dateOver, ownHost } from "../items.js";
import * as itemViews from "../views/items.js";
import { workOut } from "../itemkinds.js";
import { loadThread, ownItem, ownItemCount, ownItems, ownItemsWhere, photoItem, thread as itemComments } from "../items.js";
import { postId as postAddress } from "../../public/static/activity.js";
import { eventsFor } from "../events.js";
import { datesOf, FINISHED_SQL, finishedAt, hasDate, icsFile, monthSpan, readDay, readMonth, readWeek, ruleDates, weekSpan } from "../calendar.js";
import { connectedToken } from "../cloudflare.js";
import { findTarget, hasOldThread, latestComments, loadThreads, newCount, photoKey } from "./comments.js";
import { sitePolls } from "../polls.js";
import { postVersions } from "../edits.js";
import * as friend from "../friends.js";
import { MAX_GROUP_PHOTOS, maxMembers } from "../groups.js";
import { whereAmI } from "../groupsites.js";
import * as groups from "../membership.js";
import * as groups_ from "../groupcopies.js";
import { ownerName } from "../sites.js";
import { profilePictures } from "../photos.js";
import { newDevices } from "../admin.js";
import { identitySummary, ownMove } from "../keys.js";
import { recoveredHere } from "../recover.js";
import { newPushDevices, pushKey } from "../push.js";
import { checkRequests, recentChecks } from "../checks.js";
import { securityFixWaiting, waitingRelease } from "../update.js";
import { autoState } from "../auto.js";
import { checkGrant, friendCheckAlerts, lastFailure, lookAfterFacts, lookAfterReminder } from "../friendchecks.js";
import { onCloudflare, selfHosted, serverCommand } from "../hosting.js";
import { now, pageData, withoutKeys } from "../util.js";
import { safeNext } from "../auth.js";
import { fmtDate, fmtMonth } from "../views/format.js";
import { checkSentRound, sentTrouble } from "../sentchecks.js";
import { peopleShown } from "../names.js";
import * as archiveViews from "../views/archive.js";
import * as eventViews from "../views/events.js";
import * as friendViews from "../views/friends.js";
import * as groupViews from "../views/groups.js";
import * as homeViews from "../views/home.js";

// The signed-in pages' views, by area (each file in views/ draws one area).
const views = { ...archiveViews, ...homeViews, ...friendViews, ...groupViews, ...eventViews, ...itemViews };

const PAGE_SIZE = 50;
export const AFTERWRD_KIND = "afterwrd"; // the Posts filter's choice for posts written here
const PHOTO_PAGE_SIZE = 150;

const POST_SQL = `
  SELECT p.*, t.name AS target_name FROM posts p
  LEFT JOIN facebook_people t ON t.id = p.target_id`;
// The owner's comments and likes on Facebook (not comments here, which are archive/comments.js).
const COMMENT_SQL = `
  SELECT c.*, o.name AS owner_name, a.name AS author_name, a.is_me AS author_is_me
  FROM facebook_comments c
  LEFT JOIN facebook_people o ON o.id = c.target_owner_id
  LEFT JOIN facebook_people a ON a.id = c.author_id`;
const REACTION_SQL = `
  SELECT r.*, o.name AS owner_name FROM facebook_reactions r
  LEFT JOIN facebook_people o ON o.id = r.target_owner_id`;
const MEDIA_ORDER = "ORDER BY COALESCE(created_at, 0), id";
const PERSON_TABS = {
  comments: ["Comments", `${COMMENT_SQL} WHERE c.target_owner_id = ? ORDER BY c.created_at DESC`],
  likes: ["Likes", `${REACTION_SQL} WHERE r.target_owner_id = ? ORDER BY r.created_at DESC`],
  wall: ["Wall posts", `${POST_SQL} WHERE p.target_id = ? ORDER BY p.created_at DESC`],
  tags: ["Tagged together", `${POST_SQL} JOIN facebook_post_tags pt ON pt.post_id = p.id WHERE pt.person_id = ? ORDER BY p.created_at DESC`],
  photos: ["Photos of you", "SELECT * FROM facebook_tagged_photos t WHERE t.owner_id = ? ORDER BY t.created_at DESC"],
};

// [pattern, section(s) any of which must be published (null: always), loader, view]. A loader gathers the page's
// data and returns it as plain data (no HTML, and never a key: util.js pageData), or a Response (a redirect, a file),
// or null for 404; the view (views/: archive, home, friends, groups, events) turns the data into the page. A loader that can't reach a friend's or
// group's site throws a Problem, shown by that view instead.
/** @type {Array<[RegExp, string | string[] | null, (ctx: any, params: URLSearchParams, ...match: string[]) => any, ((frame: any, data: any) => any) | null]>} */
const ROUTES = [
  [/^\/$/, null, home, views.homePage],
  [/^\/overview$/, "overview", overview, views.overviewPage],
  [/^\/memories$/, null, memories, views.memoriesPage],
  [/^\/timeline$/, "timeline", timeline, views.timelinePage],
  [/^\/posts$/, "posts", posts, views.postsPage],
  // (Always shown: Posts is always published, for posts written here. So it can start alongside the header.)
  [/^\/posts\/(post-\d+-[0-9a-f]{8})$/, null, post, views.postPage],
  // afterwrd 2: the owner's own signed posts (items.js), by their id.
  [/^\/posts\/([A-Za-z0-9_-]{43})$/, null, itemPost, views.itemPage],
  // …and a friend's, read and checked from their site (friendcopies.js).
  [/^\/friend\/(\d+)\/posts\/([A-Za-z0-9_-]{43})$/, null, friendItemPost, views.friendItemPage],
  [/^\/friend\/(\d+)\/posts\/([A-Za-z0-9_-]{43})\/photos\/(\d{1,2})$/, null, friendItemPhoto, views.friendItemPhotoPage],
  // …and signed events: changing one's own, and adding one to a calendar.
  [/^\/posts\/([A-Za-z0-9_-]{43})\/event$/, null, itemEventEdit, views.itemEventEditPage],
  [/^\/posts\/([A-Za-z0-9_-]{43})\/event\.ics$/, null, itemEventFile, null],
  [/^\/friend\/(\d+)\/posts\/([A-Za-z0-9_-]{43})\/event\.ics$/, null, friendItemEventFile, null],
  [/^\/posts\/(post-\d+-[0-9a-f]{8})\/event\.ics$/, null, ownEventFile, null],
  [/^\/comments$/, "comments", comments, views.commentsPage],
  [/^\/likes$/, "likes", likes, views.likesPage],
  [/^\/photos$/, "photos", photos, views.photosPage],
  [/^\/photos\/tagged$/, "photos", tagged, views.taggedPage],
  [/^\/photos\/album\/([^/]+)$/, "photos", album, views.albumPage],
  [/^\/photos\/(\d+)$/, "photos", photo, views.photoPage],
  [/^\/photos\/sha256\/([0-9a-f]{64})$/, "photos", photoByHash, null],
  [/^\/friends$/, "friends", friends, views.friendsPage],
  [/^\/people\/(\d+)$/, "friends", person, views.personPage],
  [/^\/activity$/, null, activity, views.activityPage],
  [/^\/friend$/, null, friendsIndex, views.friendsIndexPage],
  [/^\/friend\/(\d+)$/, null, friendHome, null],
  [/^\/friend\/(\d+)\/posts$/, null, friendPosts, views.friendPostsPage],
  [/^\/friend\/(\d+)\/posts\/(post-\d+-[0-9a-f]{8})$/, null, friendPost, views.friendPostPage],
  [/^\/friend\/(\d+)\/photos$/, null, friendPhotos, views.friendPhotosPage],
  [/^\/friend\/(\d+)\/photos\/album\/(\d+|other|videos)$/, null, friendAlbum, views.friendAlbumPage],
  [/^\/friend\/(\d+)\/photos\/([0-9a-f]{64})$/, null, friendPhoto, views.friendPhotoPage],
  [/^\/app$/, null, () => ({}), views.appPage], // Add to home screen
  [/^\/groups$/, null, groupsIndex, views.groupsIndexPage],
  [/^\/events$/, null, eventsIndex, views.eventsPage],
  [/^\/groups\/new$/, null, groupNew, views.groupNewPage],
  [/^\/groups\/join$/, null, groupJoin, views.groupJoinPage],
  [/^\/groups\/(\d{1,15})$/, null, groupHome, views.groupPage],
  // A group's posts (groupcopies.js), by their id.
  [/^\/groups\/(\d{1,15})\/posts\/([A-Za-z0-9_-]{43})$/, null, (ctx, params, id, item) => groupItemPost(ctx, params, id, item), views.groupItemPage],
  [/^\/groups\/(\d{1,15})\/posts\/([A-Za-z0-9_-]{43})\/photos\/(\d{1,2})$/, null, groupItemPost, views.groupItemPhotoPage],
  [/^\/groups\/(\d{1,15})\/posts\/([A-Za-z0-9_-]{43})\/edit$/, null, groupItemEventEdit, views.groupItemEventEditPage],
  [/^\/groups\/(\d{1,15})\/posts\/([A-Za-z0-9_-]{43})\/event\.ics$/, null, groupItemEventFile, null],
  [/^\/groups\/(\d{1,15})\/members$/, null, groupMembers, views.groupMembersPage],
  [/^\/groups\/(\d{1,15})\/calendar$/, null, groupCalendar, views.groupCalendarPage],
];

/** A friend's or group's site couldn't give a page what it needed: `view` shows `data` instead. */
class Problem extends Error {
  constructor(view, data) {
    super(data.message);
    this.view = view;
    this.data = data;
  }
}

export async function renderArchive(request, env, url, user, work) {
  const db = env.DB;
  const ctx = {
    env, db, url, user, work,
    zone: request.cf?.timezone ?? "Europe/London", // where the reader is, as near as Cloudflare can tell
    connected: Boolean(connectedToken(request)), // an hour's Cloudflare token from Connect (cloudflare.js), for groups
  };
  const framing = db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'sections'"),
    db.prepare(`SELECT p.*, pm.hash AS profile_hash, cm.hash AS cover_hash FROM facebook_people p
      LEFT JOIN media pm ON pm.id = p.profile_media_id
      LEFT JOIN media cm ON cm.id = p.cover_media_id
      WHERE p.is_me = 1`),
  ]);
  // `chosen` is what the owner published from Facebook: until it's known, a loader waits for it (await ctx.chosen).
  ctx.chosen = framing.then(([settings]) => settings.results[0] ? JSON.parse(settings.results[0].value) : []);
  ctx.chosen.catch(() => {}); // a failure comes through `framing` below
  // A page shown whatever's published needs nothing else the header looks up, so its own lookups start now,
  // alongside the header's, instead of after them: on Cloudflare each wait for the database costs 10–15 ms.
  const route = ROUTES.find(([pattern]) => pattern.test(url.pathname));
  const early = route && (!route[1] || [route[1]].flat().some((s) => ALWAYS_SHOWN.includes(s))) ? loaded(route, ctx) : null;
  // The header's own lookups, all at once (each would otherwise wait for the one before).
  const [[settings, me], [newComments, requests, newRelease, name, profile, faces]] = await Promise.all([
    framing,
    Promise.all([
      newCount(db, user),
      first(db, "SELECT COUNT(*) AS n FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL"),
      waitingRelease(env, work),
      ownerName(db),
      profilePictures(db),
      friendFaces(db),
    ]),
  ]);
  const chosen = settings.results[0] ? JSON.parse(settings.results[0].value) : [];
  const sections = [...new Set([...chosen, ...ALWAYS_SHOWN])];
  Object.assign(ctx, {
    chosen, sections, newComments,
    requests: requests.n,
    newRelease, // the newer afterwrd that's out, if any
    me: me.results[0] ?? { id: -1, name, is_me: 1 },
    ownerName: name, // their name here, which can differ from the Facebook one (me.name)
    profile,
    friendFaces: faces.faces,
    people: faces.people, // friends to mention (ui/mentions.js)
  });
  ctx.updateWaiting = Boolean(ctx.newRelease);
  // A profile picture or cover chosen here takes over from Facebook's.
  if (ctx.profile.profile) Object.assign(ctx.me, { profile_hash: ctx.profile.profile.hash, profile_media_id: ctx.profile.profile.id });
  if (ctx.profile.cover) Object.assign(ctx.me, { cover_hash: ctx.profile.cover.hash, cover_media_id: ctx.profile.cover.id });

  for (const r of ROUTES) {
    const [pattern, section, , view] = r;
    if (!pattern.test(url.pathname) || (section && ![section].flat().some((s) => sections.includes(s)))) continue;
    const outcome = await (r === route && early ? early : loaded(r, ctx));
    if (outcome.error && !(outcome.error instanceof Problem)) throw outcome.error;
    const [show, data] = outcome.error ? [outcome.error.view, outcome.error.data] : [view, outcome.data];
    // The Notifications page has been seen: nothing new on its menu item now.
    if (ctx.activitySeen) ctx.newComments = 0;
    if (data instanceof Response) return data;
    if (!data) break;
    const shown = pageData(env, data);
    try {
      return page(show(frame(ctx), shown));
    } catch (error) {
      // Something from a friend's or group's site that its page couldn't show: said on the page, as it always was.
      if (show !== view || !(data.friend || data.membership)) throw error;
      return page(data.friend ? views.friendProblem(frame(ctx), { friend: data.friend, message: error.message })
        : views.groupProblem(frame(ctx), { membership: data.membership, message: error.message }));
    }
  }
  return new Response("Not found", { status: 404 });
}

// Posts and Photos are always there, for posts written on afterwrd, even before anything is imported; without their
// sections published from Facebook they show only those.
const ALWAYS_SHOWN = ["posts", "photos"];

/**
 * A route's loader run on `ctx`: { data } or { error }, never a rejection (it may be waited for later).
 * @param {typeof ROUTES[number]} route
 * @returns {Promise<{ data?: any, error?: any }>}
 */
function loaded([pattern, , load], ctx) {
  const match = pattern.exec(ctx.url.pathname);
  return Promise.resolve().then(() => load(ctx, ctx.url.searchParams, ...match.slice(1))).then((data) => ({ data }), (error) => ({ error }));
}

/**
 * What every page's header and links need, apart from its own data: who's signed in, where they are, their
 * picture, what they've published, and the counts on the menu. No database or secrets: views only draw.
 */
function frame(ctx) {
  const { url, chosen, sections, newComments, zone, requests, updateWaiting, me, ownerName, profile, friendFaces, people } = ctx;
  return { url, user: { id: ctx.user.id, name: ctx.user.name }, chosen, sections, newComments, zone, requests, updateWaiting,
    me, ownerName, profile, friendFaces, people };
}

function page(body) {
  return new Response(String(body), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" },
  });
}

// --- data access ---------------------------------------------------------------

const all = (db, sql, params = []) => db.prepare(sql).bind(...params).all().then((r) => r.results);
const first = (db, sql, params = []) => db.prepare(sql).bind(...params).first();
const marks = (list) => list.map(() => "?").join(",");
const pageNumber = (params) => Math.min(10_000, Math.max(1, Number.parseInt(params.get("page"), 10) || 1));

/** Accumulates WHERE clauses and their parameters. */
class Filters {
  clauses = [];
  params = [];
  add(clause, ...params) {
    this.clauses.push(clause);
    this.params.push(...params);
  }
  get sql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

async function paginate(db, sql, params, page, size = PAGE_SIZE) {
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(...params),
    db.prepare(`${sql} LIMIT ? OFFSET ?`).bind(...params, size, (page - 1) * size),
  ]);
  const total = count.results[0].n;
  return { rows: rows.results, paging: { page, total, hasNext: page * size < total } };
}

async function years(db, table) {
  const rows = await all(db, `SELECT DISTINCT strftime('%Y', created_at, 'unixepoch') AS y FROM ${table} ORDER BY y DESC`);
  return rows.map((r) => r.y);
}

/** Rows with a `media` list attached via media.<column>. */
async function withMedia(db, rows, column) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const media = await all(db, `SELECT * FROM media WHERE ${column} IN (${marks(ids)}) ORDER BY created_at, id`, ids);
  return rows.map((r) => ({ ...r, media: media.filter((m) => m[column] === r.id) }));
}

/**
 * Posts with their photos, tags and (unless `threads` is false) the comments written on them here. `thread` is
 * undefined without threads, null for a post with no comments (Facebook's), else its comments. Posts written here
 * before signing come with their polls, events, comments and earlier words, read-only (docs/signed-conversations.md,
 * step 4e).
 */
async function loadPosts(db, rows, { threads = true } = {}) {
  if (!rows.length) return rows;
  const ids = rows.map((p) => p.id);
  const own = rows.filter((p) => p.source === "afterwrd");
  // All at once: none needs another's answer.
  const [posts, tags, comments, polls, earlier, events] = await Promise.all([
    withMedia(db, rows, "post_id"),
    all(db, `SELECT t.post_id, p.id, p.name FROM facebook_post_tags t JOIN facebook_people p ON p.id = t.person_id
      WHERE t.post_id IN (${marks(ids)})`, ids),
    threads ? loadThreads(db, own.map((p) => p.key)) : null,
    // Polls in posts written here, with who chose what: this is the owner's own site.
    sitePolls(db, own.map((p) => p.id), "site"),
    // Edits (edits.js): what posts written here said before.
    postVersions(db, own.filter((p) => p.edited_at).map((p) => p.id)),
    // The owner's events (events.js), with everyone invited and their answers: this is the host's own site.
    eventsFor(db, own.map((p) => p.id)),
  ]);
  return posts.map((p) => ({
    ...p, tags: tags.filter((t) => t.post_id === p.id), thread: comments ? comments.get(p.key) ?? null : undefined,
    poll: polls.get(p.id) ?? null, earlier: earlier.get(p.id) ?? [], editable: false, event: events.get(p.id) ?? null,
  }));
}

const loadComments = (db, rows) => withMedia(db, rows, "comment_id");

function groupBy(items, key) {
  const groups = [];
  for (const item of items) {
    const k = key(item);
    if (groups.length && groups.at(-1)[0] === k) groups.at(-1)[1].push(item);
    else groups.push([k, [item]]);
  }
  return groups;
}

// --- pages -------------------------------------------------------------------

async function overview(ctx) {
  const { db } = ctx;
  const tables = { posts: "posts", comments: "facebook_comments", reactions: "facebook_reactions", media: "media", albums: "albums",
    tagged_photos: "facebook_tagged_photos" };
  const counts = {};
  const results = await db.batch([
    ...Object.values(tables).map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)),
    db.prepare("SELECT COUNT(*) AS n FROM facebook_people WHERE friend_since IS NOT NULL"),
  ]);
  Object.keys(tables).forEach((name, i) => { counts[name] = results[i].results[0].n; });
  counts.friends = results.at(-1).results[0].n;
  const byYear = await all(db, `
    SELECT year, SUM(t = 'p') AS posts, SUM(t = 'c') AS comments, SUM(t = 'r') AS reactions, SUM(t = 'm') AS photos
    FROM (
      SELECT strftime('%Y', created_at, 'unixepoch') AS year, 'p' AS t FROM posts
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'c' FROM facebook_comments
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'r' FROM facebook_reactions
      UNION ALL SELECT strftime('%Y', created_at, 'unixepoch'), 'm' FROM media WHERE created_at IS NOT NULL
    )
    GROUP BY year ORDER BY year DESC`);
  const topPeople = await all(db, `
    SELECT p.id, p.name, p.friend_since,
      (SELECT COUNT(*) FROM facebook_comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM facebook_reactions r WHERE r.target_owner_id = p.id) AS reactions
    FROM facebook_people p WHERE p.is_me = 0
    ORDER BY comments + reactions DESC LIMIT 15`);
  return { counts, byYear, topPeople };
}

async function timeline(ctx, params) {
  const { db } = ctx;
  const year = params.get("year") ?? "";
  const f = new Filters();
  if (year) f.add("strftime('%Y', created_at, 'unixepoch') = ?", year);
  const sql = `
    SELECT * FROM (
      SELECT 'post' AS type, id, created_at FROM posts
      UNION ALL SELECT 'comment', id, created_at FROM facebook_comments
      UNION ALL SELECT 'reaction', id, created_at FROM facebook_reactions
    ) ${f.sql} ORDER BY created_at DESC, type, id DESC`;
  const { rows, paging } = await paginate(db, sql, f.params, pageNumber(params));

  async function load(type, baseSql, alias, loader) {
    const ids = rows.filter((r) => r.type === type).map((r) => r.id);
    if (!ids.length) return new Map();
    let found = await all(db, `${baseSql} WHERE ${alias}.id IN (${marks(ids)})`, ids);
    if (loader) found = await loader(db, found);
    return new Map(found.map((r) => [r.id, r]));
  }
  const lookup = {
    post: await load("post", POST_SQL, "p", loadPosts),
    comment: await load("comment", COMMENT_SQL, "c", loadComments),
    reaction: await load("reaction", REACTION_SQL, "r"),
  };
  const items = rows.map((r) => [r.type, lookup[r.type].get(r.id)]);
  const allYears = [...new Set([...await years(db, "posts"), ...await years(db, "facebook_comments"), ...await years(db, "facebook_reactions")])]
    .sort().reverse();
  return { items, paging, years: allYears, year };
}

async function posts(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const chosen = await ctx.chosen;
  const f = new Filters();
  if (!chosen.includes("posts")) f.add("p.source = 'afterwrd'");
  if (q) f.add("(p.text LIKE ? OR p.title LIKE ? OR p.link_url LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', p.created_at, 'unixepoch') = ?", year);
  // Facebook's kinds, or AFTERWRD_KIND for posts written here (which have none).
  if (kind === AFTERWRD_KIND) f.add("p.source = 'afterwrd'");
  else if (kind) f.add("p.kind = ?", kind);
  const own = chosen.includes("posts") ? "" : "WHERE source = 'afterwrd'";
  // All at once: none needs another's answer.
  const [{ rows, paging }, kinds, postYears] = await Promise.all([
    paginate(db, `${POST_SQL} ${f.sql} ORDER BY p.created_at DESC`, f.params, pageNumber(params)),
    all(db, `SELECT COALESCE(kind, '${AFTERWRD_KIND}') AS kind FROM posts ${own} GROUP BY 1 ORDER BY COUNT(*) DESC`).then((r) => r.map((k) => k.kind)),
    all(db, `SELECT DISTINCT strftime('%Y', created_at, 'unixepoch') AS y FROM posts ${own} ORDER BY y DESC`).then((r) => r.map((y) => y.y)),
  ]);
  // afterwrd 2: the owner's signed posts (items.js), on the page whose dates they fall between, as posts here always
  // were: the first page takes the newest, the last the oldest. "Written on afterwrd" lists only them.
  let items = [];
  if (kind === AFTERWRD_KIND || !kind) {
    // Each page takes them down to its own oldest post, from the previous page's oldest (so none falls between).
    const dates = rows.map((r) => r.created_at);
    const oldest = paging.hasNext && dates.length ? dates.at(-1) : null;
    const before = paging.page > 1
      ? (await all(db, `${POST_SQL} ${f.sql} ORDER BY p.created_at DESC LIMIT 1 OFFSET ?`, [...f.params, (paging.page - 1) * PAGE_SIZE - 1]))[0]?.created_at ?? null
      : null;
    if (paging.page === 1 || before !== null) items = await ownItemsWhere(db, { from: oldest, to: before, q, year });
  }
  const hasItems = (await ownItemCount(db)) > 0;
  return { posts: await loadPosts(db, rows), items, paging, q, year, kind, years: postYears,
    kinds: hasItems && !kinds.includes(AFTERWRD_KIND) ? [...kinds, AFTERWRD_KIND] : kinds };
}

async function comments(ctx, params) {
  const { db } = ctx;
  const [q, year, kind] = ["q", "year", "kind"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(c.text LIKE ? OR o.name LIKE ? OR c.group_name LIKE ?)", ...Array(3).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', c.created_at, 'unixepoch') = ?", year);
  if (kind) f.add("c.target_kind = ?", kind);
  const [{ rows, paging }, kinds, commentYears] = await Promise.all([
    paginate(db, `${COMMENT_SQL} ${f.sql} ORDER BY c.created_at DESC`, f.params, pageNumber(params)),
    all(db, `SELECT target_kind FROM facebook_comments WHERE target_kind IS NOT NULL
      GROUP BY target_kind ORDER BY COUNT(*) DESC`).then((r) => r.map((k) => k.target_kind)),
    years(db, "facebook_comments"),
  ]);
  return { comments: await loadComments(db, rows), paging, q, year, kind, years: commentYears, kinds };
}

async function likes(ctx, params) {
  const { db } = ctx;
  const [q, year, reaction] = ["q", "year", "reaction"].map((k) => params.get(k) ?? "");
  const f = new Filters();
  if (q) f.add("(o.name LIKE ? OR r.group_name LIKE ?)", ...Array(2).fill(`%${q}%`));
  if (year) f.add("strftime('%Y', r.created_at, 'unixepoch') = ?", year);
  if (reaction) f.add("r.reaction = ?", reaction);
  const [{ rows, paging }, reactionTypes, reactionYears] = await Promise.all([
    paginate(db, `${REACTION_SQL} ${f.sql} ORDER BY r.created_at DESC`, f.params, pageNumber(params)),
    all(db, "SELECT reaction FROM facebook_reactions GROUP BY reaction ORDER BY COUNT(*) DESC").then((r) => r.map((k) => k.reaction)),
    years(db, "facebook_reactions"),
  ]);
  return { reactions: rows, paging, q, year, reaction, years: reactionYears, reactionTypes };
}

/**
 * Filter for a photo set: an album id, or 'other' and 'videos' (Facebook's photos and videos outside albums: every
 * photo made on afterwrd is in an album).
 */
export function mediaSet(key) {
  if (key === "videos") return { title: "Videos", where: "album_id IS NULL AND source = 'facebook' AND kind = 'video'", params: [] };
  if (key === "other") return { title: "Other photos", where: "album_id IS NULL AND source = 'facebook' AND kind = 'photo'", params: [] };
  if (/^\d+$/.test(key)) return { title: null, where: "album_id = ?", params: [Number(key)] };
  return null;
}

const setStats = (db, where, params) => first(db,
  `SELECT COUNT(*) AS count, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts FROM media WHERE ${where}`, params);

async function photos(ctx) {
  const { db } = ctx;
  const imported = (await ctx.chosen).includes("photos");
  const albums = await all(db, `
    SELECT a.id, a.name, m.hash, m.thumb_hash, m.kind, m.width, m.height,
      COUNT(x.id) AS count, MIN(x.created_at) AS first_ts, MAX(x.created_at) AS last_ts
    FROM albums a
    JOIN media x ON x.album_id = a.id
    LEFT JOIN media m ON m.id = COALESCE(a.cover_media_id, (SELECT MAX(id) FROM media y WHERE y.album_id = a.id))
    ${imported ? "" : "WHERE a.source = 'afterwrd'"}
    GROUP BY a.id ORDER BY first_ts DESC`);
  const byYear = groupBy(albums, (a) => fmtDate(a.first_ts).slice(-4));

  const collections = [];
  for (const key of imported ? ["other", "videos"] : []) {
    const { title, where, params } = mediaSet(key);
    const stats = await setStats(db, where, params);
    const cover = await first(db, `SELECT * FROM media WHERE ${where} ORDER BY created_at DESC LIMIT 1`, params);
    if (cover) collections.push({ key, title, cover, ...stats });
  }
  const taggedCount = imported ? (await first(db, "SELECT COUNT(*) AS n FROM facebook_tagged_photos")).n : 0;
  return { byYear, collections, tagged: taggedCount };
}

async function album(ctx, params, key) {
  const { db } = ctx;
  const set = mediaSet(key);
  if (!set) return null;
  let { title } = set;
  let info = null;
  if (title === null) {
    info = await first(db, "SELECT * FROM albums WHERE id = ?", set.params);
    if (!info) return null;
    title = info.name;
  }
  // Facebook's albums only if Photos was published from the download.
  if (info?.source !== "afterwrd" && !(await ctx.chosen).includes("photos")) return null;
  const stats = await setStats(db, set.where, set.params);
  const { rows, paging } = await paginate(db, `SELECT * FROM media WHERE ${set.where} ${MEDIA_ORDER}`, set.params,
    pageNumber(params), PHOTO_PAGE_SIZE);
  // Long-running sets read better split by month; a single trip's album doesn't need it.
  const spansMonths = fmtMonth(stats.first_ts) !== fmtMonth(stats.last_ts);
  const groups = spansMonths ? groupBy(rows, (m) => fmtMonth(m.created_at)) : [[null, rows]];
  return { key, title, info, stats, groups, paging };
}

async function tagged(ctx, params) {
  if (!(await ctx.chosen).includes("photos")) return null;
  const { rows, paging } = await paginate(ctx.db, `
    SELECT t.*, p.name AS owner_name FROM facebook_tagged_photos t LEFT JOIN facebook_people p ON p.id = t.owner_id
    ORDER BY t.created_at DESC`, [], pageNumber(params));
  return { tagged: rows, paging };
}

/**
 * A photo or video, among the rest of its album; or, opened from a post (?in=post), among that post's photos, with
 * ✕ going back to where the post was (?back=, a page on this site), not into the middle of an album.
 */
async function photo(ctx, params, id) {
  const { db } = ctx;
  const m = await first(db, "SELECT * FROM media WHERE id = ?", [Number(id)]);
  if (!m) return null;
  const setKey = m.album_id ? String(m.album_id) : m.kind === "video" ? "videos" : "other";
  const inPost = params.get("in") === "post" && m.post_id != null;
  const { where, params: setParams, title } = inPost ? { where: "post_id = ?", params: [m.post_id], title: "Post" } : mediaSet(setKey);
  const setTitle = title ?? (await first(db, "SELECT name FROM albums WHERE id = ?", setParams)).name;
  const order = "(COALESCE(created_at, 0), id)";
  const position = [m.created_at ?? 0, m.id];
  const [prev, next, index] = await db.batch([
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} < (?, ?)
      ORDER BY COALESCE(created_at, 0) DESC, id DESC LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT * FROM media WHERE ${where} AND ${order} > (?, ?) ${MEDIA_ORDER} LIMIT 1`).bind(...setParams, ...position),
    db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${where} AND ${order} < (?, ?)`).bind(...setParams, ...position),
  ]);
  const before = index.results[0].n;
  // afterwrd 2: a photo in a signed post (items.js) is an item of its own, with its own signed comments, shown with its
  // post; opened from the post, it pages through the post's photos, and ✕ goes back there.
  const item = m.item_id ? await photoItem(ctx.env, m.id) : null;
  if (item) {
    const inItem = params.get("in") === "post";
    const back = inItem ? (params.get("back") ? safeNext(params.get("back"), ctx.url) : `/posts/${item.post.id}`) : null;
    const album = { m, setKey, setTitle, prev: prev.results[0], next: next.results[0], index: before + 1,
      total: (await setStats(db, where, setParams)).count, albumPage: Math.floor(before / PHOTO_PAGE_SIZE) + 1, back: null, stay: "" };
    return { ...album, ...(inItem ? { prev: item.prev, next: item.next, index: item.index, total: item.total, setTitle: "Your post", back,
      stay: `?${new URLSearchParams({ in: "post", back })}` } : {}), post: null, comment: null, key: null, thread: null, itemPost: item.post, photoItem: item };
  }
  // The post a photo came with is shown for context; comments here are on the photo itself.
  const post = m.post_id
    ? (await loadPosts(db, await all(db, `${POST_SQL} WHERE p.id = ?`, [m.post_id]), { threads: false }))[0] : null;
  const comment = m.comment_id
    ? (await loadComments(db, await all(db, `${COMMENT_SQL} WHERE c.id = ?`, [m.comment_id])))[0] : null;
  // From a post: back where it was, and the post's other photos keep to the post too.
  const postPage = post && /^post-\d+-[0-9a-f]{8}$/.test(post.key) ? `/posts/${post.key}` : "/posts";
  const back = inPost ? (params.get("back") ? safeNext(params.get("back"), ctx.url) : postPage) : null;
  return {
    m, setKey, setTitle: inPost && post?.source === "afterwrd" ? "Your post" : setTitle, prev: prev.results[0], next: next.results[0],
    index: before + 1, total: (await setStats(db, where, setParams)).count, albumPage: Math.floor(before / PHOTO_PAGE_SIZE) + 1,
    post, comment, back, stay: inPost ? `?${new URLSearchParams({ in: "post", back })}` : "",
    ...await photoThread(db, m),
  };
}

async function friends(ctx, params) {
  const [q, show, sort] = [params.get("q") ?? "", params.get("show") || "friends", params.get("sort") || "name"];
  const f = new Filters();
  f.add("p.is_me = 0");
  if (show === "friends") f.add("p.friend_since IS NOT NULL");
  else if (show === "removed") f.add("p.unfriended_at IS NOT NULL");
  if (q) f.add("p.name LIKE ?", `%${q}%`);
  const orders = {
    name: "p.name COLLATE NOCASE",
    since: "p.friend_since IS NULL, p.friend_since",
    activity: "comments + reactions DESC, p.name COLLATE NOCASE",
  };
  const order = Object.hasOwn(orders, sort) ? orders[sort] : orders.name;
  const people = await all(ctx.db, `
    SELECT p.*,
      (SELECT COUNT(*) FROM facebook_comments c WHERE c.target_owner_id = p.id) AS comments,
      (SELECT COUNT(*) FROM facebook_reactions r WHERE r.target_owner_id = p.id) AS reactions,
      (SELECT COUNT(*) FROM posts x WHERE x.target_id = p.id) AS wall,
      (SELECT COUNT(*) FROM facebook_tagged_photos t WHERE t.owner_id = p.id) AS tagged
    FROM facebook_people p ${f.sql} ORDER BY ${order}`, f.params);
  return { people, q, show, sort };
}

async function person(ctx, params, id) {
  const { db } = ctx;
  const personId = Number(id);
  const p = await first(db, "SELECT * FROM facebook_people WHERE id = ?", [personId]);
  if (!p) return null;
  const keys = Object.keys(PERSON_TABS);
  const countRows = await db.batch(keys.map((k) => db.prepare(`SELECT COUNT(*) AS n FROM (${PERSON_TABS[k][1]})`).bind(personId)));
  const counts = Object.fromEntries(keys.map((k, i) => [k, countRows[i].results[0].n]));
  let tab = params.get("tab") ?? "";
  if (!Object.hasOwn(PERSON_TABS, tab)) tab = keys.find((k) => counts[k]) ?? "comments";
  let { rows, paging } = await paginate(db, PERSON_TABS[tab][1], [personId], pageNumber(params));
  if (tab === "comments") rows = await loadComments(db, rows);
  else if (tab === "wall" || tab === "tags") rows = await loadPosts(db, rows);
  const tabs = Object.fromEntries(keys.map((k) => [k, PERSON_TABS[k][0]]));
  return { person: p, tabs, counts, tab, rows, paging };
}

async function post(ctx, params, key) {
  const [row] = await all(ctx.db, `${POST_SQL} WHERE p.key = ?`, [key]);
  if (!row) return null;
  const [p] = await loadPosts(ctx.db, [row]);
  return { post: p };
}

/** A friend's signed post (afterwrd 2: friendcopies.js), its comments read from their site and checked. */
async function friendItemPost(ctx, params, connectionId, id) {
  const connection = await first(ctx.db, "SELECT * FROM connections WHERE id = ? AND approved_at IS NOT NULL", [Number(connectionId)]);
  if (!connection) return null;
  let item = await friendItem(ctx.db, connection.id, id);
  if (!item) { await pullItems(ctx.env, ctx.url.origin, connection); item = await friendItem(ctx.db, connection.id, id); }
  if (!item) return null;
  // An event: who's coming, as its site says now (one signed call), not as last heard.
  if (item.event) {
    await pullItems(ctx.env, ctx.url.origin, connection).catch(() => null);
    item = await friendItem(ctx.db, connection.id, id);
    if (!item) return null;
  }
  const shown = await friendComments(ctx, connection, id, item.author);
  // A poll counted again from its checked list (polls are public: anyone who can see one can count it), and kept, so
  // Home shows what was counted here; if the host's totals were different, the page says so.
  if (item.poll && shown.counted) {
    const worked = workOut(shown.counted, { id, author: item.author });
    const ordered = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
    if (item.tally && ordered(item.tally.votes ?? {}) !== ordered(worked.tally.votes)) {
      shown.problem ??= `${connection.name}'s site's totals were wrong; these are counted from the votes themselves.`;
    }
    await ctx.db.prepare("UPDATE copies SET tally = ? WHERE id = ? AND connection_id = ?").bind(JSON.stringify(worked.tally), id, connection.id).run();
  }
  // Read again: names learnt from the thread (friendcopies.js friendThread), and any count just kept.
  item = (await friendItem(ctx.db, connection.id, id)) ?? item;
  return { item, ...shown };
}

/** The comments on a friend's signed post or photo (its own list, `id`), read from their site and checked. */
async function friendComments(ctx, connection, id, owner) {
  const t = await friendThread(ctx.env, ctx.url.origin, connection, id);
  if (t.error) return { thread: null, list: null, problem: t.error };
  const read = t.entries.map((e) => ({ n: e.n, fp: e.fp, taken: e.taken, failed: e.state === "failed",
    r: e.record ? { record: e.record, content: e.content } : null }));
  const comments = itemComments(read, { owner, item: id });
  const names = new Map(t.entries.filter((e) => e.by).map((e) => [e.by, e.name]));
  // How each is known here (names.js): "friend of Ann", "not your friend Bob", a friend's new name.
  const tags = new Map(t.entries.filter((e) => e.by).map((e) => [e.by, { label: e.label, warn: e.warn, renamed: e.renamed }]));
  const blocked = await blockedAmong(ctx.db, comments.map((c) => c.author));
  for (const c of comments) { c.name = names.get(c.author) ?? "Someone"; Object.assign(c, tags.get(c.author)); c.blocked = blocked.has(c.author); if (c.removedBy) c.removedByName = names.get(c.removedBy) ?? null; }
  const me = await ownHost(ctx.env);
  const problem = t.problem ? `${connection.name}'s site sent a conversation that doesn't add up, so what's after that isn't shown.`
    : t.changed ? `${connection.name}'s site has changed this conversation since you last saw it.` : null;
  // What was checked, for counting a poll again (only from the start: a thread read from a checkpoint can't be).
  const counted = !t.problem && read[0]?.n === 1 ? read.map((e) => ({ e, r: e.failed ? null : e.r })) : null;
  return { thread: comments, list: { host: t.host, me: me?.person, seen: t.seen, mine: t.mine }, problem, counted, admins: t.admins };
}

/** A photo in a friend's signed post, from the post (afterwrd 2): its own comments, read from their site. */
async function friendItemPhoto(ctx, params, connectionId, id, index) {
  const connection = await first(ctx.db, "SELECT * FROM connections WHERE id = ? AND approved_at IS NOT NULL", [Number(connectionId)]);
  const item = connection && (await friendItem(ctx.db, connection.id, id));
  const at = Number(index);
  if (!item || !(at >= 1 && at <= item.photos.length) || !item.photos[at - 1]?.item) return null;
  const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : `/#fi${connection.id}-${id}`;
  return { item, index: at, back, ...(await friendComments(ctx, connection, item.photos[at - 1].item, item.author)) };
}

/** One of the owner's own signed posts (afterwrd 2: items.js), with its comments. */
async function itemPost(ctx, params, id) {
  const item = await ownItem(ctx.db, id);
  if (!item) return null;
  const list = await loadThread(ctx.env, id);
  if (!list) return null;
  const comments = itemComments(list.entries, { owner: item.author, item: id });
  // Friends by the name the owner approved, and a friend's new name (names.js).
  const { names, tags } = await peopleShown(ctx.db, comments.flatMap((c) => [c.author, c.removedBy]), { me: item.author });
  for (const c of comments) { if (c.author) { c.name = names.get(c.author) ?? "Someone"; Object.assign(c, tags.get(c.author)); } if (c.removedBy) c.removedByName = names.get(c.removedBy) ?? null; }
  // An event's page: friends who could still be invited (those with an identity: a signed invitation names them).
  if (item.event) {
    const asked = new Set(item.event.guests.map((g) => g.id));
    item.invitable = (await all(ctx.db, `SELECT id, name FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
      AND identity IS NOT NULL ORDER BY name COLLATE NOCASE`)).filter((f) => !asked.has(f.id));
  }
  return { item, thread: comments, list: { ...item.list, seen: list.seen } };
}

/** Changing the owner's own signed event. */
async function itemEventEdit(ctx, params, id) {
  const item = await ownItem(ctx.db, id);
  if (!item?.event) return null;
  const list = await loadThread(ctx.env, id);
  return list ? { item, list: { ...item.list, seen: list.seen } } : null;
}

/** A calendar file for an event: `e` as pages show it, its page here, and who it's from. */
const eventFile = (e, { uid, url, about }) => new Response(icsFile({ ...e, all_day: e.all_day ? 1 : 0 }, { uid, url, about }), {
  headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="event.ics"', "Cache-Control": "private, no-store" } });

/** The owner's own signed event as a calendar file. */
async function itemEventFile(ctx, params, id) {
  const item = await ownItem(ctx.db, id);
  if (!item?.event) return null;
  const page = `${ctx.url.origin}/posts/${id}`;
  return eventFile(item.event, { uid: `${ctx.url.origin}/items/${id}`, url: page, about: [item.text, page].filter(Boolean).join("\n\n") });
}

/** A friend's signed event, from the owner's copy of it, as a calendar file. */
async function friendItemEventFile(ctx, params, connectionId, id) {
  const item = await friendItem(ctx.db, Number(connectionId), id);
  if (!item?.event) return null;
  const page = `${ctx.url.origin}/friend/${connectionId}/posts/${id}`;
  return eventFile(item.event, { uid: `${item.connection.origin}/items/${id}`, url: page, about: `${item.connection.name}'s event: ${page}` });
}

/** The owner's own event as a calendar file. */
async function ownEventFile(ctx, params, key) {
  const found = await findTarget(ctx.db, key);
  const e = found?.post && await first(ctx.db, "SELECT * FROM events WHERE post_id = ?", [found.post.id]);
  if (!e) return null;
  const page = `${ctx.url.origin}/posts/${key}`;
  return new Response(icsFile(e, { uid: postAddress(ctx.url.origin, key), url: page, about: [found.post.text, page].filter(Boolean).join("\n\n") }), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="event.ics"',
      "Cache-Control": "private, no-store" } });
}

/** The newest comments from everyone, marking what's new since this person last looked. */
async function activity(ctx, params) {
  const { db, user } = ctx;
  const { rows, paging } = await latestComments(db, pageNumber(params), PAGE_SIZE);
  const targets = new Map();
  for (const key of new Set(rows.filter((c) => c.source === "here").map((c) => c.target))) targets.set(key, await findTarget(db, key));
  const seen = user.activity_seen_at ?? 0;
  if (paging.page === 1) {
    await db.prepare("UPDATE users SET activity_seen_at = ? WHERE id = ?").bind(now(), user.id).run();
    ctx.activitySeen = true;
  }
  const items = rows.map((c) => ({ ...c, on: c.source === "here" ? targets.get(c.target) : null,
    isNew: c.created_at > seen && (c.source !== "here" || c.author_id !== user.id) }));
  return { items, paging };
}

// Introductions from friends still here, to people the owner isn't connected with (or asking) yet (connect.js).
const INTRODUCTION_DAYS = 60;
const INTRODUCTIONS_SQL = `SELECT i.id, i.origin, i.name, i.note, c.name AS by_name FROM introductions i
      JOIN connections c ON c.id = i.connection_id AND c.approved_at IS NOT NULL AND c.reached_at IS NOT NULL
      WHERE i.created_at > ? AND NOT EXISTS (SELECT 1 FROM connections k WHERE k.origin = i.origin AND k.connected_at IS NOT NULL)
      ORDER BY i.created_at DESC`;

/**
 * Home: write something, then the owner's own posts written here and their friends' newest, together. Everything's
 * asked at once (all read-only), so the page waits for the slowest friend's site or query, not for them all in turn.
 */
async function home(ctx, params) {
  const { db } = ctx;
  await pullNew(ctx.env, ctx.url.origin); // friends whose signed posts this site has never had (friendcopies.js)
  const [own, friendOwn, ownOld, friendRows, onThisDayPosts, newDevicesFound, newNotifying, securityFix, auto, requests, checkFailure,
    friendChecks, checkGrantState, asking, introductions, recovered, lookAfterFound, archiveDropped, identity, gone, movingRows, sent] = await Promise.all([
    ownItems(db), // afterwrd 2: the owner's own posts, signed (items.js)
    friendItems(db), // …and friends', kept here (friendcopies.js): asked for again below, after the page has gone
    // …and their posts from before signing: theirs alone, read-only, until migration (docs/signed-conversations.md).
    all(db, `${POST_SQL} WHERE p.source = 'afterwrd' ORDER BY p.created_at DESC LIMIT 30`).then((rows) => loadPosts(db, rows)),
    // Friends: whose site has gone quiet or said no (friendcopies.js gone) shows on Friends instead of Home.
    all(db, "SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE"),
    onThisDay(ctx, 2),
    newDevices(db, ctx.user),
    newPushDevices(db),
    securityFixWaiting(db),
    autoState(db), // automatic updates (auto.js): anything that needs the owner
    checkRequests(db),
    lastFailure(db),
    friendCheckAlerts(db),
    checkGrant(db),
    // Someone asking to be friends: approved (or not) from Home in one tap, as well as from Friends.
    all(db, `SELECT id, origin, name, identity, invited_as, via_kind, via_name FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NULL
      ORDER BY connected_at DESC LIMIT 3`),
    // Friends introducing the owner to someone: asked (or not) from Home too.
    all(db, `${INTRODUCTIONS_SQL} LIMIT 3`, [now() - INTRODUCTION_DAYS * 86400]),
    recoveredHere(db, ctx.user), // got back in through Cloudflare, on this device (recover.js)
    selfHosted(ctx.env) ? null : lookAfterFacts(db),
    // The Facebook archive was too big to move into the site's own object (sitecopy.js): import it again.
    first(db, "SELECT 1 AS dropped FROM settings WHERE key = 'archive_dropped'").then((row) => Boolean(row)),
    // A change to the owner's identity waiting to take effect (keys.js): shown until it does, or is cancelled.
    identitySummary(db),
    // The owner has moved away (keys.js ownMove): this site only says where now.
    ownMove(db, ctx.url.origin),
    // Friends moving, or moved and not yet followed here (identities.js, calls.js).
    all(db, `SELECT c.name, i.moving_to, i.moving_at FROM connections c JOIN identities i ON i.person = c.identity
      WHERE c.approved_at IS NOT NULL AND i.moving_to IS NOT NULL AND i.moving_to != c.origin ORDER BY i.moving_at LIMIT 5`),
    // Deletes and leaves not taken yet, and anything signed as the owner that their site never sent (sentchecks.js).
    sentTrouble(db),
  ]);
  const identityChange = identity?.pending ?? null;
  const moved = gone?.done ? gone : null;
  const friendsMoving = movingRows.map((r) => ({ name: String(r.name), moving_to: String(r.moving_to), moving_at: Number(r.moving_at),
    waiting: Number(r.moving_at) > now() }));
  // Friends' signed posts, asked for again after the page has gone (once an hour at most for each: friendcopies.js).
  ctx.work?.waitUntil?.(pullFriends(ctx.env, ctx.url.origin).catch(() => {}));
  // …and signed groups' (step 6c: groupcopies.js), likewise.
  ctx.work?.waitUntil?.(groups_.pullGroups(ctx.env, ctx.url.origin).catch(() => {}));
  // …then what the owner sent elsewhere, checked with its hosts (sentchecks.js), once an hour at most.
  ctx.work?.waitUntil?.(checkSentRound(ctx.env, ctx.url.origin).catch(() => {}));
  // Self-hosted (hosting.js), there are no checks either way, nor automatic updates: nothing about them on Home.
  if (selfHosted(ctx.env)) {
    return { own, friendOwn, ownOld, onThisDay: onThisDayPosts, friends: friendRows,
      newDevices: newDevicesFound, newNotifying, securityFix, recovered, asking, introductions, archiveDropped, identityChange, moved, friendsMoving, sent };
  }
  return {
    own, friendOwn, ownOld, onThisDay: onThisDayPosts, friends: friendRows,
    newDevices: newDevicesFound, newNotifying, securityFix, auto, recovered, identityChange, moved, friendsMoving, sent,
    // Friends asking for their site to be checked: one tap makes the link to send back (checks.js).
    checkRequests: requests,
    // A friend's site that checked this one and found something; this one's checks of friends' sites that did (or
    // that their sites keep refusing): friendchecks.js.
    checkFailure, friendChecks,
    checkGrant: checkGrantState, // a problem with it, if there is one
    // The one reminder that the site can look after itself (keep up to date, let friends' sites check it), if it can't yet.
    lookAfter: await lookAfterReminder(db, auto, checkGrantState, lookAfterFound),
    asking, introductions, archiveDropped,
  };
}

async function memories(ctx) {
  return { onThisDay: await onThisDay(ctx, 6) };
}

/** Posts from this day of the year (in London) in earlier years, newest first, with their photos. */
async function onThisDay(ctx, limit) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(({ type, value }) => [type, value]));
  // Before this year (in UTC, as the day is), by the posts_day index (migrations/0022): the same expression exactly.
  const rows = await all(ctx.db, `${POST_SQL} WHERE strftime('%m-%d', p.created_at, 'unixepoch') = ?
    AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?`, [`${parts.month}-${parts.day}`, Date.UTC(Number(parts.year), 0, 1) / 1000, limit]);
  return loadPosts(ctx.db, rows, { threads: false });
}

/** A photo's comments ({key, thread}), if it takes them: only a picture posted on afterwrd, for now. */
async function photoThread(db, m) {
  const key = photoKey(m);
  if (!key || !hasOldThread(await findTarget(db, key))) return { key: null, thread: null };
  return { key, thread: (await loadThreads(db, [key])).get(key) };
}

/** A photo's permanent address (public/static/activity.js) leads to its page: afterwrd's, if it's there too. */
async function photoByHash(ctx, params, hash) {
  const m = await first(ctx.db, "SELECT id FROM media WHERE hash = ? ORDER BY source = 'afterwrd' DESC, id LIMIT 1", [hash]);
  return m ? Response.redirect(`${ctx.url.origin}/photos/${m.id}${ctx.url.hash}`, 302) : null;
}

// --- a friend's shared Facebook archive and albums, read from their site (friends.js) ---------------------------------

/** Only the owner reads friends' sites from here. `load` gets the connection and returns the page's data. */
async function fromFriend(ctx, id, load) {
  /** @type {(Row<"connections"> & Record<string, any>) | null} the row, and what the page adds to it (facebook, avatar…) */
  const connection = await connectionById(ctx.db, id);
  if (!connection) return null;
  // Who they are in the Facebook download is looked up while their site is asked (nothing there needs it).
  const facebook = facebookSelf(ctx.db, connection);
  facebook.catch(() => {}); // waited for below, either way
  // A self-hosted friend's site can't be checked (hosting.js): their page says so.
  connection.selfHosted = !onCloudflare(connection.origin, ctx.env);
  try {
    const data = await load(connection);
    // Their signed name, if it's changed since the owner approved them (names.js): shown, with a way to use it.
    if (connection.identity) connection.renamed = (await peopleShown(ctx.db, [String(connection.identity)])).tags.get(String(connection.identity))?.renamed ?? null;
    connection.facebook = await facebook;
    await noteAnswer(ctx.db, connection).run();
    if (data instanceof Response) return data; // somewhere else to go (a photo in a signed post: friendPhoto)
    return { ...data, friend: connection };
  } catch (error) {
    connection.facebook = await facebook;
    await noteAnswer(ctx.db, connection, error).run();
    throw new Problem(views.friendProblem, { friend: connection, message: error.message });
  }
}

/**
 * The owner's Friends: friends on afterwrd (connected sites), each linked, if the owner says so, to who they are in
 * the Facebook download; then everyone else from that download. Matching names are suggested, never assumed.
 */
async function friendsIndex(ctx) {
  const { db } = ctx;
  const [connections, links, people, requests, invites, introductions] = await db.batch([
    db.prepare("SELECT * FROM connections WHERE connected_at IS NOT NULL AND approved_at IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT * FROM friend_links"),
    db.prepare("SELECT id, name, friend_since FROM facebook_people WHERE is_me = 0 AND friend_since IS NOT NULL ORDER BY name COLLATE NOCASE"),
    db.prepare(`SELECT id, origin, name, identity, invited_as, via_kind, via_name, connected_at FROM connections
      WHERE connected_at IS NOT NULL AND approved_at IS NULL ORDER BY connected_at DESC`),
    db.prepare(`SELECT person_name, MAX(created_at) AS invited_at FROM connect_links
      WHERE person_name IS NOT NULL AND used_at IS NULL AND expires_at > ? GROUP BY person_name`).bind(now()),
    db.prepare(INTRODUCTIONS_SQL).bind(now() - INTRODUCTION_DAYS * 86400),
  ]);
  const same = (a, b) => a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;
  const linked = new Map(links.results.map((l) => [l.connection_id, l]));
  const taken = links.results.filter((l) => l.person_name);
  const friends = connections.results.map((c) => {
    const link = linked.get(c.id);
    if (link?.person_name) return { ...c, person: people.results.find((p) => same(p.name, link.person_name)) ?? { name: link.person_name } };
    if (link) return c; // they said the suggestion wasn't them
    const matches = people.results.filter((p) => same(p.name, c.name) && !taken.some((t) => same(t.person_name, p.name)));
    return matches.length === 1 ? { ...c, suggestion: matches[0] } : c;
  });
  // Where each Facebook friend stands: on afterwrd, asking to connect, invited, or not yet.
  const facebook = people.results.map((p) => ({
    ...p,
    friend: friends.find((f) => f.person && same(f.person.name, p.name)),
    asking: requests.results.find((r) => r.invited_as && same(r.invited_as, p.name)),
    invited: invites.results.find((i) => same(i.person_name, p.name))?.invited_at,
  }));
  // Requests show only what their site said when it connected: nothing is fetched from a site you haven't approved,
  // so a stranger can't slow this page down or see when you look at it.
  return { friends, facebook, requests: requests.results, introductions: introductions.results,
    checks: await recentChecks(db), blocked: await blockedList(db) };
}

/** Who a friend on afterwrd is in the owner's Facebook download, if the owner has linked them. */
async function facebookSelf(db, connection) {
  return first(db, `SELECT p.id, p.name FROM friend_links l JOIN facebook_people p ON p.name = l.person_name COLLATE NOCASE AND p.is_me = 0
    WHERE l.connection_id = ? LIMIT 1`, [connection.id]);
}

async function friendHome(ctx, params, id) {
  return Response.redirect(`${ctx.url.origin}/friend/${id}/posts`, 302);
}

async function friendPosts(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => {
    const { posts, paging, avatar, cover } = await friend.friendPosts(ctx.env, ctx.url.origin, c, pageNumber(params));
    Object.assign(c, { avatar, cover });
    if (avatar) await rememberPicture(ctx.db, c, avatar)?.run();
    // Their signed posts, kept here (friendcopies.js), on the first page, asked for afresh first.
    if (pageNumber(params) === 1) await pullItems(ctx.env, ctx.url.origin, c).catch(() => null);
    const items = pageNumber(params) === 1 ? await friendItems(ctx.db, { connection: c.id }) : [];
    return { posts, paging, items };
  });
}

/** One of a friend's Facebook posts, if they share them. */
async function friendPost(ctx, params, id, key) {
  return fromFriend(ctx, id, async (c) => {
    const p = await friend.friendPost(ctx.env, ctx.url.origin, c, key);
    if (!p) throw new Error("That post isn't there any more.");
    return { post: p };
  });
}

async function friendPhotos(ctx, params, id) {
  return fromFriend(ctx, id, async (c) => ({ albums: await friend.friendAlbums(ctx.env, ctx.url.origin, c) }));
}

async function friendAlbum(ctx, params, id, key) {
  return fromFriend(ctx, id, async (c) => ({ album: await friend.friendAlbum(ctx.env, ctx.url.origin, c, key, pageNumber(params)) }));
}

/**
 * A friend's photo, among the rest of its album; or, opened from their post (?in=post), among that post's photos, with
 * ✕ going back to where the post was (?back=, a page on this site). Worked out here from the post their site sends
 * with the photo, so it's the same whatever version their site is.
 */
async function friendPhoto(ctx, params, id, hash) {
  return fromFriend(ctx, id, async (c) => {
    const m = await friend.friendPhoto(ctx.env, ctx.url.origin, c, hash);
    // afterwrd 2: a photo in their signed post opens on its own page there, with its signed comments (friendcopies.js).
    if (m.inItem) {
      const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : m.album ? `/friend/${c.id}/photos/album/${m.album.key}` : `/friend/${c.id}/photos`;
      return Response.redirect(`${ctx.url.origin}/friend/${c.id}/posts/${m.inItem.post}/photos/${m.inItem.index}?${new URLSearchParams({ in: "post", back })}`, 302);
    }
    const photos = m.post?.photos ?? [];
    const at = params.get("in") === "post" ? photos.findIndex((p) => p.hash === m.hash) : -1;
    if (at < 0) return { photo: { ...m, inPost: null } };
    const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : `/friend/${c.id}/posts#f${c.id}-${m.post.key}`;
    return { photo: { ...m, inPost: { index: at + 1, total: photos.length, prev: photos[at - 1]?.hash ?? null,
      next: photos[at + 1]?.hash ?? null, back, stay: `?${new URLSearchParams({ in: "post", back })}` } } };
  });
}

// --- groups, each its own Worker, read from there (membership.js) ------------------------------------------------------

/** The owner's groups, with comments waiting in each. (What's coming up in them is on Events.) */
async function groupsIndex(ctx) {
  const list = await all(ctx.db, `SELECT g.*, (SELECT COUNT(*) FROM notices n WHERE n.group_id = g.id AND n.created_at > ?) AS notes
    FROM groups g WHERE g.joined_at IS NOT NULL ORDER BY g.name COLLATE NOCASE`, [ctx.user.activity_seen_at ?? 0]);
  // Groups whose Worker this site made, but which it didn't finish claiming.
  const unfinished = await all(ctx.db, "SELECT id, name, origin FROM groups WHERE joined_at IS NULL AND script != '' ORDER BY created_at");
  return { groups: list.map(withoutKeys), unfinished, connected: ctx.connected };
}

const LIST_SECONDS = 366 * 86400; // the List view: from now, up to a year ahead

/**
 * Which view of a calendar a page asks for (?view=month, week or list; month by default), and the moments it covers:
 * { view, month, day, week, from, to }. `month` and `day` for the month's grid, `week` (its Monday) for a week.
 */
function calendarView(params, zone) {
  const view = ["week", "list"].includes(params.get("view")) ? params.get("view") : "month";
  const month = readMonth(params.get("month"), zone);
  const week = readWeek(params.get("week"), zone);
  const at = now();
  const [from, to] = view === "week" ? weekSpan(week, zone) : view === "list" ? [at, at + LIST_SECONDS] : monthSpan(month, zone);
  return { view, month, day: view === "month" ? readDay(params.get("day"), month) : null, week, from, to };
}

/** What a calendar page needs to know about the view it's showing (calendarView), as plain data. */
const calendarShown = ({ view, month, day, week, from, to }) => ({ view, month, day, week, from, to });

/** An event as the calendar shows it: when, where, whose, where it's answered, and the owner's answer. */
const calendarItem = (e, more) => ({ title: e.title, starts_at: e.starts_at, ends_at: e.ends_at ?? null, all_day: e.all_day ? 1 : 0,
  time_zone: e.time_zone, place: e.place ?? null, cancelled_at: e.cancelled_at ?? null, ...more });

/**
 * Events: a month's calendar of everything the owner could go to (their own events, friends' they're invited to, and
 * their groups', read from each group now), invitations still to answer, and making an event.
 */
async function eventsIndex(ctx, params) {
  const { db } = ctx;
  const shown = calendarView(params, ctx.zone);
  const { from, to } = shown;
  const at = now();
  const IN_SPAN = `${FINISHED_SQL} >= ?1 AND e.starts_at < ?2`;
  const [hosted, joined] = await db.batch([
    // The owner's events from before signing, theirs alone, read-only.
    db.prepare(`SELECT e.*, p.key FROM events e JOIN posts p ON p.id = e.post_id WHERE ${IN_SPAN}`).bind(from, to),
    db.prepare("SELECT * FROM groups WHERE joined_at IS NOT NULL AND identity IS NOT NULL ORDER BY name COLLATE NOCASE"),
  ]);
  // The owner's signed events, and friends' they're invited to (kept as copies), with their answers.
  const [ownSigned, friendSigned] = await Promise.all([
    db.prepare("SELECT id, content FROM items WHERE audience = 'invited'").all(),
    friendEvents(db),
  ]);
  const inSpan = (e) => finishedAt(e) >= from && e.starts_at < to;
  const items = [
    ...hosted.results.map((e) => calendarItem(e, { kind: "own", href: `/posts/${e.key}`, who: "Your event" })),
    ...ownSigned.results.map((r) => ({ id: String(r.id), e: JSON.parse(String(r.content)).event })).filter(({ e }) => e && inSpan(e))
      .map(({ id, e }) => calendarItem({ ...e, cancelled_at: e.cancelled ? e.cancelled_at ?? 1 : null }, { kind: "own", href: `/posts/${id}`, who: "Your event" })),
    ...friendSigned.filter((c) => c.event.answer !== "no" && inSpan(c.event))
      .map((c) => calendarItem(c.event, { kind: "friend", href: `/friend/${c.connection.id}/posts/${c.id}`, who: `${c.connection.name}'s event`,
        answer: c.event.answer })),
  ];
  // Groups' events are kept here as copies (groupcopies.js): nothing to ask. Each date of a repeating one (6d) on its
  // own, with the owner's answer to it.
  for (const g of joined.results) {
    for (const p of await groups_.groupEvents(ctx.env, g)) {
      for (const d of datesOf(p.event, { from, to })) {
        if (d.answer === "no" || !inSpan(d)) continue;
        items.push(calendarItem(d, { kind: "group", href: `/groups/${g.id}/posts/${p.id}${d.date ? `?date=${d.date}` : ""}`, who: g.name, answer: d.answer }));
      }
    }
  }
  items.sort((a, b) => a.starts_at - b.starts_at);
  return {
    ...calendarShown(shown), items,
    invitations: [
      // Invitations still to answer, for events still to come and not called off: answered here as anywhere else,
      // signed, and passed on by this site (friendcopies.js).
      ...friendSigned.filter((c) => !c.event.answer && !c.event.cancelled_at && finishedAt(c.event) >= at && c.list)
        .map((c) => calendarItem(c.event, { connection: c.connection.id, key: c.id, who: c.connection.name, href: `/friend/${c.connection.id}/posts/${c.id}`,
          relay: `/_admin/friend/${c.connection.id}/items/${c.id}/records`, list: c.list, version: c.version })),
    ].sort((a, b) => a.starts_at - b.starts_at),
    // Friends who can be invited to a signed event: those with an identity.
    friends: await all(db, `SELECT id, name FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL AND identity IS NOT NULL
      ORDER BY name COLLATE NOCASE`),
    // The site's public signing key for notifications, which a device is given when it turns them on (push.js).
    pushKey: await pushKey(ctx.env),
  };
}

/** Starting a group: its own Worker, made in the owner's Cloudflare account (groupsites.js), or on their own server. */
async function groupNew(ctx) {
  // Self-hosted (hosting.js): a group's site made on the server by a command, then claimed here.
  if (selfHosted(ctx.env)) return { selfHosted: true, command: serverCommand("new-group"), maxPhotos: MAX_GROUP_PHOTOS };
  let address = null;
  try {
    address = whereAmI(ctx.url);
  } catch {}
  return { connected: ctx.connected, domain: address?.domain ?? null, maxPhotos: MAX_GROUP_PHOTOS };
}

/** Opened from a group's invite link: join it? */
async function groupJoin(ctx, params) {
  const link = params.get("link") ?? "";
  try {
    const info = await groups.linkInfo(ctx.env, ctx.url, link);
    if (info.joined) return Response.redirect(`${ctx.url.origin}/groups/${info.joined}`, 302);
    return { info, link };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Only the owner reads a group from here. `load` gets the owner's membership (with the key to call the group's site)
 * and returns the page's data, or a Response, or throws to say what's wrong; the page is given the membership
 * without its keys.
 */
async function fromGroup(ctx, id, load) {
  const membership = await first(ctx.db, "SELECT * FROM groups WHERE id = ? AND joined_at IS NOT NULL", [Number(id)]);
  if (!membership) return null;
  let data;
  try {
    data = await load(membership);
  } catch (error) {
    throw new Problem(views.groupProblem, { membership: withoutKeys(membership), message: error.message });
  }
  // The membership last, so nothing the group's site said can stand in for it.
  return data instanceof Response ? data : { ...data, membership: withoutKeys(membership) };
}

async function groupHome(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => {
    // A group from before signing: the owner's own posts and comments there, read-only (membership.js).
    if (!g.identity) return { old: true, words: await groups.oldGroupWords(ctx.db, g) };
    // Closed, and its 30 days are up: gone (groups.js).
    if (groups.groupGoneHere(g)) return { gone: true };
    // Its newest posts kept here, after asking what's changed (groupcopies.js); older ones read.
    const before = Number(params.get("before")) || null;
    const got = await groups_.groupPosts(ctx.env, ctx.url.origin, g, { before });
    if (got.error || !got.info) throw got.error ?? new Error("The group's site sent something unexpected.");
    return { group: got.info, posts: got.posts, next: got.next, before, maxPhotos: MAX_GROUP_PHOTOS };
  });
}

/**
 * A signed group's post (step 6c), with its comments read from the group and checked. `photo`: one of its photos
 * (from 1), with that photo's own comments instead.
 */
async function groupItemPost(ctx, params, id, itemId, photo = null) {
  return fromGroup(ctx, id, async (g) => {
    if (!g.identity) throw new Error("That post isn't there any more.");
    const info = await groups_.pullGroup(ctx.env, ctx.url.origin, g);
    let item = (await groups_.groupCopy(ctx.env, g, itemId, info?.people)) ?? (await groups_.fetchGroupItem(ctx.env, ctx.url.origin, g, itemId, info?.people));
    if (!item) throw new Error("That post isn't there any more.");
    if (photo !== null) {
      const at = Number(photo);
      if (!(at >= 1 && at <= item.photos.length) || !item.photos[at - 1]?.item) throw new Error("That photo isn't there any more.");
      const back = params.get("back") ? safeNext(params.get("back"), ctx.url) : `/groups/${g.id}#gi-${itemId}`;
      const { admins: _, ...photoComments } = await groupComments(ctx, g, item.photos[at - 1].item, item.author, info?.people);
      void _;
      return { group: info, item, index: at, back, ...photoComments };
    }
    const shown = await groupComments(ctx, g, itemId, item.author, info?.people);
    // A poll counted again from its checked list, as a friend's is (friendItemPost).
    if (item.poll && shown.counted) {
      const worked = workOut(shown.counted, { id: itemId, author: item.author });
      const ordered = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
      if (item.tally && ordered(item.tally.votes ?? {}) !== ordered(worked.tally.votes)) {
        shown.problem ??= `${g.name}'s site's totals were wrong; these are counted from the votes themselves.`;
      }
      await ctx.db.prepare("UPDATE copies SET tally = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(worked.tally), itemId, g.id).run();
    }
    // A repeating event (step 6d): the date asked for (?date=), or its next, read from the group and checked too, and
    // its answers counted from what's signed.
    if (item.event?.rrule) {
      const asked = params.get("date");
      const at = now();
      const date = asked && hasDate(item.event, asked) ? asked
        : ruleDates(item.event).find((d) => !item.event.skipped.includes(d) && dateOver(item.event, d) > at) ?? null;
      const t = date ? await groups_.groupDate(ctx.env, ctx.url.origin, g, itemId, date, shown.admins ?? new Set()) : null;
      if (t && !t.error) {
        if (t.problem) shown.problem ??= `${g.name}'s site sent answers for ${date} that don't add up, so what's after that isn't shown.`;
        const copy = await ctx.db.prepare("SELECT tally FROM copies WHERE id = ? AND group_id = ?").bind(itemId, g.id).first();
        const tally = JSON.parse(String(copy?.tally ?? "null")) ?? { answers: {} };
        const said = tally.dates?.[date]?.answers ?? {};
        const plain = (o) => JSON.stringify(Object.entries(o).map(([p, a]) => [p, a.answer]).sort());
        if (plain(said) !== plain(t.answers)) shown.problem ??= `${g.name}'s site's answers for that date were wrong; these are counted from the answers themselves.`;
        tally.dates = { ...tally.dates, [date]: { answers: Object.fromEntries(Object.entries(t.answers).map(([p, a]) => [p, { answer: a.answer, version: a.version }])),
          off: t.off, list: t.seen ? { n: t.seen.n, head: t.seen.h } : null } };
        await ctx.db.prepare("UPDATE copies SET tally = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(tally), itemId, g.id).run();
        shown.checkedDate = date;
      }
    }
    item = (await groups_.groupCopy(ctx.env, g, itemId, info?.people)) ?? item;
    const { admins: _, ...rest } = shown;
    void _;
    return { group: info, item, ...rest };
  });
}

/** The comments on a signed group's post or photo (its own list, `id`), read from the group and checked. */
async function groupComments(ctx, g, id, owner, people = []) {
  const t = await groups_.groupThread(ctx.env, ctx.url.origin, g, id, people);
  if (t.error) return { thread: null, list: null, problem: t.error };
  const read = t.entries.map((e) => ({ n: e.n, fp: e.fp, taken: e.taken, failed: e.state === "failed",
    r: e.record ? { record: e.record, content: e.content } : null }));
  const comments = itemComments(read, { owner, item: id });
  const name = (p) => t.names.get(p) ?? "Someone";
  const blocked = await blockedAmong(ctx.db, comments.map((c) => c.author));
  for (const c of comments) {
    c.blocked = blocked.has(c.author); // folded away (blocks.js)
    if (c.author) c.name = name(c.author);
    // How each is known here (names.js): "your friend", "not your friend Bob", a friend's new name.
    if (c.author) Object.assign(c, t.tags.get(c.author));
    // Removed by the group's owner, or one of its admins (lists.js GroupRules).
    if (c.removedBy) c.removedByName = c.removedBy === t.owner ? `the group's owner, ${name(c.removedBy)}` : t.admins.has(c.removedBy) ? `${name(c.removedBy)}, an admin` : name(c.removedBy);
  }
  const me = await ownHost(ctx.env);
  const problem = t.problem ? `${g.name}'s site sent a conversation that doesn't add up, so what's after that isn't shown.`
    : t.changed ? `${g.name}'s site has changed this conversation since you last saw it.` : null;
  const counted = !t.problem && read[0]?.n === 1 ? read.map((e) => ({ e, r: e.failed ? null : e.r })) : null;
  return { thread: comments, list: { host: t.host, me: me?.person, seen: t.seen, mine: t.mine }, problem, counted, admins: t.admins };
}

/** Changing an event the owner here added to a signed group. */
async function groupItemEventEdit(ctx, params, id, itemId) {
  return fromGroup(ctx, id, async (g) => {
    if (!g.identity) throw new Error("That isn't an event you added.");
    const info = await groups_.pullGroup(ctx.env, ctx.url.origin, g);
    const item = await groups_.groupCopy(ctx.env, g, itemId, info?.people);
    if (!item?.event || !item.mine || !item.list) throw new Error("That isn't an event you added.");
    return { group: info, item, list: item.list };
  });
}

/** A signed group's event as a calendar file. */
async function groupItemEventFile(ctx, params, id, itemId) {
  return fromGroup(ctx, id, async (g) => {
    const item = g.identity && (await groups_.groupCopy(ctx.env, g, itemId));
    if (!item?.event) throw new Error("That isn't an event.");
    const page = `${ctx.url.origin}/groups/${g.id}/posts/${item.id}`;
    const body = icsFile(item.event, { uid: `${item.id}@${new URL(g.origin).host}`, url: page, about: [item.text, `${g.name}: ${page}`].filter(Boolean).join("\n\n") });
    return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="event.ics"', "Cache-Control": "private, no-store" } });
  });
}


/** A photo in a group's post, among that post's photos, with ✕ going back to where the post was (?back=, on this site). */

/** A group's calendar: events to come, and adding one. */
async function groupCalendar(ctx, params, id) {
  const shown = calendarView(params, ctx.zone);
  return fromGroup(ctx, id, async (g) => {
    // Its events kept here, after asking what's changed (groupcopies.js).
    if (!g.identity) throw new Error("This group is from before signing: only your own posts and comments there are shown, on its page.");
    const info = await groups_.pullGroup(ctx.env, ctx.url.origin, g);
    const events = await groups_.groupEvents(ctx.env, g, info?.people);
    const at = now();
    return { group: info, upcoming: events.filter((p) => finishedAt(p.event) >= at).sort((a, b) => a.event.starts_at - b.event.starts_at),
      past: events.filter((p) => finishedAt(p.event) < at).sort((a, b) => b.event.starts_at - a.event.starts_at), ...calendarShown(shown) };
  });
}

/** Changing an event the owner here added. */

/** An event as a calendar file, to open in the owner's own calendar. */

/** Who's in a group; for its admins, also requests to join, the invite link, and running it. */
async function groupMembers(ctx, params, id) {
  return fromGroup(ctx, id, async (g) => ({
    // Closed, and its 30 days are up: nobody's left to list, and its owner can delete its site (groupsites.js).
    ...(groups.groupGoneHere(g) ? { gone: true, members: [], group: null } : await taggedMembers(ctx, await groups.loadMembers(ctx.env, g))),
    max: maxMembers(ctx.env), connected: ctx.connected,
    // Self-hosted, its data stays on the server until a command removes it (hosting.js).
    deleteCommand: selfHosted(ctx.env) && g.role === "owner" ? serverCommand(`delete-group ${new URL(g.origin).host}`) : null,
    // Where the owner stands with each member, to offer asking them to be friends (connect.js).
    friends: await all(ctx.db, "SELECT id, origin, approved_at, reached_at, invited_as FROM connections WHERE connected_at IS NOT NULL"),
  }));
}

/**
 * A group's members, each marked as the owner here knows them (names.js): "your friend", a friend's new name, or "not
 * your friend Bob" for a look-alike of a friend, the group's owner or an admin.
 */
async function taggedMembers(ctx, data) {
  const members = Array.isArray(data.members) ? data.members : [];
  const owner = members.find((m) => m.role === "owner" && m.person)?.person ?? "";
  const names = new Map(members.filter((m) => m.person).map((m) => [m.person, m.name]));
  const admins = new Set(members.filter((m) => m.role === "admin" && m.person).map((m) => m.person));
  const me = (await ownHost(ctx.env))?.person ?? null;
  const shown = await peopleShown(ctx.db, members.map((m) => m.person), { signed: names, group: { owner, names, admins }, me });
  return { ...data, members: members.map((m) => (m.person && m.person !== me ? { ...m, name: shown.names.get(m.person) ?? m.name, ...shown.tags.get(m.person) } : m)) };
}

/**
 * Every friend's site, with their profile picture where the link their site gave is still good (else null). Pages use
 * it for faces, and to show a site address only beside someone who isn't a friend.
 */
/** Friends as every page knows them: their pictures by site (faces), and who can be mentioned (people: mentions.js). */
async function friendFaces(db) {
  const rows = await all(db, `SELECT origin, name, identity, CASE WHEN avatar_exp > ? THEN avatar_url END AS avatar_url FROM connections
    WHERE approved_at IS NOT NULL ORDER BY name COLLATE NOCASE`, [now()]);
  // Each with their identity (afterwrd 2), which signed posts mention them by.
  return { faces: Object.fromEntries(rows.map((r) => [r.origin, r.avatar_url])),
    people: rows.map((r) => ({ name: r.name, origin: r.origin, ...(r.identity && { person: r.identity }) })) };
}
