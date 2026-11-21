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
import { CHECKPOINT, PAGE, Rules, signHead } from "./lists.js";

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

/** The rules as they stand after a list's entries (this site's own, already checked: their records are only parsed). */
export async function rulesFor(db, list, owner, host) {
  const Kind = rulesKind(list, host);
  const rules = new Kind({ host, list, owner });
  const entries = await listEntries(db, list);
  for (const e of entries) {
    const record = e.sent ? parseRecord(fromB64url(e.sent.record)) : null;
    // A members list's roles are in its records' content.
    const content = record && Kind === MemberRules && e.sent.content ? await contentOf(record, e.sent.content, e.sent.salt) : undefined;
    await rules.add({ fp: e.fp, taken: e.taken, record, byHost: Boolean(e.by_host), head: e.head, content });
  }
  return { rules, entries };
}

/**
 * Takes a record (`sent`: {record, sig, content?, salt?}) onto the list it belongs to, as host `host` ({person, privateKey}:
 * the site's identity and hosting key), at `taken` (now). `lookups` find writers' identities and browser keys
 * (records.js). Returns {entry, receipt} or {refused: why}.
 */
export async function takeRecord(db, { sent, host, lookups, taken = Math.floor(Date.now() / 1000) }) {
  const got = await checkRecord(sent, { ...lookups, at: taken });
  if (!got) return { refused: "That didn't check." };
  if (got.record.host !== host.person) return { refused: "That belongs somewhere else." };
  const list = got.record.kind === "item" ? got.fp : got.record.item;
  return inTurn(list, () => take(db, got, { sent, host, taken, list }));
}

async function take(db, got, { sent, host, taken, list }) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await db.prepare("SELECT owner, n, head, deleted_at FROM lists WHERE id = ?").bind(list).first();
    if (row?.deleted_at) return { refused: "That's been deleted." };
    if (got.record.kind === "item" ? row : !row) return { refused: got.record.kind === "item" ? "duplicate" : "That isn't here." };
    const owner = row ? String(row.owner) : got.record.author;
    const { rules, entries } = row ? await rulesFor(db, list, owner, host.person) : { rules: new Rules({ host: host.person, list, owner }), entries: [] };
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
    // Its owner deleting the whole item: everything on it goes, for good; the list's row stays as a tombstone.
    if (got.record.kind === "delete" && got.record.about === list) {
      const [won] = await db.batch([
        db.prepare("UPDATE lists SET n = ?, head = ?, deleted_at = ? WHERE id = ? AND n = ?").bind(n, head, taken, list, Number(row.n)),
        db.prepare(`DELETE FROM list_pages WHERE list = ? AND ${moved("")}`).bind(list, list, list, head),
        db.prepare(`DELETE FROM checkpoints WHERE list = ? AND ${moved("")}`).bind(list, list, list, head),
      ]);
      if (won.meta.changes === 1) return { entry: { n, fp: got.fp, taken, head }, deleted: true };
      continue;
    }
    // A delete or removal: the record it names keeps only its fingerprint, from now on, everywhere this site sends it.
    if (got.record.kind === "delete" || got.record.kind === "remove") {
      const target = entries.find((e) => e.fp === got.record.about);
      if (target) {
        const targetPage = Math.floor((target.n - 1) / PAGE);
        const source = targetPage === page ? pageEntries : entries.filter((e) => Math.floor((e.n - 1) / PAGE) === targetPage);
        const emptied = source.map((e) => (e.fp === target.fp ? { n: e.n, fp: e.fp, taken: e.taken, head: e.head } : e));
        if (targetPage === page) statements[1] = db.prepare(`INSERT INTO list_pages (list, page, entries) SELECT ?, ?, ? WHERE ${moved("")}
          ON CONFLICT(list, page) DO UPDATE SET entries = excluded.entries`).bind(list, page, JSON.stringify(emptied), list, list, head);
        else statements.push(db.prepare(`UPDATE list_pages SET entries = ? WHERE list = ? AND page = ? AND ${moved("")}`)
          .bind(JSON.stringify(emptied), list, targetPage, list, list, head));
      }
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
 * checkpoint: `checkpoint` is its signed head, and the entries run on from there. null if this site doesn't host it;
 * {deleted: true} if its owner deleted it.
 */
export async function readList(db, list, { host, after = 0 }) {
  const row = await db.prepare("SELECT owner, n, head, deleted_at FROM lists WHERE id = ?").bind(list).first();
  if (!row) return null;
  if (row.deleted_at) return { deleted: true };
  let checkpoint = null;
  if (after === 0 && Number(row.n) > CHECKPOINT) {
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
  ]);
}
