// Conversations as this site checked them (afterwrd 2, step 9, option 3A: docs/signed-conversations.md), kept so that
// opening one again asks its host only for what's after the point checked last (copies.checked_n), and checks only
// that. Without this, every open fetched and checked the whole conversation: in the scale run, a 1,000-vote poll read
// 3,619 rows on the group's site for each open, and each open on a member's site re-checked every entry.
//
// What's kept is each entry as checked (lists.js checkList: its state, record and words, who wrote it, its running
// fingerprint), never anything taken on the host's word. A delete or removal that arrives later throws away the words
// it's about here too, as the host does. If what's new doesn't follow on from the point checked, the reader reads the
// whole conversation again, as before (friendcopies.js friendThread, groupcopies.js groupThread), and says if it's
// changed. The kept entries go with their copy (a trigger: migration 0044).
import { PAGE } from "./lists.js";

/** What's kept of each entry. */
const KEPT = ["n", "fp", "taken", "head", "state", "record", "content", "by", "byHost", "removedBy", "removedByAdmin"];
const keep = (e) => Object.fromEntries(KEPT.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));

/**
 * The entries of `list` this site checked, up to `n` (whose running fingerprint was `head`), as checked; null unless
 * it has them all, from the first or a checkpoint, without a gap.
 * @param {D1Database} db @param {string} list @param {number} n @param {string} head
 */
export async function keptThread(db, list, n, head) {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const { results } = await db.prepare("SELECT entries FROM thread_cache WHERE list = ? ORDER BY page").bind(list).all();
  const entries = results.flatMap((r) => JSON.parse(String(r.entries)));
  if (!entries.length || entries.at(-1).n !== n || entries.at(-1).head !== head) return null;
  for (let i = 1; i < entries.length; i++) if (entries[i].n !== entries[i - 1].n + 1) return null;
  return entries;
}

/** All the entries of `list` this site keeps, from its first, without a gap; null if it keeps none or they've a gap. */
export async function keptList(db, list) {
  const { results } = await db.prepare("SELECT entries FROM thread_cache WHERE list = ? ORDER BY page").bind(list).all();
  const entries = results.flatMap((r) => JSON.parse(String(r.entries)));
  if (!entries.length || entries[0].n !== 1) return null;
  for (let i = 1; i < entries.length; i++) if (entries[i].n !== entries[i - 1].n + 1) return null;
  return entries;
}

/**
 * `kept` (as keptThread gave them) with `fresh` (checked from the last of them) after: a delete or removal among the
 * fresh ones empties what it's about, as its host does (only its fingerprint, and what became of it, stay).
 */
export function withNew(kept, fresh) {
  const all = [...kept.map((e) => ({ ...e })), ...fresh.map(keep)];
  const byFp = new Map(all.map((e) => [e.fp, e]));
  for (const e of fresh) {
    const kind = e.record?.kind;
    if ((kind !== "delete" && kind !== "remove") || !e.record.about) continue;
    const target = byFp.get(e.record.about);
    if (!target || target.n >= e.n) continue;
    for (const k of ["record", "content", "by"]) delete target[k];
    target.state = kind === "delete" ? "deleted" : "removed";
    if (kind === "remove") target.removedBy = e.record.author;
  }
  return all;
}

/**
 * Keeps `entries` (as shown: checked, each with its running fingerprint) as this site's copy of `list`, replacing
 * what it had from `from` on (by page; the pages before stay as they were).
 * @param {D1Database} db @param {string} list @param {any[]} entries @param {number} [from]
 */
export async function keepThread(db, list, entries, from = 0) {
  if (!entries.length) return;
  const first = entries[0].n;
  const pages = new Map();
  for (const e of entries) {
    const page = Math.floor((e.n - first) / PAGE);
    if (e.n < from && Math.floor((from - first) / PAGE) > page) continue; // unchanged
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(keep(e));
  }
  await db.batch([
    ...(from ? [] : [db.prepare("DELETE FROM thread_cache WHERE list = ?").bind(list)]),
    ...[...pages].map(([page, list_]) => db.prepare(`INSERT INTO thread_cache (list, page, entries) VALUES (?, ?, ?)
      ON CONFLICT(list, page) DO UPDATE SET entries = excluded.entries`).bind(list, page, JSON.stringify(list_))),
  ]);
}

/**
 * Whether entries are fit to keep: none failed its check, or went with nothing signed saying why. A host that sent a
 * bad entry once is read in full again next time, rather than its bad entry kept for good.
 */
export const fitToKeep = (entries) => entries.every((e) => e.state !== "failed" && e.state !== "left-out");

/** The earliest entry `fresh` changes in `all` (as withNew made it): itself, or something it deleted or removed. */
export function firstChanged(all, fresh) {
  let n = fresh[0]?.n ?? Infinity;
  const byFp = new Map(all.map((e) => [e.fp, e.n]));
  for (const e of fresh) {
    if ((e.record?.kind === "delete" || e.record?.kind === "remove") && byFp.has(e.record.about)) n = Math.min(n, byFp.get(e.record.about));
  }
  return n;
}
