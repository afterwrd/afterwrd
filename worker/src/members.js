// A group's members list (afterwrd 2, step 6b: docs/signed-conversations.md, section 2, "A group's members"). It's a
// list like any item's, hosted by the group, with the group's own id as its id (and as its records' `item`), and the
// group's owner (its identity's `owner`) as its owner. Nobody is a member without their own signed `join`:
//   join      by the person joining (through an invite link): they're waiting, until…
//   approve   by an admin (about: their join): they're in
//   remove    by an admin (about: their join): a request declined, or a member removed (an admin only by the owner)
//   role      by the owner (about: a member's join; content {role: "admin" | "member"})
//   leave     by the member
//   close     by the owner (step 6e)
// The owner is always in, as its identity says, and never needs to join. An admin's action carries `role_at`, the
// point in this list at which they held the role, and is refused if their role has changed since (so an admin whose
// role was taken away can't act on what they saw before). The same rules decide what the group takes and what a reader
// accepts (lists.js).
import { Rules } from "./lists.js";

export const MAX_MEMBER_ENTRIES = 20_000;
const MEMBER_ENDINGS = 2_000; // leaves, removals and a close a full list still takes
const MEMBER_KINDS = new Set(["join", "approve", "remove", "role", "leave", "close"]);
const ROLES = new Set(["admin", "member"]);
export const MAX_JOINS = 10; // asks to join by one person, ever: each leave or removal needs a join before it

export class MemberRules extends Rules {
  constructor({ host, list, owner }) {
    super({ host, list, owner });
    /** @type {Map<string, { person: string, state: "waiting" | "in" | "out", n: number }>} join fp -> what became of it */
    this.joins = new Map();
    /** @type {Map<string, { join: string, role: "admin" | "member" }>} person -> their newest join, and role */
    this.people = new Map();
    /** @type {Map<string, number>} person -> the entry that last changed their role or membership */
    this.changedAt = new Map();
    /** @type {Map<string, number>} person -> how many times they've asked to join */
    this.asked = new Map();
  }

  /** Someone's role now: "owner", "admin", "member", "waiting", or null. */
  roleOf(person) {
    if (person === this.owner) return "owner";
    const p = this.people.get(person);
    const state = p && this.joins.get(p.join)?.state;
    return state === "in" ? p.role : state === "waiting" ? "waiting" : null;
  }

  /** Who's in (the owner apart) and who's waiting: [{person, join, role, state, n}]. */
  members() {
    const out = [];
    for (const [person, p] of this.people) {
      const j = this.joins.get(p.join);
      if (j && j.state !== "out") out.push({ person, join: p.join, role: j.state === "in" ? p.role : "waiting", state: j.state, n: j.n });
    }
    return out;
  }

  /** @param {{ record: any, fp: string, byHost?: boolean, content?: any }} got @param {number} taken @param {{ checkpointed?: number }} [options] @returns {string | null} */
  refuse({ record, fp, byHost, content }, taken, { checkpointed = 0 } = {}) {
    const n = this.n + 1;
    // Leaving, removing and closing are always possible, even on a full list: each needs someone in or asking, so
    // they can't run on far past it.
    const ending = ["leave", "remove", "close"].includes(record.kind);
    if (n > MAX_MEMBER_ENTRIES + (ending ? MEMBER_ENDINGS : 0)) return "This group's list is as long as it gets.";
    if (this.byFp.has(fp)) return "duplicate";
    if (record.host !== this.host || record.item !== this.list) return "That belongs somewhere else.";
    if (!MEMBER_KINDS.has(record.kind) || byHost) return "That isn't something a group's members list holds.";
    if (this.closed) return "This group is closed.";
    const out = this.order({ record, byHost }, n, checkpointed);
    if (out) return out;
    const actor = this.roleOf(record.author);
    if (record.kind === "join") {
      if (actor === "owner") return "The owner is in already.";
      // Asking again while still waiting replaces the earlier request (the group may have stopped showing it to its
      // admins: a week unanswered).
      if (actor && actor !== "waiting") return "You're in already.";
      // So nobody can fill the list up by asking again and again (or joining and leaving).
      if ((this.asked.get(record.author) ?? 0) >= MAX_JOINS) return "You've asked to join this group too many times.";
      return null;
    }
    if (record.kind === "leave") {
      if (actor === "owner") return "The owner can't leave: close the group instead.";
      return actor ? null : "You aren't in this group.";
    }
    if (record.kind === "close") return actor === "owner" ? null : "Only the group's owner can close it.";
    // An admin's (or the owner's) decision about someone's join.
    if (actor !== "owner" && actor !== "admin") return "Only the group's admins can do that.";
    if (actor === "admin") {
      const at = record.role_at;
      if (!at || at.n >= n || (at.n >= checkpointed && this.heads.get(at.n) !== at.h)) return "That says it saw something this list never was.";
      if ((this.changedAt.get(record.author) ?? 0) > at.n) return "Your role has changed since.";
    }
    const target = this.joins.get(record.about);
    if (!target || target.state === "out") return "They aren't in this group, or asking.";
    const targetRole = this.roleOf(target.person);
    if (record.kind === "approve") return target.state === "waiting" ? null : "They're in already.";
    if (record.kind === "remove") return targetRole === "admin" && actor !== "owner" ? "Only the group's owner can remove an admin." : null;
    // role
    if (actor !== "owner") return "Only the group's owner can make admins.";
    if (target.state !== "in") return "Let them in first.";
    if (!ROLES.has(content?.role)) return "That isn't a role.";
    return null;
  }

  async add(entry) {
    const head = await super.add(entry);
    const { record, content, fp } = entry;
    if (!record) return head;
    const n = this.n;
    if (record.kind === "join") {
      const earlier = this.people.get(record.author);
      if (earlier && this.joins.get(earlier.join)?.state === "waiting") this.joins.get(earlier.join).state = "out";
      this.joins.set(fp, { person: record.author, state: "waiting", n });
      this.asked.set(record.author, (this.asked.get(record.author) ?? 0) + 1);
      this.people.set(record.author, { join: fp, role: "member" });
      this.changedAt.set(record.author, n);
    } else if (record.kind === "leave") {
      const p = this.people.get(record.author);
      if (p && this.joins.get(p.join)) this.joins.get(p.join).state = "out";
      this.changedAt.set(record.author, n);
    } else if (["approve", "remove", "role"].includes(record.kind)) {
      const target = this.joins.get(record.about);
      if (target) {
        if (record.kind === "approve") target.state = "in";
        if (record.kind === "remove") target.state = "out";
        if (record.kind === "role" && ROLES.has(content?.role)) this.people.get(target.person).role = content.role;
        this.changedAt.set(target.person, n);
      }
    }
    return head;
  }
}
