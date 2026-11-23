// Lists for afterwrd 2 (docs/signed-conversations.md, section 2): every item's list of records, numbered by its host,
// with a running fingerprint the host signs. The same rules decide what a host takes (admit) and what a reader accepts
// (checkList), so a host can't take anything a reader would refuse, and a reader can tell when a host showed it
// something no honest host would.
//
// An entry, as stored and sent: {n, fp, taken, head, sent?, gone?}
//   n       its number in the list, from 1 (the item itself, or the first record of a list that isn't one)
//   fp      its record's fingerprint
//   taken   when the host took it (the host's clock: what's shown, and what the edit rules go by)
//   head    the running fingerprint up to and including it:
//           head(n) = fingerprintOf("head", host \n list \n head(n-1) \n n \n fp \n taken), head(0) = ""
//   sent    the record as sent ({record, sig, content?, salt?}); absent once it's been deleted or removed, when only
//           its fingerprint stays, so the list still checks
//   gone    "deleted" or "removed": what became of it (a reader checks there's a signed record saying so)
// A signed head ({v: 2, kind: "head", host, list, n, head}, signed by the host's hosting key) is a receipt when handed
// to a writer, and a checkpoint every CHECKPOINT entries, so a new reader of a long list starts from one.
import { ABOUT, DATE_RE } from "../public/static/records.js";
import { b64url, checkAs, decode, encode, fingerprintOf, fromB64url, signAs, utf8 } from "../public/static/signed.js";
import { checkRecord } from "./records.js";

export const PAGE = 50;
export const CHECKPOINT = 500;
export const MAX_ENTRIES = 2000;
export const PER_AUTHOR = 20;
export const EDIT_SECONDS = 15 * 60;
/** Kinds only a group's members list holds (members.js). */
export const MEMBERS_ONLY = new Set(["join", "approve", "leave", "role"]);
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * One date of a repeating event has a list of its own (step 6d), holding its answers and its calling off: named by the
 * event and the date (YYYY-MM-DD where it's held), so answers stay with their date if the pattern changes.
 */
export const dateList = (item, date) => `${item}/${date}`;

/** The list a record is on: its item's (or the item it makes), or, for one date of a repeating event, that date's. */
export const listOf = (record, fp) => (record.kind === "item" ? fp : record.date ? dateList(record.item, record.date) : record.item);

/** A list's id read: {item, date} (date null for an item's own list or a members list), or null if it isn't one. */
export function parseListId(list) {
  const [item, date, more] = String(list).split("/");
  if (!ID_RE.test(item) || more !== undefined || (date !== undefined && !DATE_RE.test(date))) return null;
  return { item, date: date ?? null };
}

/** The running fingerprint after an entry. */
export const headOf = ({ host, list, prev, n, fp, taken }) => fingerprintOf("head", utf8(`${host}\n${list}\n${prev}\n${n}\n${fp}\n${taken}`));

/** A signed head: what the host's hosting key says the list was at `n`. */
export async function signHead(privateKey, { host, list, n, head }) {
  const bytes = encode({ v: 2, kind: "head", host, list, n, head });
  return { bytes: b64url(bytes), sig: await signAs("head", privateKey, bytes) };
}

/** A signed head's contents if `hostingKey` signed it for `host`'s list `list`; null if not. */
export async function checkHead(signed, { hostingKey, host, list }) {
  const bytes = typeof signed?.bytes === "string" ? fromB64url(signed.bytes) : null;
  const h = bytes && decode(bytes);
  if (!h || h.v !== 2 || h.kind !== "head" || h.host !== host || h.list !== list || !Number.isSafeInteger(h.n) || h.n < 1 || !ID_RE.test(h.head ?? "")) return null;
  return (await checkAs("head", hostingKey, bytes, signed.sig)) ? { n: h.n, head: h.head } : null;
}

/**
 * The rules a list's records follow, applied entry by entry, by its host before taking one and by readers going
 * through what the host shows them. `owner`: the item's writer (who may close it, and whose removals count, besides the
 * host itself).
 */
export class Rules {
  constructor({ host, list, owner = null }) {
    this.host = host;
    this.list = list;
    this.owner = owner;
    // One date of a repeating event (dateList): `item` is the event, `date` the date; otherwise `item` is the list.
    const parsed = parseListId(list);
    this.item = parsed?.item ?? list;
    this.date = parsed?.date ?? null;
    this.off = false; // that date called off
    this.heads = new Map([[0, ""]]); // n -> running fingerprint
    this.byFp = new Map(); // fp -> {n, author, kind, taken}  (author null for an entry whose record is gone)
    this.lastOf = new Map(); // author -> fp of their newest record here
    this.chainOf = new Map(); // author -> Set of fps in their chain of prev (their own records, gone ones included)
    this.count = new Map(); // author -> entries
    this.closed = false;
    this.ended = false; // a poll's voting, ended by its owner (`end`)
    this.n = 0;
  }

  /**
   * Why `record` (checked: checkRecord's answer) can't come next, taken at `taken`; null if it can. `checkpointed`:
   * points before this one can't be checked (a reader that started from a checkpoint), so `seen` and `prev` naming
   * something before it are let through.
   * @param {{ record: any, fp: string, byHost?: boolean, content?: any }} got @param {number} taken
   * @param {{ checkpointed?: number }} [options] @returns {string | null}
   */
  refuse({ record, fp, byHost }, taken, { checkpointed = 0 } = {}) {
    const n = this.n + 1;
    if (n > MAX_ENTRIES) return "This is as long as a list gets.";
    if (this.byFp.has(fp)) return "duplicate";
    if (record.host !== this.host) return "That belongs somewhere else.";
    if (record.kind === "item") {
      if (n !== 1 || fp !== this.list) return "That isn't this item.";
      // Whoever the list says it's by must have written it: a reader takes `owner` from the host, the first time.
      if (this.owner && record.author !== this.owner) return "That isn't by whoever this list says.";
      return null;
    }
    if (listOf(record, fp) !== this.list) return "That belongs to something else.";
    if (MEMBERS_ONLY.has(record.kind)) return "That belongs in a group's members list.";
    // A date's list holds only answers to that date and its calling off (once), about the event.
    if (this.date) {
      if (record.kind !== "answer" && record.kind !== "calloff") return "That doesn't belong to one date.";
      if (this.off) return "That date's been called off.";
    }
    // Closed: nothing new, but what's there can still go (its writer deleting it, or a removal).
    if (this.closed && record.kind !== "remove" && record.kind !== "delete") return "This is closed.";
    // The cap stops anyone filling a list up; it never stops someone deleting what's theirs.
    // Not the item's owner's changes (inviting people to an event one by one, say, mustn't run out); their words and
    // comments are held to it like anyone's.
    if (!byHost && record.kind !== "delete" && !(record.kind === "change" && record.author === this.owner) && !this.uncapped(record)
      && (this.count.get(record.author) ?? 0) >= PER_AUTHOR) {
      return "That's as many as anyone can add here.";
    }
    const out = this.order({ record, byHost }, n, checkpointed);
    if (out) return out;
    if (this.date && record.kind === "calloff") {
      // About the event, which is in its own list.
      if (record.about !== this.item) return "That isn't this event.";
      const why = this.actTrouble(record, null, byHost);
      if (why) return why;
    } else if (ABOUT.has(record.kind)) {
      const target = this.byFp.get(record.about);
      if (!target && !checkpointed) return "That acts on something that isn't here.";
      if (record.kind === "edit" || record.kind === "delete") {
        // Only the writer's own: a record in their chain of prev, this one's prev included (deleting the comment you
        // just made: a reader sees it gone, so only the prev says whose it was).
        const mine = new Set([...(this.chainOf.get(record.author) ?? []), record.prev]);
        if (target && !(mine.has(record.about) || target.author === record.author)) return "That isn't theirs.";
      }
      if (record.kind === "edit" && target) {
        if (taken - target.taken > EDIT_SECONDS) return "It's too late to change that.";
        for (const [, other] of this.byFp) {
          if (other.n > target.n && other.author !== null && other.author !== record.author) return "Someone has replied since.";
        }
      }
      if (record.kind === "remove" || record.kind === "calloff") {
        const why = this.actTrouble(record, target, byHost);
        if (why) return why;
      }
    }
    if (record.kind === "close" && !byHost && record.author !== this.owner && record.author !== this.host) return "Only its owner can close it.";
    if (record.kind === "change" && record.author !== this.owner) return "Only its owner can change it.";
    // A poll's voting ends once, by its owner; then no more votes (comments carry on).
    if (record.kind === "end" && (record.author !== this.owner || this.ended)) return this.ended ? "That's already ended." : "Only its owner can end it.";
    if (record.kind === "vote" && this.ended) return "That poll has closed.";
    return null;
  }

  /** Whether a record isn't held to the per-person cap (besides deletes, and the owner's changes). @param {any} record @returns {boolean} */
  uncapped(record) {
    void record;
    return false;
  }

  /**
   * Why `record` (a remove or a calloff) may not act on `target` (its entry here, if known); null if it may. On a
   * friend's item: its owner, or its host, removes; nobody calls off (that's in groups).
   * @param {any} record @param {any} target @param {boolean} byHost @returns {string | null}
   */
  actTrouble(record, target, byHost) {
    void target;
    if (record.kind === "calloff") return "Only a group's admins call things off.";
    return byHost || record.author === this.owner || record.author === this.host ? null : "Only its owner or host can remove that.";
  }

  /**
   * Why a record isn't in order here as entry `n`; null if it is. `seen`: a real point in this list, before this entry
   * (none only for a list's first entry, when there's no item before it: a group's members list). `prev`: the writer's
   * own newest record here (or one of theirs that's gone since, after it); not for a host acting with its hosting key,
   * which isn't a writer with records of its own.
   */
  order({ record, byHost }, n, checkpointed) {
    const seen = record.seen;
    if (seen === null ? n !== 1 : (!seen || seen.n >= n || (seen.n >= checkpointed && this.heads.get(seen.n) !== seen.h))) {
      return "That says it saw something this list never was.";
    }
    const last = this.lastOf.get(record.author) ?? null;
    if (!byHost && record.prev !== last) {
      const gone = record.prev && this.byFp.get(record.prev);
      const lastN = last ? this.byFp.get(last).n : 0;
      const before = record.prev && !gone && checkpointed > 0;
      if (!(gone && gone.author === null && gone.n > lastN) && !before) return "That's out of order.";
    }
    return null;
  }

  /**
   * Notes an entry as part of the list (after refuse said yes, or for a gone one, as the list shows it). `head`: its
   * running fingerprint when it's already known to be right (a host rebuilding from its own storage); otherwise it's
   * worked out.
   */
  async add({ fp, taken, record = null, byHost = false, head: known = null, content = undefined }) {
    const n = ++this.n;
    const head = known ?? (await headOf({ host: this.host, list: this.list, prev: this.heads.get(n - 1), n, fp, taken }));
    this.heads.set(n, head);
    const author = record?.author ?? null;
    this.byFp.set(fp, { n, author, kind: record?.kind ?? null, taken });
    if (record && !byHost) {
      this.lastOf.set(author, fp);
      this.count.set(author, (this.count.get(author) ?? 0) + 1);
      const chain = this.chainOf.get(author) ?? new Set();
      chain.add(fp);
      if (record.prev) chain.add(record.prev);
      this.chainOf.set(author, chain);
    }
    if (record?.kind === "close") this.closed = true;
    if (record?.kind === "end") this.ended = true;
    if (record?.kind === "calloff" && this.date) this.off = true;
    return head;
  }

  /** A checkpoint to start from: the list was `head` at `n` (a signed head checked by the caller). */
  startAt(n, head) {
    this.n = n;
    this.heads.set(n, head);
  }
}

/**
 * The rules for a post in a group (afterwrd 2, step 6c): as any item's, but what's removed is removed by the group's
 * admins or its owner, not by the post's writer, and an admin may call off anyone's event (`calloff`, about the
 * event). An admin can't remove what the group's owner wrote. `group`: {owner: the group's owner (a person id), admin:
 * (person, role_at) => whether they're an admin at that point in the members list}: the group's site goes by its
 * members list as it stands (and refuses a role that's changed since `role_at`); a reader, by the owner's signed
 * `role` records the group sends with the thread. Admins' removals and calling off aren't held to the per-person cap.
 */
export class GroupRules extends Rules {
  /** @param {{ host: string, list: string, owner?: string | null, group: { owner: string, admin: (person: string, roleAt: any) => boolean } }} options */
  constructor({ host, list, owner = null, group }) {
    super({ host, list, owner });
    this.group = group;
  }

  uncapped(record) {
    return record.kind === "remove" || record.kind === "calloff";
  }

  /** @param {any} record @param {any} target @param {boolean} byHost @returns {string | null} */
  actTrouble(record, target, byHost) {
    if (record.kind === "calloff" && record.about !== this.item) return "That isn't this event.";
    if (byHost) return record.kind === "remove" ? null : "Only the group's admins call things off.";
    // One date of a repeating event: its writer may call that date off too (the whole of it, they change it).
    if (this.date && record.kind === "calloff" && record.author === this.owner) return null;
    const owner = record.author === this.group.owner;
    if (!owner && !this.group.admin(record.author, record.role_at ?? null)) {
      return record.kind === "remove" ? "Only the group's admins can remove that." : "Only the group's admins can call that off.";
    }
    // (On one date, the event is in its own list: its writer is this list's owner.)
    if (!owner && (target?.author ?? (this.date ? this.owner : null)) === this.group.owner) {
      return record.kind === "remove" ? "Only the group's owner can remove what they wrote." : "Only the group's owner can call off what they added.";
    }
    return null;
  }
}

/**
 * Checks a list as a host shows it. `entries` run from just after `from` (a checked point: {n, head}, a checkpoint or
 * this reader's last checked point; none for the start), or after `rules` already worked out from what this reader
 * checked before, to the end; `signedHead` is the host's signature on the end.
 * Returns {entries: [{n, fp, taken, state, record, content}], upTo, head, problem}: everything up to `upTo` checked; a
 * `problem` says why the rest isn't shown ("broken": the running fingerprint doesn't add up, or the head isn't signed;
 * "unexpected": an entry no honest host would have taken). Each entry's state is "ok", "deleted", "removed",
 * "left-out" (gone, with nothing signed saying why) or "failed" (its signature doesn't check: hidden).
 */
export async function checkList({ host, hostingKey, list, owner = null, entries, signedHead, from = null, lookups, Kind = Rules, group = null, rules: built = null }) {
  // `built`: rules already worked out from entries this reader checked before and kept (as a members list is:
  // groupjoin.js), carried on from where they got to.
  const rules = built ?? (group ? new GroupRules({ host, list, owner, group }) : new Kind({ host, list, owner }));
  if (built) from = { n: built.n, head: built.heads.get(built.n) };
  else if (from) rules.startAt(from.n, from.head);
  const shown = [];
  const checked = [];
  let problem = null;
  for (const e of entries) {
    if (!e || e.n !== rules.n + 1 || !ID_RE.test(e.fp ?? "") || !Number.isSafeInteger(e.taken)) { problem = "broken"; break; }
    // The record sent must be the one the list names, whether or not it checks: otherwise the host put another in.
    const sentBytes = e.sent && typeof e.sent.record === "string" ? fromB64url(e.sent.record) : null;
    if (e.sent && (!sentBytes || (await fingerprintOf("record", sentBytes)) !== e.fp)) { problem = "broken"; break; }
    const got = e.sent ? await checkRecord(e.sent, { ...lookups, at: e.taken }) : null;
    if (got) {
      const why = rules.refuse(got, e.taken, { checkpointed: from?.n ?? 0 });
      if (why) { problem = "unexpected"; break; }
    }
    const head = await rules.add({ fp: e.fp, taken: e.taken, record: got?.record ?? null, byHost: got?.byHost ?? false, content: got?.content });
    if (e.head !== head) { problem = "broken"; break; }
    checked.push(e);
    shown.push({ n: e.n, fp: e.fp, taken: e.taken, state: got ? "ok" : e.sent ? "failed" : "gone", record: got?.record ?? null, content: got?.content, by: got?.record.author ?? null,
      ...(got?.byHost && { byHost: true }) });
  }
  // The end must be what the host signed.
  const end = shown.length ? { n: shown.at(-1).n, head: rules.heads.get(shown.at(-1).n) } : from;
  const signed = await checkHead(signedHead, { hostingKey, host, list });
  if (!problem && (!signed || !end || signed.n !== end.n || signed.head !== end.head)) problem = "broken";
  // What became of each record that's gone: a signed delete by its writer, or a removal; otherwise it was left out.
  for (const s of shown) {
    if (s.state !== "gone") continue;
    const by = shown.find((o) => o.record && (o.record.kind === "delete" || o.record.kind === "remove") && o.record.about === s.fp);
    s.state = by ? (by.record.kind === "delete" ? "deleted" : "removed") : "left-out";
    if (by?.record.kind === "remove") s.removedBy = by.record.author;
  }
  return { entries: shown, upTo: end?.n ?? 0, head: end?.head ?? "", problem, rules };
}
