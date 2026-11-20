// Notes waiting to go to other sites (notify.js), sent a batch at a time by this Durable Object's alarm (and, apart
// from them, in a separate object of this class named "vault", the few secrets the site keeps for automatic updates:
// auto.js, the vault table below): to friends'
// sites (POST /_peer/notify) and, in a group's Worker, to its members' sites (POST /_member/notify). One request
// may only call 50 other sites on Cloudflare's free plan; batches of 40, one after another, let a post reach any
// number of friends. A site that can't be reached is tried again later (after 1, 5 and 30 minutes, then 2 and 6
// hours) and then given up on; a site that says no (it's disconnected, or doesn't want the note) isn't asked again.
// Notes hold the connection or member, not its key: the key is looked up in D1 when sending, so a disconnect (or a
// member leaving) stops them at once. The same alarm also fetches friends' newest posts again for Home, with whatever
// calls the notes leave (feed.js refreshCopies).
//
// One more object of this class, named "site", holds the site's whole database and answers its requests, right next
// to the data (docs/site-object-plan.md). The other objects reach that database through it (sqlite.js remote).
import { DurableObject } from "cloudflare:workers";
import { handle, HEADERS } from "./app.js";
import { refreshCopies } from "./feed.js";
import { ensureSchema } from "./migrate.js";
import { copyOnce } from "./sitecopy.js";
import { FRONT_HEADER, frontIsNewer, local, oldDatabase, OLDER_CODE, remote, runBatches, runStatements, ZONE_HEADER } from "./sqlite.js";
import { measured, scaleTest } from "./timing.js";
import { messagePage } from "./views/pages.js";

const BATCH = 40;
const TIMEOUT_MS = 5000;
const RETRY_SECONDS = [60, 300, 1800, 7200, 21600];

export const outbox = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("outbox"));

// Who each kind of note goes to: its table here, how to find their site and key in D1, and where to send it.
const FRIENDS = "SELECT id, origin, their_key FROM connections WHERE approved_at IS NOT NULL AND id IN";
const MEMBERS = "SELECT id, origin, their_key FROM group_members WHERE approved_at IS NOT NULL AND id IN";
const KINDS = {
  // Invitations to the owner's events (events.js): what becomes of each is kept with whoever it's for (post_audience).
  invites: { column: "connection_id", more: "post_id INTEGER NOT NULL,", path: "/_peer/notify", sql: FRIENDS, invite: true },
  notes: { column: "connection_id", path: "/_peer/notify", sql: FRIENDS },
  member_notes: { column: "member_id", path: "/_member/notify", sql: MEMBERS },
};
// Queues there once were, for messages between friends and in groups' chats (gone in 0.47.0), and friends to fetch
// again a row each (refreshes, until 0.59: now refresh_queue): anything still waiting in them goes, unsent (a refresh
// is asked for again the next time Home opens).
const GONE = ["messages", "group_messages", "member_messages", "refreshes"];

/** While the site's database is being moved into its object (sitecopy.js): a page or a JSON error, and nothing done. */
function moving(request) {
  const message = "This site is moving to faster storage. Try again in a minute.";
  const headers = { ...HEADERS, "Retry-After": "60", "Cache-Control": "no-store" };
  if ((request.headers.get("Accept") ?? "").includes("text/html")) {
    return new Response(messagePage(message, { href: "/", label: "Try again" }), {
      status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return new Response(JSON.stringify({ error: message }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
}

export class Outbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    scaleTest(this, env, ctx.id.name);
    // The site's own object keeps only the site's tables (migrate.js makes them), and its env.DB is them. The database
    // the site used before is copied in once (sitecopy.js), and kept here only for that.
    if (ctx.id.name === "site") {
      this.old = oldDatabase(env);
      this.env = { ...env, DB: local(ctx.storage) };
      return;
    }
    // Every other object reaches the site's database in the site's object. Its calls to other objects are counted, as
    // a request's are (timing.js): only scale tests do anything with the count here.
    const counted = measured(env);
    this.env = { ...counted, DB: remote(counted) };
    for (const table of GONE) this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const [table, { column, more = "" }] of Object.entries(KINDS)) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ${column} INTEGER NOT NULL, ${more} body TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
      )`);
    }
    // Secrets the site keeps for itself (auto.js), only ever in the object named "vault", never the "outbox" one: the
    // background grant's refresh token, which changes at every use (so it can't be a Worker secret: changing one makes
    // a new version), and the key its own update steps carry. Here rather than in D1, so they're never in an export, a
    // restored database or anything a page reads.
    this.sql.exec("CREATE TABLE IF NOT EXISTS vault (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Friends whose newest posts are to be fetched again for Home (feed.js refreshCopies), each once however often asked,
    // in the order asked: one row, the list of them. A row for each friend was two rows written for every friend each
    // time Home opened (queued, then taken): with hundreds of friends, a good share of a day's writes.
    this.sql.exec("CREATE TABLE IF NOT EXISTS refresh_queue (id INTEGER PRIMARY KEY CHECK (id = 1), ids TEXT NOT NULL)");
  }

  /**
   * In the "site" object: one request to the site, handed on by the Worker (index.js) and answered here with the
   * database next to it (app.js). The visitor's time zone comes in ZONE_HEADER, and the Worker's version in
   * FRONT_HEADER, both always set by the Worker.
   */
  async fetch(request) {
    if (!this.isSite()) return new Response("Not found", { status: 404 });
    // Running older code than the Worker in front (an update has just gone live): restart, so the Worker's asking
    // again finds this object running the same version as itself (sqlite.js FRONT_HEADER).
    if (frontIsNewer(request.headers.get(FRONT_HEADER), this.env.VERSION)) this.ctx.abort(OLDER_CODE);
    if (!(await this.ready())) return moving(request);
    const zone = request.headers.get(ZONE_HEADER) ?? "";
    const headers = new Headers(request.headers);
    headers.delete(ZONE_HEADER);
    headers.delete(FRONT_HEADER);
    return handle(new Request(request, { headers, cf: zone ? { timezone: zone } : {} }), this.env,
      { waitUntil: (promise) => this.ctx.waitUntil(promise) });
  }

  /** In the "site" object: statements from another object or the Worker, run on the database here (sqlite.js remote). */
  async query(statements, together) {
    if (!this.isSite()) throw new Error("Only the site's own object has its database.");
    if (!(await this.ready())) throw new Error("This site is moving to faster storage. Try again in a minute.");
    return runStatements(this.ctx.storage, statements, together);
  }

  /** In the "site" object: several batches from another object, each its own transaction (sqlite.js batches). */
  async queryBatches(batches) {
    if (!this.isSite()) throw new Error("Only the site's own object has its database.");
    if (!(await this.ready())) throw new Error("This site is moving to faster storage. Try again in a minute.");
    return runBatches(this.ctx.storage, batches);
  }

  /** Whether this is the site's own object (the others are the outbox and the vault). */
  isSite() {
    return this.ctx.id.name === "site";
  }

  /**
   * In the "site" object: whether its database is ready, having copied in the one the site used before if it hasn't
   * yet (sitecopy.js). Everything else waits while it copies. A copy that can't finish this time says why, and the
   * next request tries again.
   */
  async ready() {
    if (!this.isSite()) return false;
    this.copying ??= this.ctx.blockConcurrencyWhile(async () => {
      try {
        await copyOnce(this.ctx.storage, this.old);
      } catch (error) {
        console.error("Moving the database:", error.message);
        return false;
      }
      // The tables, before anything is answered (migrate.js), so no request finds them half-made. If a migration
      // fails, the request that follows says so as it always has (app.js), rather than "moving".
      await ensureSchema(this.env).catch(() => {});
      return true;
    });
    const done = await this.copying;
    if (!done) this.copying = null;
    return done;
  }

  /** The friends waiting to have their posts fetched again (refresh_queue), oldest first. */
  queued() {
    const row = this.sql.exec("SELECT ids FROM refresh_queue WHERE id = 1").toArray()[0];
    return row ? /** @type {number[]} */ (JSON.parse(String(row.ids))) : [];
  }

  /** Sets the friends waiting to have their posts fetched again: one row written. */
  setQueued(ids) {
    if (ids.length) this.sql.exec("INSERT INTO refresh_queue (id, ids) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET ids = excluded.ids", JSON.stringify(ids));
    else this.sql.exec("DELETE FROM refresh_queue WHERE id = 1");
  }

  /** Has these friends' newest posts fetched again soon, in the background, for Home (feed.js). */
  async refresh(connectionIds) {
    const waiting = this.queued();
    const have = new Set(waiting);
    const more = [...new Set(connectionIds.map(Number))].filter((id) => Number.isSafeInteger(id) && !have.has(id));
    if (more.length) this.setQueued([...waiting, ...more]);
    await this.wake(Date.now());
  }

  /** A secret kept here (auto.js), or null. */
  secret(name) {
    return this.sql.exec("SELECT value FROM vault WHERE name = ?", name).toArray()[0]?.value ?? null;
  }

  /** Keeps a secret here, replacing any of that name; null deletes it. */
  keepSecret(name, value) {
    if (value === null) this.sql.exec("DELETE FROM vault WHERE name = ?", name);
    else this.sql.exec("INSERT INTO vault (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);
  }

  /**
   * In the vault: "Install it now" (auto.js). The alarm asks the site's own address to run the automatic update, and
   * waits for it, so the run belongs to this object (which has up to 15 minutes), not to the owner's page.
   */
  async runSoon(origin) {
    this.keepSecret("run_now", origin);
    await this.wake(Date.now());
  }

  /** Queues `body` for each connection id (friends' sites), and sees that the alarm will send it. */
  send(connectionIds, body) {
    return this.queue("notes", connectionIds, body);
  }

  /** Queues an invitation to the event in post `postId` (events.js) for each connection id, noting what becomes of it. */
  async sendInvites(connectionIds, postId, body) {
    const text = JSON.stringify(body);
    const at = Date.now();
    for (const id of connectionIds) this.sql.exec("INSERT INTO invites (connection_id, post_id, body, due) VALUES (?, ?, ?, ?)", id, postId, text, at);
    await this.wake(at);
  }

  /** Queues `body` for each group member id (in a group's Worker, members' sites). */
  sendToMembers(memberIds, body) {
    return this.queue("member_notes", memberIds, body);
  }

  async queue(table, ids, body) {
    const text = JSON.stringify(body);
    const at = Date.now();
    for (const id of ids) this.sql.exec(`INSERT INTO ${table} (${KINDS[table].column}, body, due) VALUES (?, ?, ?)`, id, text, at);
    await this.wake(at);
  }

  /** Sees that the alarm goes off by `at`, even if it was set for later (a retry hours away). */
  async wake(at) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const origin = this.secret("run_now");
    if (origin) {
      this.keepSecret("run_now", null);
      const key = this.secret("auto_key");
      if (key) {
        await fetch(`${origin}/_auto/step`, { method: "POST", redirect: "manual",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ step: "run-now" }) })
          .then((r) => r.body?.cancel()).catch((error) => console.error("Install it now:", error.message));
      }
    }
    let room = BATCH;
    for (const table of Object.keys(KINDS)) room -= await this.sendDue(table, room);
    // Then, with the calls left, friends' posts to fetch again (notes first: they're what tells friends' sites).
    // A refresh is due from when it was asked for (refresh()): the oldest first, as many as there's room for. The rest
    // stay waiting, written back before fetching, so anything asked for meanwhile joins them.
    let waiting = Infinity;
    if (room > 0) {
      const all = this.queued();
      const ids = all.slice(0, room);
      if (ids.length) {
        this.setQueued(all.slice(room));
        await refreshCopies(this.env, ids).catch((error) => console.error("Refreshing friends' posts:", error.message));
      }
    }
    if (this.queued().length) waiting = Date.now();
    const next = Math.min(waiting, ...Object.keys(KINDS).map((t) => this.sql.exec(`SELECT MIN(due) AS due FROM ${t}`).one().due ?? Infinity));
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /** Sends up to `limit` notes from `table` that are due; returns how many it tried. */
  async sendDue(table, limit) {
    if (limit <= 0) return 0;
    const { column, path, sql } = KINDS[table];
    const at = Date.now();
    const due = this.sql.exec(`SELECT * FROM ${table} WHERE due <= ? ORDER BY id LIMIT ?`, at, limit).toArray();
    const ids = [...new Set(due.map((n) => n[column]))];
    const { results } = ids.length ? await this.env.DB.prepare(`${sql} (${ids.map(() => "?").join(",")})`).bind(...ids).all() : { results: [] };
    const recipients = new Map(results.map((c) => /** @type {[any, any]} */ ([c.id, c])));
    // An invitation taken back since (or whose event has gone) isn't sent: only those still invited are.
    const invited = !KINDS[table].invite || !due.length ? null : new Set((await this.env.DB.prepare(
      `SELECT post_id || ':' || connection_id AS k FROM post_audience WHERE post_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify([...new Set(due.map((n) => n.post_id))])).all()).results.map((r) => r.k));

    // What became of each invitation, saved together at the end: one call to the site's object, not one each.
    const deliveries = [];
    await Promise.all(due.map(async (note) => {
      if (invited && !invited.has(`${note.post_id}:${note.connection_id}`)) {
        this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, note.id);
        return;
      }
      const to = recipients.get(note[column]);
      let delivered = false;
      let again = Boolean(to);
      if (to) {
        try {
          const response = await fetch(`${to.origin}${path}`, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Authorization: `Bearer ${to.their_key}`, "Content-Type": "application/json" }, body: note.body,
          });
          await response.body?.cancel();
          delivered = response.ok;
          again = response.status >= 500 || response.status === 429; // anything else won't change by asking again
        } catch {} // unreachable: try again later
      }
      const finished = delivered || !again || note.tries >= RETRY_SECONDS.length;
      if (finished) this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, note.id);
      else this.sql.exec(`UPDATE ${table} SET tries = tries + 1, due = ? WHERE id = ?`, at + RETRY_SECONDS[note.tries] * 1000, note.id);
      if (KINDS[table].invite && finished) {
        deliveries.push(this.env.DB.prepare("UPDATE post_audience SET delivery = ? WHERE post_id = ? AND connection_id = ?")
          .bind(delivered ? "delivered" : again ? "unreachable" : "refused", note.post_id, note.connection_id));
      }
    }));
    if (deliveries.length) await this.env.DB.batch(deliveries);
    return due.length;
  }
}

