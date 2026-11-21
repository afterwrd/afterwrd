// Names as the owner here knows people (afterwrd 2, step 7b: docs/signed-conversations.md, section 1 "Names and
// people", decision 19, threat model T1). Anyone can sign any name, so pages show:
// - a friend by the name the owner approved, everywhere, and "now calling themselves Robert" if their signed name has
//   changed since;
// - anyone else by their signed name, with "not your friend Bob" when it looks like a friend's (or, in a group, like its
//   owner's or an admin's), after folding case, accents, spaces and look-alike letters;
// - on a friend's post, people the owner doesn't know as "friend of Ann"; in a group, where nearly everyone is a
//   stranger, the owner's friends as "your friend" instead (Ste, 21 Nov);
// - counts split by who the owner knows: "12 people answered, 4 you know".
// All of it is worked out here, from `connections` and `identities`, with no calls.
import { fromB64url } from "../public/static/signed.js";

// Letters from other alphabets, and digits and signs, that look like Latin letters in most fonts. A short list of the
// common ones, not Unicode's full table of confusables (about 100 KB): enough to catch "B0b" and a Cyrillic "Воb".
const LOOKALIKES = {
  // Cyrillic
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "l", ї: "l",
  ј: "j", ԁ: "d", ӏ: "l", һ: "h", ԛ: "q", ԝ: "w", ү: "y", ɡ: "g",
  // Greek
  α: "a", β: "b", ε: "e", η: "n", ι: "l", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", ϲ: "c",
  // Digits and signs
  0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "|": "l", "!": "l",
  // Latin letters that look alike: i and l (and capital I, lower-cased), and ı, ł, ø, đ, ß
  i: "l", ı: "l", ł: "l", ø: "o", đ: "d", ß: "ss", æ: "ae", œ: "oe",
};

/** A name folded for comparing: lower case, accents off, look-alike letters made one, spaces and signs gone. */
export function fold(name) {
  const plain = String(name ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const ch of plain) out += LOOKALIKES[ch] ?? ch;
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[^\p{L}\p{N}]/gu, "");
}

/** The name in a signed profile as kept in identities (checked when it was kept), or null. */
function profileName(profile) {
  try {
    const p = JSON.parse(String(profile));
    const said = JSON.parse(new TextDecoder().decode(fromB64url(p.bytes)));
    return typeof said.name === "string" ? said.name.slice(0, 100) : null;
  } catch { return null; }
}

/**
 * How the owner here is shown `people` (person ids). `signed`: names the host sent, already checked (person -> name).
 * `friendHost`: {person, name} on a friend's post; `group`: {owner, names: Map person -> name, admins: Set} in a group.
 * Returns {names: Map person -> name, tags: Map person -> {label?, warn?, renamed?}, known: Set of friends (and `me`)}.
 * @param {D1Database} db @param {string[]} people
 * @param {{ signed?: Map<string, string>, friendHost?: { person: string, name: string } | null, group?: { owner: string, names: Map<string, string>, admins: Set<string> } | null, me?: string | null }} [where]
 */
export async function peopleShown(db, people, { signed = new Map(), friendHost = null, group = null, me = null } = {}) {
  const list = [...new Set(people.filter(Boolean))];
  const names = new Map();
  const tags = new Map();
  const known = new Set(me ? [me] : []);
  if (!list.length) return { names, tags, known };
  const [friendRows, profileRows] = /** @type {D1Result<any>[]} */ (await db.batch([
    // Every friend, for look-alikes (one row each, and only when someone here isn't one).
    db.prepare("SELECT identity, name FROM connections WHERE approved_at IS NOT NULL AND identity IS NOT NULL"),
    db.prepare("SELECT person, profile FROM identities WHERE person IN (SELECT value FROM json_each(?)) AND profile IS NOT NULL").bind(JSON.stringify(list)),
  ]));
  const friends = new Map(friendRows.results.map((r) => [String(r.identity), String(r.name)]));
  const profiles = new Map(profileRows.results.map((r) => [String(r.person), profileName(r.profile)]));
  let folded = null; // fold(friend's name) -> their name, worked out once it's wanted
  const lookalikes = () => (folded ??= new Map([...friends.values()].map((n) => [fold(n), n])));
  for (const p of list) {
    if (p === me) continue;
    const current = signed.get(p) ?? profiles.get(p) ?? null;
    if (friends.has(p)) {
      const approved = friends.get(p);
      names.set(p, approved);
      known.add(p);
      const tag = {};
      if (current && current.trim() && fold(current) !== fold(approved)) tag.renamed = current.trim();
      if (group) tag.label = "your friend";
      if (Object.keys(tag).length) tags.set(p, tag);
      continue;
    }
    const name = current?.trim() || "Someone";
    names.set(p, name);
    const tag = {};
    const key = fold(name);
    const friend = key && lookalikes().get(key);
    if (friend) tag.warn = `not your friend ${friend}`;
    else if (group && key) {
      const owner = group.owner !== p && group.names.get(group.owner);
      if (owner && fold(owner) === key) tag.warn = `not ${owner}, the group's owner`;
      else {
        const admin = [...group.admins].find((a) => a !== p && group.names.get(a) && fold(group.names.get(a)) === key);
        if (admin) tag.warn = `not ${group.names.get(admin)}, an admin`;
      }
    }
    if (friendHost && p !== friendHost.person) tag.label = `friend of ${friendHost.name}`;
    if (Object.keys(tag).length) tags.set(p, tag);
  }
  return { names, tags, known };
}

/** Which of `people` are the owner's friends (for counts split by who they know). @param {D1Database} db @param {string[]} people */
export async function friendsAmong(db, people) {
  const list = [...new Set(people.filter(Boolean))];
  if (!list.length) return new Set();
  const { results } = await db.prepare(`SELECT identity FROM connections WHERE approved_at IS NOT NULL AND identity IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(list)).all();
  return new Set(results.map((r) => String(r.identity)));
}
