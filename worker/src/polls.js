// Polls: a post that asks a question (its words) with 2 to 10 options. Polls are signed now, friends' and groups'
// (itemkinds.js uses readPoll and choicesMask here); the owner's polls from before signing are shown as they were
// (sitePolls). Answers notify no one. A poll closes when its writer closes it, or by itself at the time they picked.
import { now } from "./util.js";

export const MAX_OPTIONS = 10;
export const MAX_OPTION = 100;
const LONGEST = 366 * 86400; // a closing time can be up to a year away

const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * A new poll, as the composer sends it: { options: [text…], multiple, closes_at (seconds, or nothing) }. Returns
 * { poll } (null if there's none) or { error }.
 */
export function readPoll(input, at = now()) {
  if (input === undefined || input === null) return { poll: null };
  if (typeof input !== "object" || !Array.isArray(input.options)) return { error: "Unexpected poll details." };
  const options = input.options.slice(0, MAX_OPTIONS + 1).map(clean).filter(Boolean);
  if (options.length < 2) return { error: "A poll needs at least two options." };
  if (options.length > MAX_OPTIONS) return { error: `A poll can have up to ${MAX_OPTIONS} options.` };
  if (options.some((o) => o.length > MAX_OPTION)) return { error: `Options can be up to ${MAX_OPTION} characters.` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: "Each option needs to be different." };
  const closes = input.closes_at === undefined || input.closes_at === null || input.closes_at === "" ? null : Number(input.closes_at);
  if (closes !== null && (!Number.isSafeInteger(closes) || closes <= at || closes > at + LONGEST)) {
    return { error: "Pick a closing date within the next year." };
  }
  return { poll: { options, multiple: input.multiple === true || input.multiple === 1 ? 1 : 0, closes_at: closes } };
}

/** Whether a kept poll (a polls or group_polls row) is still taking answers. */
export const isOpen = (row, at = now()) => !row.closed_at && (!row.closes_at || row.closes_at > at);

const bitCount = (n) => n.toString(2).replace(/0/g, "").length;

/**
 * The options someone chose (their numbers) as bits, if that's a fair answer to this poll: options it has, and only
 * one unless it takes more. 0 takes their answer back. Null if it isn't fair.
 */
export function choicesMask(list, row) {
  if (!Array.isArray(list) || list.length > MAX_OPTIONS) return null;
  const n = JSON.parse(row.options).length;
  let mask = 0;
  for (const value of list) {
    const i = typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(i) || i < 0 || i >= n) return null;
    mask |= 1 << i;
  }
  return !row.multiple && bitCount(mask) > 1 ? null : mask;
}

/**
 * A kept poll as pages show it: each option with how many chose it, whether `viewer` did, and (`names`, for whoever
 * asked) who did. `votes`: [{ voter, name, choices }].
 */
export function tally(row, votes, { viewer = null, names = false } = {}) {
  const mine = votes.find((v) => v.voter === viewer)?.choices ?? 0;
  return {
    options: JSON.parse(row.options).map((name, i) => {
      const chose = votes.filter((v) => v.choices & (1 << i));
      return { name, count: chose.length, chosen: Boolean(mine & (1 << i)),
        voters: names ? chose.map((v) => ({ name: v.name, from: v.voter === "site" ? null : v.voter })) : null };
    }),
    multiple: Boolean(row.multiple), closes_at: row.closes_at ?? null, closed_at: row.closed_at ?? null, open: isOpen(row),
    voters: votes.length, answered: Boolean(mine),
  };
}

// --- the owner's polls from before signing ------------------------------------------------------------------------------

/** The polls in some of the owner's posts from before signing (posts ids), as `viewer` ('site', the owner) sees them. */
export async function sitePolls(db, ids, viewer) {
  if (!ids.length) return new Map();
  // By the range of post numbers, then only those asked for: SQLite reads just the polls in that range (usually
  // none), where a list of ids is looked up one by one, costing rows read even when there's no poll at all (a friend's
  // site asks for 30 posts each time it refreshes: docs/speed-and-scale-plan.md, "Scale test").
  const range = [Math.min(...ids), Math.max(...ids)];
  const wanted = new Set(ids);
  const [polls, votes] = await db.batch([
    db.prepare("SELECT * FROM polls WHERE post_id BETWEEN ? AND ?").bind(...range),
    db.prepare("SELECT post_id, voter, name, choices FROM poll_votes WHERE post_id BETWEEN ? AND ? ORDER BY voted_at").bind(...range),
  ]);
  return new Map(polls.results.filter((row) => wanted.has(row.post_id)).map((row) => [row.post_id,
    tally(row, votes.results.filter((v) => v.post_id === row.post_id), { viewer, names: viewer === "site" })]));
}
