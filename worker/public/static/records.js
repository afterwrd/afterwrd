// Records for afterwrd 2 (docs/signed-conversations.md, section 2), shared by the browser, which makes and signs the
// owner's records with its browser key, and the Worker, which checks every record that arrives (src/records.js).
//
// A record is the exact bytes its writer signed (UTF-8 JSON, never rebuilt), with these fields:
//   v: 2, kind              what it is (KINDS below)
//   author                  the writer's person id (their identity's first fingerprint)
//   key                     the key that signed it: one of their browser keys (or, for a host's own actions, its
//                           hosting key)
//   host, item              where it lives: the host's person id, and the item (none for the record that makes one)
//   seen {n, h}             the point in the item's list the writer last saw (number and running fingerprint)
//   prev                    the fingerprint of the writer's own previous record on this item, or null
//   about                   for edit, delete, remove, approve, role, calloff: the record it acts on (for a group's
//                           members, a member's join; for calloff, the event)
//   role_at {n, h}          for an admin's action in a group: the point in its members list at which they held the role
//   version                 for vote and answer: the fingerprint of the item's version they answer
//   date                    for answer and calloff on one date of a repeating event (a group's): that date, YYYY-MM-DD
//                           where it's held (its list is "<item>/<date>": src/lists.js dateList)
//   mentions                person ids it mentions
//   audience                for item and change: who it's for, {kind: "invited", fp} (an event's guests: audienceOf),
//                           never the list itself; none for everyone the writer's friends with
//   body                    SHA-256 of a 16-byte salt then the content: the content itself travels beside the
//                           record, so it can be thrown away for good while the signature still checks
//   at                      when the writer says they wrote it (shown nowhere: hosts' "taken at" times are)
//   before                  for item and comment brought over from afterwrd 1 (step 10: src/before.js): when it was
//                           first written, shown in place of the host's time. A host takes it only for its own old row
//                           with that time, so the writer and the host both say so
// A record's fingerprint (fingerprintOf("record", bytes)) is its id: the same bytes sent twice are the same record.
import { b64url, concat, decode, encode, fingerprint, fingerprintOf, fromB64url, signAs, utf8 } from "./signed.js";

// `end`: a poll's owner ending its voting (comments carry on); `close` closes a whole item.
// A group's members list (step 6b: src/members.js): `join` (by the member; content {name}, as they call themselves),
// `approve` and `remove` (by an admin), `role` (by the owner: content {role: "admin" | "member"}), `leave` (by the member).
// In a group's post (step 6c), an admin's `remove` and `calloff` (an event called off, about the event) carry `role_at`.
export const KINDS = /** @type {const} */ (["item", "change", "comment", "edit", "delete", "vote", "answer", "close", "remove", "end",
  "join", "approve", "leave", "role", "calloff"]);
/** Kinds that carry content (and so a body). */
export const WITH_CONTENT = new Set(["item", "change", "comment", "edit", "vote", "answer", "role", "join"]);
/** Kinds that act on another record (about). */
export const ABOUT = new Set(["edit", "delete", "remove", "approve", "role", "calloff"]);
/** Kinds that answer a version of the item. */
export const VERSIONED = new Set(["vote", "answer"]);
/** Kinds that may be brought over from afterwrd 1, with when they were first written (`before`). */
export const BROUGHT = new Set(["item", "comment"]);
/** Kinds that may be about one date of a repeating event. */
export const DATED = new Set(["answer", "calloff"]);
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const SALT_BYTES = 16;
export const MAX_RECORD = 4096;
export const MAX_CONTENT = 16 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** The salted fingerprint of `content` (bytes) with `salt` (bytes). */
export const bodyOf = async (salt, content) => fingerprint(concat(salt, content));

/**
 * A new record, made and signed in the browser. `fields` are the record's own (kind, author, host, item, seen, prev,
 * about, version, mentions); `content` (any JSON value) goes beside it with a fresh salt. Returns what's sent:
 * {record, sig, content, salt} (base64url), and the record's fingerprint.
 * @param {Record<string, unknown>} fields @param {unknown} content @param {{ privateKey: CryptoKey, publicKey: string }} key
 */
export async function makeRecord(fields, content, key) {
  let extra = {};
  if (content !== undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const bytes = encode(content);
    // Said here, plainly: otherwise its host would only say the signature didn't check (contentOf refuses it).
    if (bytes.length > MAX_CONTENT) throw new Error("That's too long to send: try fewer words, or fewer photos.");
    extra = { content: b64url(bytes), salt: b64url(salt), body: await bodyOf(salt, bytes) };
  }
  const bytes = encode({ v: 2, ...fields, key: key.publicKey, ...(extra.body ? { body: extra.body } : {}), at: Math.floor(Date.now() / 1000) });
  return {
    sent: { record: b64url(bytes), sig: await signAs("record", key.privateKey, bytes), ...(extra.content ? { content: extra.content, salt: extra.salt } : {}) },
    fp: await fingerprintOf("record", bytes),
  };
}

const point = (p) => p === null || (p && Number.isSafeInteger(p.n) && p.n >= 0 && ID_RE.test(p.h ?? ""));

/** When a record says its item or comment was written: when first written, if brought over from afterwrd 1, else `taken`. */
export const writtenAt = (record, taken) => (Number.isSafeInteger(record?.before) && record.before < taken ? record.before : taken);

/**
 * The record in `bytes`, if it's well-formed for its kind; null if not. (Its signature, writer and content are checked
 * by src/records.js.)
 * @param {Uint8Array} bytes
 */
export function parseRecord(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECORD) return null;
  const r = decode(bytes);
  if (!r || r.v !== 2 || !KINDS.includes(r.kind) || !ID_RE.test(r.author ?? "") || !ID_RE.test(r.key ?? "") || !ID_RE.test(r.host ?? "")) return null;
  if (!Number.isSafeInteger(r.at)) return null;
  if (r.kind === "item" ? r.item !== undefined : !ID_RE.test(r.item ?? "")) return null;
  if (r.kind !== "item" && (!point(r.seen) || !(r.prev === null || ID_RE.test(r.prev ?? "")))) return null;
  if (WITH_CONTENT.has(r.kind) !== ID_RE.test(r.body ?? "")) return null;
  if (ABOUT.has(r.kind) !== ID_RE.test(r.about ?? "")) return null;
  if (VERSIONED.has(r.kind) !== ID_RE.test(r.version ?? "")) return null;
  if (r.role_at !== undefined && (!r.role_at || !point(r.role_at))) return null;
  if (r.date !== undefined && (!DATED.has(r.kind) || typeof r.date !== "string" || !DATE_RE.test(r.date))) return null;
  if (r.mentions !== undefined && (!Array.isArray(r.mentions) || r.mentions.length > 10 || r.mentions.some((m) => !ID_RE.test(m)))) return null;
  if (r.audience !== undefined && (!["item", "change"].includes(r.kind) || r.audience?.kind !== "invited" || !ID_RE.test(r.audience.fp ?? ""))) return null;
  if (r.before !== undefined && (!BROUGHT.has(r.kind) || !Number.isSafeInteger(r.before) || r.before <= 0 || r.before >= r.at)) return null;
  // A group post brought over from afterwrd 1 names its number there, so comments made on it before can be sure they go
  // back on it and nowhere else.
  if (r.old !== undefined && (r.kind !== "item" || r.before === undefined || !Number.isSafeInteger(r.old) || r.old <= 0)) return null;
  return r;
}

/**
 * The content sent beside a record, if it's what the record's body says; its value, or undefined if not (or none).
 * @param {{ body?: string }} record @param {string} contentText @param {string} saltText
 */
export async function contentOf(record, contentText, saltText) {
  const content = typeof contentText === "string" ? fromB64url(contentText) : null;
  const salt = typeof saltText === "string" ? fromB64url(saltText) : null;
  if (!record.body || !content || !salt || salt.length !== SALT_BYTES || content.length > MAX_CONTENT) return undefined;
  if ((await bodyOf(salt, content)) !== record.body) return undefined;
  const value = decode(content);
  return value === null ? undefined : value;
}


/**
 * Who a post or comment mentions, from what the @ list noted (ui/mentions.js: [{name, person}]): those with an
 * identity whose @name is still in `text`, ten at most. Returns {mentions (person ids, for the record), shown
 * ([{name, person}], for its content)}, both empty for none.
 * @param {string} text @param {unknown} picked
 */
export function pickedMentions(text, picked) {
  let list = picked;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
  /** @type {{ name: string, person: string }[]} */
  const shown = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m?.name !== "string" || !ID_RE.test(m?.person ?? "") || shown.some((s) => s.person === m.person)) continue;
    if (!says(text, m.name)) continue;
    shown.push({ name: m.name, person: m.person });
    if (shown.length >= 10) break;
  }
  return { mentions: shown.map((m) => m.person), shown };
}

const WORD = /[A-Za-z0-9_]/;
/**
 * Whether `text` says @`name`, as a whole name (not the start of a longer one, nor part of an address like a@b). A plain
 * search, not a pattern built per name: a friend's site could send many names and long words, and this runs on each.
 * Shared by the browser and the site (src/mentions.js).
 */
export function says(text, name) {
  const wanted = `@${name}`;
  for (let i = text.indexOf(wanted); i !== -1; i = text.indexOf(wanted, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + wanted.length] ?? "";
    if (!WORD.test(before) && before !== "@" && !WORD.test(after)) return true;
  }
  return false;
}

/**
 * The salted fingerprint of an audience: who an event is for (their person ids), as its records carry it. The salt
 * (base64url, 16 random bytes) goes only to the owner's own site, which checks the guests it's given against the
 * fingerprint once (items.js guestsFor) and doesn't keep it, so nobody reading the record can work out who else is
 * invited. The fingerprint binds the guest list as the host took it, then.
 * @param {string} salt @param {string[]} people
 */
export const audienceOf = (salt, people) => fingerprintOf("audience", concat(fromB64url(salt), utf8([...new Set(people)].sort().join("\n"))));
