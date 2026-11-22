// Notes waiting to go to other sites, sent a batch at a time by this Durable Object's alarm (and, apart from them, in a
// separate object of this class named "vault", the few secrets the site keeps for automatic updates: auto.js, the vault
// table below): fat notes about signed posts to friends' sites, or, in a group's Worker, to its members' sites (notes.js,
// groupposts.js: POST /_p/notes, signed). One request may only call 50 other sites on Cloudflare's free plan; batches of
// 40, one after another, let a post reach any number of friends. A site that can't be reached is tried again later and
// then given up on; a site that says no (it's disconnected, or doesn't want the note) isn't asked again. Notes hold the
// connection or member, not its address: that's looked up when sending, so a disconnect (or a member leaving) stops
// them at once.
//
// One more object of this class, named "site", holds the site's whole database and answers its requests, right next
// to the data (docs/site-object-plan.md). The other objects reach that database through it (sqlite.js remote).
import { DurableObject } from "cloudflare:workers";
import { handle, HEADERS } from "./app.js";
import { ensureSchema } from "./migrate.js";
import { copyOnce } from "./sitecopy.js";
import { FRONT_HEADER, frontIsNewer, local, oldDatabase, OLDER_CODE, remote, runBatches, runStatements, siteObject, ZONE_HEADER } from "./sqlite.js";
import { measured, scaleTest } from "./timing.js";
import { messagePage } from "./views/pages.js";
import { noteFor } from "./notes.js";
import { sendReceipt } from "./receipts.js";
import { groupNoteFor } from "./groupposts.js";
import { ownHost } from "./items.js";
import { ownOrigin } from "./keys.js";
import { signCall } from "./signedcalls.js";

const BATCH = 40;
const TIMEOUT_MS = 5000;
// Fat notes about signed posts (notes.js): a friend's site that can't be reached is tried again for about two days.
const NOTE_RETRY_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];
const DONE = Number.MAX_SAFE_INTEGER; // a fat note's `due` once everyone's had it (only retries may be left)

export const outbox = (env) => env.OUTBOX.get(env.OUTBOX.idFromName("outbox"));

// Queues there once were: for messages between friends and in groups' chats (gone in 0.47.0); friends to fetch again
// (refreshes, then refresh_queue); notes and invitations to friends' sites before posts were signed (notes, invites:
// gone in step 4e); and notes to groups' members with their keys (member_notes: gone in step 6e). Anything still
// waiting in them goes, unsent.
const GONE = ["messages", "group_messages", "member_messages", "refreshes", "refresh_queue", "notes", "invites", "member_notes"];

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

/**
 * Each fat note's body for its recipient (a friend's connection, or in a group's site a member), and the signed call
 * that sends it: [{known, call?: {url, headers, body}, error?}], in order. `known`: the friend or member is still here
 * (approved); without `call`, there's nothing to send them (what it's about has gone, or they may not see it). What's
 * the same for every recipient of a note is worked out once (notes.js noteFor, groupposts.js groupNoteFor).
 * @param {Env} env @param {{ note: any, connection: number }[]} calls @param {boolean} group
 */
export async function prepareNotes(env, calls, group) {
  const db = env.DB;
  const ids = [...new Set(calls.map((c) => c.connection))];
  const { results } = await db.prepare(group ? `SELECT * FROM group_members WHERE approved_at IS NOT NULL AND identity IS NOT NULL
    AND id IN (SELECT value FROM json_each(?))` : `SELECT * FROM connections WHERE approved_at IS NOT NULL AND connected_at IS NOT NULL
    AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  const rows = new Map(results.map((r) => [Number(r.id), r]));
  const me = await ownHost(env);
  // A group calls its members as its own address; a person's site calls friends as the address the note was made at.
  const groupOrigin = group ? await ownOrigin(db) : null;
  const shared = new Map();
  return Promise.all(calls.map(async ({ note, connection }) => {
    const friend = rows.get(connection);
    if (!friend) return { known: false };
    if (!me) return { known: true, error: "Set up signing first." };
    try {
      const body = group ? await groupNoteFor(env, note, friend, shared) : await noteFor(env, note, friend, shared);
      if (!body) return { known: true };
      const url = `${friend.origin}/_p/notes`;
      const text = JSON.stringify(body);
      const headers = await signCall({ method: "POST", url, body: text, person: me.person, from: group ? groupOrigin : String(note.origin),
        privateKey: me.privateKey });
      return { known: true, call: { url, headers, body: text } };
    } catch (error) {
      return { known: true, error: String(/** @type {any} */ (error)?.message ?? error) };
    }
  }));
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
    // Secrets the site keeps for itself (auto.js), only ever in the object named "vault", never the "outbox" one: the
    // background grant's refresh token, which changes at every use (so it can't be a Worker secret: changing one makes
    // a new version), and the key its own update steps carry. Here rather than in D1, so they're never in an export, a
    // restored database or anything a page reads.
    this.sql.exec("CREATE TABLE IF NOT EXISTS vault (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Fat notes about signed posts (notes.js, afterwrd 2): one row per note, not per recipient. `audience` "friends"
    // goes to every friend in turn (`cursor`: the last connection id sent to); otherwise `recipients` lists them
    // (`cursor`: how many have been sent). A recipient that couldn't be reached gets a row in note_retries.
    // A mention receipt ("receipt": receipts.js) goes to people, not friends: `recipients` lists their identities, and
    // a note_retries row names one by its place in that list.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fat_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, fp TEXT,
      audience TEXT, recipients TEXT, cursor INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS note_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, note INTEGER NOT NULL, connection_id INTEGER NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    )`);
    // Each run asks what's due, and when the next is: by index, not by reading every note and retry waiting (the scale
    // run's busy group had thousands of retries, read whole several times a run).
    this.sql.exec("CREATE INDEX IF NOT EXISTS fat_notes_due ON fat_notes(due)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS note_retries_due ON note_retries(due)");
    // And a run's tidying (fat_notes done with no retry left) looks each note's retries up, not every retry for every note.
    this.sql.exec("CREATE INDEX IF NOT EXISTS note_retries_note ON note_retries(note)");
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

  /**
   * In the "site" object: fat notes' bodies for their recipients ([{note, connection}]), and the signed calls that send
   * them, for the Outbox's run (sendNotes): worked out here, next to the database, in one call (prepareNotes).
   */
  async prepareNotes(calls, group) {
    if (!this.isSite()) throw new Error("Only the site's own object has its database.");
    if (!(await this.ready())) throw new Error("This site is moving to faster storage. Try again in a minute.");
    return prepareNotes(this.env, calls, group);
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

  /** Queues a fat note about a signed post (notes.js): {origin, kind, item, fp?, audience? | recipients?}. */
  async sendNote({ origin, kind, item, fp = null, audience = null, recipients = null }) {
    const at = Date.now();
    this.sql.exec("INSERT INTO fat_notes (origin, kind, item, fp, audience, recipients, due) VALUES (?, ?, ?, ?, ?, ?, ?)",
      origin, kind, item, fp, audience, recipients && JSON.stringify(recipients), at);
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
    room -= await this.sendNotes(room);
    const next = Math.min(...["fat_notes", "note_retries"].map((t) => this.sql.exec(`SELECT MIN(due) AS due FROM ${t} WHERE due < ?`, DONE).one().due ?? Infinity));
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /**
   * Sends up to `limit` fat notes (notes.js): retries that are due first, then the next recipients of each note, oldest
   * note first. Each is built for its recipient and sent in a signed call. Returns how many calls it made.
   */
  async sendNotes(limit) {
    if (limit <= 0) return 0;
    const at = Date.now();
    /** @type {{ note: any, connection: number, retry: any }[]} */
    const calls = [];
    const notes = new Map();
    const noteOf = (id) => {
      if (!notes.has(id)) notes.set(id, this.sql.exec("SELECT * FROM fat_notes WHERE id = ?", id).toArray()[0] ?? null);
      return notes.get(id);
    };
    for (const retry of this.sql.exec("SELECT * FROM note_retries WHERE due <= ? ORDER BY due LIMIT ?", at, limit).toArray()) {
      const note = noteOf(retry.note);
      if (note) calls.push({ note, connection: Number(retry.connection_id), retry });
      else this.sql.exec("DELETE FROM note_retries WHERE id = ?", retry.id);
    }
    for (const note of this.sql.exec("SELECT * FROM fat_notes WHERE due <= ? ORDER BY id", at).toArray()) {
      const room = limit - calls.length;
      if (room <= 0) break;
      notes.set(note.id, note);
      let next = [];
      if (note.audience === "friends" || note.audience === "members") {
        // Every friend, or (a group's @here: groupposts.js) every member who joined with an identity.
        const { results } = await this.env.DB.prepare(note.audience === "friends" ? `SELECT id FROM connections WHERE approved_at IS NOT NULL
          AND connected_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?` : `SELECT id FROM group_members WHERE approved_at IS NOT NULL
          AND identity IS NOT NULL AND id > ? ORDER BY id LIMIT ?`).bind(Number(note.cursor), room).all();
        next = results.map((r) => Number(r.id));
        if (next.length) this.sql.exec("UPDATE fat_notes SET cursor = ? WHERE id = ?", next.at(-1), note.id);
        if (next.length < room) this.sql.exec("UPDATE fat_notes SET due = ? WHERE id = ?", DONE, note.id);
      } else {
        const all = JSON.parse(String(note.recipients ?? "[]"));
        next = all.slice(Number(note.cursor), Number(note.cursor) + room);
        // People, for a receipt: each by its place in the list.
        if (note.kind === "receipt") next = next.map((_, i) => Number(note.cursor) + i);
        this.sql.exec("UPDATE fat_notes SET cursor = ? WHERE id = ?", Number(note.cursor) + next.length, note.id);
        if (Number(note.cursor) + next.length >= all.length) this.sql.exec("UPDATE fat_notes SET due = ? WHERE id = ?", DONE, note.id);
      }
      for (const connection of next) calls.push({ note, connection, retry: null });
    }
    if (!calls.length) return 0;
    // Each note's body for each recipient, and the signed call that sends it, are worked out in the site's object, next
    // to the database, in one call (prepareNotes): every statement run from here is a call into that object, billed as a
    // request, and the scale run's group of 1,000 spent 54,737 a day so. Then they're sent from here.
    const group = Boolean(this.env.GROUP_KEY);
    const toSites = calls.filter((c) => c.note.kind !== "receipt");
    const prepared = toSites.length
      ? await siteObject(this.env).prepareNotes(toSites.map((c) => ({ note: c.note, connection: c.connection })), group) : [];
    const ready = new Map(toSites.map((c, i) => [c, prepared[i]]));
    // What became of each invitation to an event (a new-post note to chosen guests), for its guest list.
    const deliveries = [];
    await Promise.all(calls.map(async (call) => {
      const { note, connection, retry } = call;
      let again = false;
      let delivered = false;
      let known = false; // a friend or member still here to send it to
      if (note.kind === "receipt") {
        try {
          delivered = await sendReceipt(this.env, note, JSON.parse(String(note.recipients))[connection]);
        } catch (error) {
          const status = /** @type {any} */ (error).status;
          again = status === 0 || status >= 500 || status === 429 || status === undefined;
        }
      } else {
        const p = ready.get(call);
        known = Boolean(p?.known);
        if (p?.error) again = true; // couldn't be worked out this time (a moment's trouble): tried again later
        else if (p?.call) {
          try {
            const response = await fetch(p.call.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
              headers: { ...p.call.headers, "Content-Type": "application/json" }, body: p.call.body });
            await response.body?.cancel();
            if (!response.ok) throw Object.assign(new Error(`answered ${response.status}`), { status: response.status });
            delivered = true;
          } catch (error) {
            // Not reached, or busy: tried again later. Anything else won't change by asking again.
            const status = /** @type {any} */ (error).status;
            again = status === 0 || status >= 500 || status === 429 || status === undefined;
          }
        }
      }
      const tries = retry ? Number(retry.tries) + 1 : 0;
      if (!group && note.kind === "item" && note.recipients && known && (delivered || !again || tries >= NOTE_RETRY_SECONDS.length)) {
        deliveries.push(this.env.DB.prepare("UPDATE item_guests SET delivery = ? WHERE item = ? AND connection_id = ?")
          .bind(delivered ? "delivered" : again ? "unreachable" : "refused", note.item, connection));
      }
      if (!again || tries >= NOTE_RETRY_SECONDS.length) {
        if (retry) this.sql.exec("DELETE FROM note_retries WHERE id = ?", retry.id);
      } else if (retry) {
        this.sql.exec("UPDATE note_retries SET tries = ?, due = ? WHERE id = ?", tries, at + NOTE_RETRY_SECONDS[tries] * 1000, retry.id);
      } else {
        this.sql.exec("INSERT INTO note_retries (note, connection_id, tries, due) VALUES (?, ?, 0, ?)", note.id, connection, at + NOTE_RETRY_SECONDS[0] * 1000);
      }
    }));
    if (deliveries.length) await this.env.DB.batch(deliveries);
    // A note sent to everyone, with nobody left to try again, is done with.
    this.sql.exec(`DELETE FROM fat_notes WHERE due = ? AND NOT EXISTS (SELECT 1 FROM note_retries r WHERE r.note = fat_notes.id)`, DONE);
    return calls.length;
  }

}

