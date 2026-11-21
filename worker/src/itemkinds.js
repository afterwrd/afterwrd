// Polls and events as signed items (afterwrd 2, step 4d: docs/signed-conversations.md, "4d in detail"). The rules, used
// by the host before it takes a record (items.js recordOn) and when it works an item out again from its list
// (items.js refreshItem), and by readers counting a friend's poll again from its checked list:
//   - a poll is a post whose content has `poll: {options, multiple, closes_at}`. A `vote` ({choices: [n…]}, none takes
//     it back) names the poll's version (its item: nothing changes a poll). The owner's `end` stops voting, as does
//     its closing time (by the host's "taken at" time); comments carry on. Each person's newest fair vote counts.
//     Polls are public: everyone who can see one sees who chose what.
//   - an event is a post whose content is {type: "event", text, event: {title, starts_at, ends_at, all_day, time_zone,
//     place}}, for those invited (its record's `audience`). The owner's `change` ({event, text}) carries it as it now
//     is: a change of anything but the words moves its version, which answers name; `event.cancelled` calls it off.
//     An `answer` ({answer: going | maybe | no}) comes from a guest, while it's neither off nor over.
import { readPoll, choicesMask } from "./polls.js";
import { ANSWERS, cleanEvent, eventChanged, finishedAt } from "./calendar.js";

export const CHANGE_SECONDS = 300; // an event moved at most this often (guests are told each time)

/** What's wrong with a new post's poll (its content's `poll`), or null: it must be exactly as readPoll keeps one. */
export function pollTrouble(poll, at) {
  if (poll === undefined) return null;
  const read = readPoll(poll, at);
  if (read.error) return read.error;
  return JSON.stringify(read.poll) === JSON.stringify({ options: poll.options, multiple: poll.multiple, closes_at: poll.closes_at })
    ? null : "That poll isn't as written.";
}

/** What's wrong with a new event's details, or null. */
export function eventTrouble(event, at) {
  if (!cleanEvent(event) || event.cancelled) return "That event isn't as written.";
  if (finishedAt(event) <= at) return "That's already over: pick a time still to come.";
  return null;
}

/**
 * An item worked out from its list: `read` is its entries, each {e, r} (r: {record, content}, or null once gone), the
 * first its `item`. Returns what pages show beyond the words: {content (its event, as last changed), version, tally,
 * movedAt}. `guests`: an event's guests' person ids (the host's own list), whose answers alone count; readers pass
 * null, and count everyone's.
 */
export function workOut(read, { id, author, guests = null }) {
  const first = read[0]?.r;
  let content = first?.content ?? {};
  let version = id;
  let movedAt = null;
  let endedAt = null;
  const votes = new Map();
  const answers = new Map();
  for (const { e, r } of read.slice(1)) {
    if (!r) continue;
    const { record, content: c } = r;
    if (record.kind === "change" && record.author === author && c?.event && content.type === "event") {
      const event = cleanEvent(c.event);
      if (!event) continue;
      if (eventChanged(content.event, event) || Boolean(event.cancelled) !== Boolean(content.event.cancelled)) {
        version = e.fp;
        movedAt = e.taken;
      }
      content = { ...content, event: { ...event, ...(event.cancelled ? { cancelled_at: content.event.cancelled_at ?? e.taken } : {}) },
        ...(typeof c.text === "string" ? { text: c.text } : {}) };
    } else if (record.kind === "end" && record.author === author && content.poll) {
      endedAt ??= e.taken;
    } else if (record.kind === "vote" && content.poll && record.version === id && endedAt === null
      && (!content.poll.closes_at || e.taken < content.poll.closes_at)) {
      const mask = choicesMask(Array.isArray(c?.choices) ? c.choices : null, { options: JSON.stringify(content.poll.options), multiple: content.poll.multiple });
      if (mask === null) continue;
      if (mask) votes.set(record.author, mask);
      else votes.delete(record.author);
    } else if (record.kind === "answer" && content.type === "event" && ANSWERS.includes(c?.answer) && (!guests || guests.includes(record.author))) {
      answers.set(record.author, { answer: c.answer, version: record.version, taken: e.taken });
    }
  }
  const tally = content.poll ? { votes: Object.fromEntries(votes), ended_at: endedAt }
    : content.type === "event" ? { answers: Object.fromEntries(answers) } : null;
  return { content, version, tally, movedAt };
}

/**
 * A poll as pages show it (views/parts.js pollBlock), from its content's `poll` and its tally: each option with how
 * many chose it and who (names: person -> name), whether `viewer` did, and whether it's open.
 */
export function pollShown(poll, tally, { viewer = null, names = new Map(), me = null } = {}) {
  const votes = Object.entries(tally?.votes ?? {});
  const mine = votes.find(([p]) => p === viewer)?.[1] ?? 0;
  const ended = tally?.ended_at ?? null;
  const open = !ended && (!poll.closes_at || poll.closes_at > Date.now() / 1000);
  return {
    options: poll.options.map((name, i) => {
      const chose = votes.filter(([, mask]) => mask & (1 << i));
      return { name, count: chose.length, chosen: Boolean(mine & (1 << i)),
        voters: chose.map(([p]) => ({ name: p === me ? "You" : names.get(p) ?? "Someone", me: p === me })) };
    }),
    multiple: Boolean(poll.multiple), closes_at: poll.closes_at ?? null, closed_at: ended ?? (open ? null : poll.closes_at), open,
    voters: votes.length, answered: Boolean(mine),
  };
}

/**
 * An event as pages show it (views/events.js eventBlock), from its content and tally: everyone invited sees who's going,
 * might go and can't (decision 15), and `viewer`'s own answer. An answer given before it last moved says so.
 */
export function eventShown(content, tally, { viewer = null, names = new Map(), me = null, version = null, invited = null } = {}) {
  const e = content.event;
  const answers = Object.entries(tally?.answers ?? {});
  const who = (answer) => answers.filter(([, a]) => a.answer === answer)
    .map(([p, a]) => ({ name: p === me ? "You" : names.get(p) ?? "Someone", me: p === me, earlier: Boolean(version && a.version !== version) }));
  return {
    title: e.title, starts_at: e.starts_at, ends_at: e.ends_at ?? null, all_day: e.all_day, time_zone: e.time_zone, place: e.place ?? null,
    cancelled_at: e.cancelled ? e.cancelled_at ?? 1 : null,
    going: who("going"), maybe: who("maybe"), cantGo: who("no"), invited,
    answer: answers.find(([p]) => p === viewer)?.[1].answer ?? null,
  };
}
