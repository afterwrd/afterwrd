// The host's side of lists (afterwrd 2: docs/signed-conversations.md, section 2): taking a record onto an item this
// site hosts, and reading a list back. The rules are lists.js's, the same ones readers check by.
//
// Taking a record: its signatures are checked first, any number at once. Then records for the same list take turns
// (the site's object runs one at a time, so a queue in memory is enough), and each is written with a compare-and-swap:
// the list's head is read, the new entry worked out (its running fingerprint needs code, which a database batch can't
// run part-way), then written in one batch that only goes through if the list is still where it was read. The queue
// stops a crowd of comments retrying each other out; the compare-and-swap is the guarantee if anything else writes
// (a restart, another copy of the code). So two records never get the same number, and none is lost.
import { contentOf, parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { MemberRules } from "./members.js";
import { checkRecord } from "./records.js";
import { CHECKPOINT, GroupRules, listOf, PAGE, Rules, signHead } from "./lists.js";
import { daySecondsNow, LIMITS } from "./limits.js";

const TRIES = 8;
const turns = new Map(); // list -> the last take queued for it

/** Runs `fn` after every take already queued for `list`. */
function inTurn(list, fn) {
  const before = turns.get(list) ?? Promise.resolve();
  const mine = before.then(fn, fn);
  const settled = mine.catch(() => {});
  turns.set(list, settled);
  settled.then(() => { if (turns.get(list) === settled) turns.delete(list); });
  return mine;
}

/** A list's entries, in order, from its pages (`after`: only those after that number). */
export async function listEntries(db, list, after = 0) {
  const { results } = await db.prepare("SELECT entries FROM list_pages WHERE list = ? AND page >= ? ORDER BY page")
    .bind(list, Math.floor(after / PAGE)).all();
  return results.flatMap((r) => JSON.parse(String(r.entries))).filter((e) => e.n > after);
}

/** The rules a list follows: a group's members list (its id is the group's own: members.js), or an item's. */
export const rulesKind = (list, host) => (list === host ? MemberRules : Rules);

/**
 * The rules as they stand after a list's entries (this site's own, already checked: their records are only parsed).
 * `group`: on a group's site, a post's (lists.js GroupRules).
 */
export async function rulesFor(db, list, owner, host, group = null) {
  const Kind = rulesKind(list, host);
  const rules = group && Kind !== MemberRules ? new GroupRules({ host, list, owner, group }) : new Kind({ host, list, owner });
  const entries = await listEntries(db, list);
  for (const e of entries) {
    const record = e.sent ? parseRecord(fromB64url(e.sent.record)) : null;
    // A members list's roles are in its records' content.
    const content = record && Kind === MemberRules && e.sent.content ? await contentOf(record, e.sent.content, e.sent.salt) : undefined;
    await rules.add({ fp: e.fp, taken: e.taken, record, byHost: Boolean(e.by_host), head: e.head, content });
  }
  return { rules, entries };
}


// Records that never count towards a writer's daily cap: taking back what's theirs, and an admin's clear-up (removing,
// calling off), which mustn't stop half way.
const UNCOUNTED = new Set(["delete", "leave", "remove", "calloff"]);

/**
 * Whether `author` has already left LIMITS.records records here in the last day, across every post (step 8: on top of
 * 20 an item), so `kind` is refused. One count from the `authored` index (step 7), which has the writer and when. A
 * group's members list (`members`: joins, approvals, roles) isn't counted: letting people in mustn't use up posting.
 * @param {D1Database} db @param {string} author @param {string} kind @param {string} [members]
 */
export async function overDailyRecords(db, author, kind, members = "") {
  if (UNCOUNTED.has(kind)) return false;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM authored WHERE author = ? AND taken > ? AND list != ?")
    .bind(author, Math.floor(Date.now() / 1000) - daySecondsNow(), members).first();
  return Number(row?.n ?? 0) >= LIMITS.records;
}
export const DAILY_RECORDS_SAID = "That's a lot for one day here. Try again tomorrow.";
const OPEN_WHILE_FROZEN = new Set(["delete", "remove", "close"]);
export const COMMENTS_OFF_SAID = "Comments are turned off on this post.";
/**
 * Why something on an item brought over from afterwrd 1 is refused for now: what was said on it before is still coming
 * (`until`: when it's in at the latest), or due in now (`at` past it: before.js puts it in at the next chance).
 */
export const frozenSaid = (until, at = Math.floor(Date.now() / 1000)) => (until > at
  ? `What was said here before afterwrd 2 is being brought over, until ${new Date(until * 1000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })} at the latest. You can add to it once that's in.`
  : "What was said here before afterwrd 2 is nearly in. Try again in a few minutes.");
/**
 * Takes a record (`sent`: {record, sig, content?, salt?}) onto the list it belongs to, as host `host` ({person, privateKey}:
 * the site's identity and hosting key), at `taken` (now). `lookups` find writers' identities and browser keys
 * (records.js). A record for one date of a repeating event (lists.js dateList) starts that date's list if it's the first:
 * `owner` is then the event's writer (the caller has checked the event is here, and has that date). `bringing`: it's
 * being brought over from afterwrd 1 (before.js), which alone may say when it was first written (`before`), and may
 * comment on an item brought over while it waits for its old comments. Returns {entry, receipt} or {refused: why}.
 */
export async function takeRecord(db, { sent, host, lookups, taken = Math.floor(Date.now() / 1000), group = null, owner = null, bringing = false }) {
  const got = await checkRecord(sent, { ...lookups, at: taken });
  if (!got) return { refused: "That didn't check." };
  if (got.record.host !== host.person) return { refused: "That belongs somewhere else." };
  if (got.record.before !== undefined && !bringing) return { refused: "Only what's brought over from before afterwrd 2 can say it was written earlier." };
  // An item brought over from afterwrd 1 takes nothing new until the comments made on it before are in (step 10), so
  // they go in first, in the order they were written, and each writer's chain (prev) runs on from there. Deleting,
  // removing and closing still go through.
  // Comments turned off on it (docs/safety-plan.md 3.1): none from anyone but its writer, who may still have the last
  // word. Edits and deletes of what's there, and votes and answers, carry on.
  if (!bringing && got.record.kind !== "item" && !OPEN_WHILE_FROZEN.has(got.record.kind)) {
    const row = await db.prepare("SELECT author, before_until, comments_off_at FROM items WHERE id = ?").bind(got.record.item).first();
    if (row?.before_until !== null && row?.before_until !== undefined) return { refused: frozenSaid(Number(row.before_until), taken) };
    if (got.record.kind === "comment" && row?.comments_off_at !== null && row?.comments_off_at !== undefined && got.record.author !== String(row.author)) {
      return { refused: COMMENTS_OFF_SAID };
    }
  }
  const list = listOf(got.record, got.fp);
  return inTurn(list, () => take(db, got, { sent, host, taken, list, group, dateOwner: got.record.date ? owner : null }));
}

async function take(db, got, { sent, host, taken, list, group, dateOwner }) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await db.prepare("SELECT owner, n, head, deleted_at FROM lists WHERE id = ?").bind(list).first();
    if (row?.deleted_at) return { refused: "That's been deleted." };
    const starts = got.record.kind === "item" || Boolean(dateOwner);
    if (got.record.kind === "item" ? row : !row && !starts) return { refused: got.record.kind === "item" ? "duplicate" : "That isn't here." };
    const owner = row ? String(row.owner) : dateOwner ?? got.record.author;
    const { rules, entries } = row ? await rulesFor(db, list, owner, host.person, group)
      : { rules: group ? new GroupRules({ host: host.person, list, owner, group }) : new Rules({ host: host.person, list, owner }), entries: [] };
    const why = rules.refuse(got, taken);
    if (why) return { refused: why };
    const head = await rules.add({ fp: got.fp, taken, record: got.record, byHost: got.byHost, content: got.content });
    const n = rules.n;
    const entry = { n, fp: got.fp, taken, head, sent, ...(got.byHost ? { by_host: 1 } : {}) };
    const page = Math.floor((n - 1) / PAGE);
    const pageEntries = [...entries.filter((e) => Math.floor((e.n - 1) / PAGE) === page), entry];
    // Only if the list is still where it was read: the first statement says whether this one won.
    const moved = (sqlCondition) => `(SELECT n FROM lists WHERE id = ?) = ${n} AND (SELECT head FROM lists WHERE id = ?) = ?${sqlCondition}`;
    const statements = [
      row ? db.prepare("UPDATE lists SET n = ?, head = ? WHERE id = ? AND n = ?").bind(n, head, list, Number(row.n))
        : db.prepare("INSERT OR IGNORE INTO lists (id, owner, n, head, created_at) VALUES (?, ?, ?, ?, ?)").bind(list, owner, n, head, taken),
      db.prepare(`INSERT INTO list_pages (list, page, entries) SELECT ?, ?, ? WHERE ${moved("")}
        ON CONFLICT(list, page) DO UPDATE SET entries = excluded.entries`).bind(list, page, JSON.stringify(pageEntries), list, list, head),
    ];
    // Its owner deleting the whole item (or, in a group, an admin removing it): everything on it goes, for good; the
    // list's row stays as a tombstone.
    if ((got.record.kind === "delete" || got.record.kind === "remove") && got.record.about === list) {
      const [won] = await db.batch([
        db.prepare("UPDATE lists SET n = ?, head = ?, deleted_at = ? WHERE id = ? AND n = ?").bind(n, head, taken, list, Number(row.n)),
        db.prepare(`DELETE FROM list_pages WHERE list = ? AND ${moved("")}`).bind(list, list, list, head),
        db.prepare(`DELETE FROM checkpoints WHERE list = ? AND ${moved("")}`).bind(list, list, list, head),
        db.prepare(`DELETE FROM authored WHERE list = ? AND ${moved("")}`).bind(list, list, list, head),
      ]);
      if (won.meta.changes === 1) {
        // Its words, and any comments' on it, out of Notifications too (security review 2026-11 L16).
        await db.prepare("UPDATE notices SET text = NULL WHERE item = ? AND text IS NOT NULL").bind(list).run();
        return { entry: { n, fp: got.fp, taken, head }, deleted: true, removed: got.record.kind === "remove" };
      }
      continue;
    }
    // A delete or removal: the record it names keeps only its fingerprint, from now on, everywhere this site sends it.
    // Not on a group's members list (its id is the host's own), where removing someone is about their `join`, which
    // stays: without it nobody could check the list (who was let in, or removed) again.
    if ((got.record.kind === "delete" || got.record.kind === "remove") && list !== host.person) {
      const target = entries.find((e) => e.fp === got.record.about);
      if (target) {
        const targetPage = Math.floor((target.n - 1) / PAGE);
        const source = targetPage === page ? pageEntries : entries.filter((e) => Math.floor((e.n - 1) / PAGE) === targetPage);
        // Keeping which entry emptied it (`by`, `by_n`), so its writer's site, asking what became of it, is shown the
        // signed delete or removal from the same row (sentchecks.js).
        const emptied = source.map((e) => (e.fp === target.fp ? { n: e.n, fp: e.fp, taken: e.taken, head: e.head, by: got.fp, by_n: n } : e));
        if (targetPage === page) statements[1] = db.prepare(`INSERT INTO list_pages (list, page, entries) SELECT ?, ?, ? WHERE ${moved("")}
          ON CONFLICT(list, page) DO UPDATE SET entries = excluded.entries`).bind(list, page, JSON.stringify(emptied), list, list, head);
        else statements.push(db.prepare(`UPDATE list_pages SET entries = ? WHERE list = ? AND page = ? AND ${moved("")}`)
          .bind(JSON.stringify(emptied), list, targetPage, list, list, head));
        // Nothing kept says whose it was (decision 7): only where it was, for its writer's check.
        statements.push(db.prepare(`UPDATE authored SET author = NULL WHERE fp = ? AND ${moved("")}`).bind(target.fp, list, list, head));
        // …and its words go from Notifications too, as from the conversation (security review 2026-11 L16).
        statements.push(db.prepare("UPDATE notices SET text = NULL WHERE fp = ? AND text IS NOT NULL").bind(target.fp));
      }
    }
    // Indexed by fingerprint and writer (sentchecks.js): not the owner's own records on their own site.
    if (got.record.author !== host.person) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO authored (fp, author, list, n, taken) SELECT ?, ?, ?, ?, ? WHERE ${moved("")}`)
        .bind(got.fp, got.record.author, list, n, taken, list, list, head));
    }
    const receipt = await signHead(host.privateKey, { host: host.person, list, n, head });
    if (n % CHECKPOINT === 0) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO checkpoints (list, n, signed) SELECT ?, ?, ? WHERE ${moved("")}`)
        .bind(list, n, JSON.stringify(receipt), list, list, head));
    }
    const [won] = await db.batch(statements);
    if (won.meta.changes === 1) return { entry, receipt };
  }
  return { refused: "This is busy. Try again." };
}

/**
 * A list as readers fetch it: its entries after `after` (all of them by default), and the host's signature on its
 * end now. A reader with nothing checked yet (`after` 0) of a list longer than CHECKPOINT starts from the newest
 * checkpoint: `checkpoint` is its signed head, and the entries run on from there; unless it's `whole`, a group's
 * members list, which can only be checked from its start (who's in follows from every join and approval). null if this site doesn't host it;
 * {deleted: true} if its owner deleted it.
 */
export async function readList(db, list, { host, after = 0, whole = false }) {
  const row = await db.prepare("SELECT owner, n, head, deleted_at FROM lists WHERE id = ?").bind(list).first();
  if (!row) return null;
  if (row.deleted_at) return { deleted: true };
  let checkpoint = null;
  if (after === 0 && !whole && Number(row.n) > CHECKPOINT) {
    const cp = await db.prepare("SELECT n, signed FROM checkpoints WHERE list = ? ORDER BY n DESC LIMIT 1").bind(list).first();
    if (cp) { checkpoint = JSON.parse(String(cp.signed)); after = Number(cp.n); }
  }
  const entries = await listEntries(db, list, after);
  return { owner: String(row.owner), entries, checkpoint,
    signedHead: await signHead(host.privateKey, { host: host.person, list, n: Number(row.n), head: String(row.head) }) };
}

/**
 * Deletes a list this site hosts along with the item it belongs to: a photo in a post its owner deleted (items.js),
 * whose delete covers it. Everything on it goes; its row stays as a tombstone, as a delete leaves one.
 */
export async function tombstone(db, list, at = Math.floor(Date.now() / 1000)) {
  await db.batch([
    db.prepare("UPDATE lists SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(at, list),
    db.prepare("DELETE FROM list_pages WHERE list = ?").bind(list),
    db.prepare("DELETE FROM checkpoints WHERE list = ?").bind(list),
    db.prepare("DELETE FROM authored WHERE list = ?").bind(list),
  ]);
}

/**
 * Deletes the lists of a repeating event's dates (lists.js dateList) along with the event: everything on them goes, and
 * their rows stay as tombstones. By range ("<item>/" up to "<item>0": "/" comes just before "0"), not LIKE, whose "_"
 * would match any character in an id.
 */
export async function tombstoneDates(db, item, at = Math.floor(Date.now() / 1000)) {
  const [lo, hi] = [`${item}/`, `${item}0`];
  await db.batch([
    db.prepare("UPDATE lists SET deleted_at = ? WHERE id > ? AND id < ? AND deleted_at IS NULL").bind(at, lo, hi),
    db.prepare("DELETE FROM list_pages WHERE list > ? AND list < ?").bind(lo, hi),
    db.prepare("DELETE FROM checkpoints WHERE list > ? AND list < ?").bind(lo, hi),
    db.prepare("DELETE FROM authored WHERE list > ? AND list < ?").bind(lo, hi),
  ]);
}
