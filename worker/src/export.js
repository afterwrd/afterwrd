// Download everything: the owner's whole site as a zip of ActivityStreams documents plus every photo and video,
// built in the browser (public/static/export/main.js) so size and the free plan's limits don't matter. This
// side only hands over rows, a page at a time:
//   GET /_admin/export                         the page
//   GET /_admin/export/rows?table=<t>&after=<n>  up to 1000 rows of one table, after rowid n
//   GET /_admin/export/about                   which site and database version the download comes from
// Keys and anything to do with signing in never leave: connections give only who and where, users only names.
// The rows also go into the zip as they are (site/), so another afterwrd site can take them in (move.js).
import pkg from "../package.json";
import { DATABASE } from "./migrate.js";
import { html, json, pageData } from "./util.js";
import { headerMe } from "./photos.js";
import { exportPage } from "./views/export.js";

const PAGE = 1000;
/** A post's own columns, as Download everything gives them and a move takes them in. */
export const POST_COLUMNS = "id, key, source, created_at, kind, title, text, target_id, group_name, link_url, place_name, "
  + "place_address, latitude, longitude, fbid, edited_at, audience, mentions";

export const TABLES = {
  // The rest of settings are the site's own keys.
  settings: { columns: "key, value", where: "key IN ('sections', 'profile_hash', 'cover_hash')" },
  // Posts, photos and albums, made on afterwrd and from the Facebook download (`source` says which).
  albums: { columns: "*" },
  // Not changed_at: when friends' sites were last told about a change (migrations/0025), which means nothing elsewhere.
  posts: { columns: POST_COLUMNS },
  media: { columns: "*" },
  // Facebook's record of the owner's life there.
  facebook_people: { columns: "*" },
  facebook_post_tags: { columns: "*" },
  facebook_comments: { columns: "*" },
  facebook_reactions: { columns: "*" },
  facebook_tagged_photos: { columns: "*" },
  // Comments here, and the owner's on friends' sites.
  comments: { columns: "*" },
  comments_elsewhere: { columns: "*" },
  // Polls in the owner's posts, and who answered: the owner's own records.
  polls: { columns: "*" },
  poll_votes: { columns: "post_id, voter, name, choices, voted_at" },
  // The owner's events, who they're shared with and their answers; and events from elsewhere on their calendar.
  events: { columns: "*" },
  event_answers: { columns: "*" },
  post_audience: { columns: "*" },
  events_elsewhere: { columns: "*" },
  // What edited posts and comments said before (edits.js).
  post_versions: { columns: "*" },
  comment_versions: { columns: "*" },
  comments_elsewhere_versions: { columns: "*" },
  connections: { columns: "id, origin, name, created_at, connected_at, approved_at, identity", where: "approved_at IS NOT NULL" },
  // afterwrd 2: the owner's signed posts and photos, the lists that prove what happened on them, what they've signed
  // and sent to friends' posts, and their identity (public anyway). No private keys: those never leave a device or site.
  items: { columns: "*" },
  item_photos: { columns: "*" },
  // Who's invited to the owner's signed events, and whose invitation was taken back (step 4d).
  item_guests: { columns: "*" },
  item_uninvited: { columns: "*" },
  lists: { columns: "*" },
  list_pages: { columns: "*" },
  sent: { columns: "*" },
  own_identity: { columns: "person, chain" },
  // The browser keys behind everything signed here (public halves, and what allowed them), and the identities of
  // everyone who wrote any of it, so the download can be checked, and a site it moves to can check it (move.js).
  known_delegations: { columns: "*" },
  identities: { columns: "person, chain, profile" },
  // Groups: which, and what the owner posted and said in them. No keys.
  groups: { columns: "id, name, about, origin, remote_id, host_name, joined_at, role", where: "joined_at IS NOT NULL" },
  group_mine: { columns: "*" },
  friend_links: { columns: "connection_id, person_name" },
  users: { columns: "id, name" },
};

export async function handleExport(request, env, url, owner) {
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  if (url.pathname === "/_admin/export") return html(exportPage(pageData(env, { me: await headerMe(env.DB, owner) })));
  if (url.pathname === "/_admin/export/about") {
    // signed: how many signed posts and photos it has (afterwrd 2), which a move can't take yet (move.js).
    const signed = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first())?.n ?? 0);
    // person: whose identity this site holds. A download that has one moves only with it (move.js, movein.js).
    const own = await env.DB.prepare("SELECT person FROM own_identity WHERE id = 1").first();
    return json({ format: 1, site: url.origin, version: pkg.version, database: DATABASE, tables: Object.keys(TABLES), signed,
      ...(own ? { person: String(own.person) } : {}) });
  }
  if (url.pathname === "/_admin/export/rows") {
    const table = url.searchParams.get("table");
    if (!Object.hasOwn(TABLES, table)) return json({ error: "Unknown table." }, 400);
    const { columns, where } = TABLES[table];
    const after = Number.parseInt(url.searchParams.get("after"), 10) || 0;
    const { results } = await env.DB.prepare(`SELECT rowid AS _rowid, ${columns} FROM ${table}
      WHERE rowid > ? ${where ? `AND ${where}` : ""} ORDER BY rowid LIMIT ?`).bind(after, PAGE).all();
    return json({ rows: results, next: results.length === PAGE ? results.at(-1)._rowid : null });
  }
  return new Response("Not found", { status: 404 });
}
