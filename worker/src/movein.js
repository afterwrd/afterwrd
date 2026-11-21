// Moving here with your identity (afterwrd 2, step 4f: docs/signed-conversations.md "4f in detail"), the new site's
// side. The old site's side (agreeing, and signing the change of address) is in keys.js; the posts come afterwards with
// Download everything (move.js), which uses what's here to check them.
//   POST /_admin/import/move/identity/start   {from} -> {nonce, request, allow}: a move request for this site's passkey
//                                              to sign: this site's address, hosting key and that passkey
//   POST /_admin/import/move/identity/finish  {request, response} -> {go}: kept; `go` is the old site's page to agree on
//   POST /_admin/import/move/identity/fetch   the old site's identity, read again: whether it has signed the move, and
//                                              from when this site counts its 7 days (when it first saw it)
//   POST /_admin/import/move/identity/forget  stops the move here (the old site's side is cancelled there)
// Until the move takes effect here (7 days after this site first saw it), this site has no identity of its own: it
// signs nothing, takes no records and can't make friends. Then Bring everything over checks every list in the download
// against the identity as it was (verifyLists) and takes them as they are, signing their checkpoints with its own key.
import { checkList, CHECKPOINT, signHead } from "./lists.js";
import { checkPasskeyProof, moveOf, readIdentity } from "./identity.js";
import { checkProfile, identityState, learnIdentity, parseChain } from "./identities.js";
import { hostingKey, proofFrom } from "./keys.js";
import { readChallenge, spendChallenge, withChallenge } from "./auth.js";
import { itemFromList } from "./items.js";
import { siteOrigin } from "./sites.js";
import { b64url, decode, encode, fingerprintOf, fromB64url, utf8 } from "../public/static/signed.js";
import { json, now, randomToken } from "./util.js";

const FETCH_MS = 8000;
const MAX_REPLY = 512 * 1024;
const VERIFY_BATCH = 20;

/**
 * The move here, as this site sees it now; null if there isn't one. `stage`:
 *   "agree"      asked: waiting for the owner to agree on their old site
 *   "waiting"    the old site has signed it; it takes effect here at `at`
 *   "ready"      in effect here: the posts can come (Bring everything over)
 *   "cancelled"  the old site's identity no longer says it's moving here
 * @param {Env} env @param {URL} url
 */
export async function moveIn(env, url) {
  const row = await env.DB.prepare("SELECT from_origin, request, proof, person, chain FROM move_in WHERE id = 1").first();
  if (!row) return null;
  const base = { from: String(row.from_origin), request: String(row.request), proof: JSON.parse(String(row.proof)) };
  const chain = row.chain ? parseChain(JSON.parse(String(row.chain))) : null;
  if (!chain) return { ...base, stage: "agree", person: null, chain: null, state: null, at: null };
  const state = await readIdentity(chain, await seenTimes(env.DB, chain), now());
  const stage = !state || state.problem ? "cancelled" : state.current.origin === url.origin ? "ready"
    : state.pending?.origin === url.origin ? "waiting" : "cancelled";
  return { ...base, stage, person: String(row.person), chain, state, at: moveOf(state)?.at ?? null };
}

/** When this site first saw each document of `chain`, noting now for any it hasn't, as a lookup. */
async function seenTimes(db, chain) {
  const fps = await Promise.all(chain.map((d) => fingerprintOf("identity", d.bytes)));
  const at = now();
  await db.batch(fps.map((fp) => db.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(fp, at)));
  const { results } = await db.prepare("SELECT fp, first_seen FROM identity_seen WHERE fp IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(fps)).all();
  const seen = new Map(results.map((r) => [String(r.fp), Number(r.first_seen)]));
  return (fp) => seen.get(fp) ?? at;
}

export async function handleMoveIdentity(request, env, url, owner, path) {
  const body = await request.json().catch(() => ({}));
  if (path === "/start") return start(env, url, owner, body);
  if (path === "/finish") return finish(request, env, url, owner, body);
  if (path === "/fetch") return fetchMove(env, url);
  if (path === "/forget") {
    await env.DB.prepare("DELETE FROM move_in WHERE id = 1").run();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

/** The passkey this device signed in with, as an identity document lists it. */
async function thisPasskey(env, url, owner) {
  if (!owner.session_credential) return null;
  const c = await env.DB.prepare("SELECT id, public_key FROM credentials WHERE id = ? AND user_id = ?").bind(owner.session_credential, owner.id).first();
  return c ? { id: String(c.id), key: String(c.public_key), origin: url.origin } : null;
}

const cannot = async (env) => {
  if (await env.DB.prepare("SELECT 1 FROM own_identity WHERE id = 1").first()) {
    return json({ error: "This site already has an identity of its own, so it can't take another's. Only a new site can." }, 409);
  }
  return null;
};

async function start(env, url, owner, { from: text }) {
  const busy = await cannot(env);
  if (busy) return busy;
  const typed = String(text ?? "").trim();
  const from = siteOrigin(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`, env);
  if (!from) return json({ error: "That isn't a site's address." }, 400);
  if (from === url.origin) return json({ error: "That's this site. Type your old site's address." }, 400);
  const passkey = await thisPasskey(env, url, owner);
  if (!passkey) return json({ error: "Sign in again on this device first, with its passkey." }, 409);
  const requestBytes = encode({ v: 2, kind: "move", from, to: url.origin, hosting: (await hostingKey(env)).publicKey, passkey, at: now() });
  const nonce = randomToken();
  return withChallenge(env, "move", nonce, json({ nonce, request: b64url(requestBytes), allow: [passkey.id] }));
}

async function finish(request, env, url, owner, { request: text, response }) {
  const busy = await cannot(env);
  if (busy) return busy;
  const nonce = await readChallenge(request, env, "move");
  const bytes = typeof text === "string" && text.length < 4096 ? fromB64url(text) : null;
  const r = bytes && decode(bytes);
  const passkey = await thisPasskey(env, url, owner);
  // Only what start made: this site, its hosting key, this device's passkey.
  if (!nonce || !r || r.kind !== "move" || r.to !== url.origin || r.hosting !== (await hostingKey(env)).publicKey || !passkey
    || r.passkey?.id !== passkey.id || r.passkey.key !== passkey.key || !siteOrigin(r.from, env)) {
    return json({ error: "That didn't work. Try again." }, 400);
  }
  const proof = proofFrom(response, nonce, [await fingerprintOf("move", bytes)]);
  if (!(await checkPasskeyProof(proof, passkey, proof.statements[0])) || !(await spendChallenge(env, nonce))) {
    return json({ error: "Your passkey's signature didn't check. Try again." }, 400);
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO move_in (id, from_origin, request, proof, person, chain, created_at)
    VALUES (1, ?, ?, ?, NULL, NULL, ?)`).bind(r.from, text, JSON.stringify(proof), now()).run();
  const move = b64url(utf8(JSON.stringify({ request: text, proof })));
  return json({ go: `${r.from}/_admin/keys/move?move=${move}` });
}

/**
 * Reads the old site's identity again (its own /.well-known/afterwrd) and keeps it if it says it's moving here: to this
 * address, with this site's hosting key and the passkey that asked. This site's 7 days run from when it first sees that.
 */
async function fetchMove(env, url) {
  const row = await env.DB.prepare("SELECT from_origin, request FROM move_in WHERE id = 1").first();
  if (!row) return json({ error: "There's no move here to check." }, 404);
  const from = siteOrigin(String(row.from_origin), env);
  const asked = decode(fromB64url(String(row.request)));
  const response = from && (await fetch(`${from}/.well-known/afterwrd`, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS) }).catch(() => null));
  if (!response?.ok) return json({ error: `Couldn't reach ${from ? new URL(from).host : "your old site"}. Try again in a moment.` }, 502);
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const chain = bytes.length && bytes.length <= MAX_REPLY ? parseChain(decode(bytes)?.chain) : null;
  const state = chain && (await readIdentity(chain, await seenTimes(env.DB, chain), now()));
  if (!state || state.problem) return json({ error: "Your old site's identity doesn't read cleanly, so it can't move here." }, 400);
  const target = state.pending?.origin === url.origin ? state.pending : state.current.origin === url.origin ? state.current : null;
  const ours = target && target.hosting === (await hostingKey(env)).publicKey
    && target.passkeys.some((p) => p.id === asked.passkey.id && p.key === asked.passkey.key && p.origin === url.origin);
  if (!ours) {
    // Agreed before, and not now: cancelled there. Kept as it now reads, so this page says so (moveIn).
    const had = await env.DB.prepare("UPDATE move_in SET chain = ? WHERE id = 1 AND chain IS NOT NULL")
      .bind(JSON.stringify(chain.map(({ bytes: b, sig }) => ({ bytes: b64url(b), sig })))).run();
    return json({ stage: had.meta.changes ? "cancelled" : "agree" });
  }
  await env.DB.prepare("UPDATE move_in SET person = ?, chain = ? WHERE id = 1")
    .bind(state.id, JSON.stringify(chain.map(({ bytes: b, sig }) => ({ bytes: b64url(b), sig })))).run();
  const move = moveOf(state);
  return json({ stage: state.current.origin === url.origin ? "ready" : "waiting", at: move?.at ?? null });
}

// --- taking the posts: checking every list in the download -------------------------------------------------------------

/**
 * How records in the download find writers' identities and browser keys: the owner's from the move; others' as this
 * site knows them, or from the download's copies of their identities, checked and learnt here (first seen now, so a
 * download can't shorten anyone's 7 days); browser keys from the download, each checked against its identity when used.
 */
function lookupsFor(env, mi) {
  return {
    async identityOf(person) {
      if (person === mi.person) return mi.state;
      const known = await identityState(env, person);
      if (known) return known;
      const row = await env.DB.prepare("SELECT chain, profile FROM identities_move WHERE person = ?").bind(person).first();
      let chain = null;
      try { chain = row && parseChain(JSON.parse(String(row.chain))); } catch {}
      const state = chain && (await learnIdentity(env, chain));
      if (!state || state.id !== person) return null;
      let profile = null;
      try { profile = row.profile ? JSON.parse(String(row.profile)) : null; } catch {}
      if (profile && (await checkProfile(profile, state))) {
        await env.DB.prepare("UPDATE identities SET profile = ? WHERE person = ? AND profile IS NULL").bind(JSON.stringify(profile), person).run();
      }
      return state;
    },
    async delegationOf(key) {
      const row = await env.DB.prepare("SELECT bytes, proof FROM known_delegations_move WHERE key = ?").bind(key).first();
      try { return row ? { bytes: String(row.bytes), proof: JSON.parse(String(row.proof)) } : null; } catch { return null; }
    },
  };
}

/**
 * Checks the next lists in the download (after `after`, in id order) as any reader would, against the identity as it
 * was (the old site's hosting key signed them), and works each post's row out again from its list rather than trust
 * the download's. Each list checked is noted (move_checked), with its checkpoints signed by this site's hosting key;
 * Bring everything over takes only lists noted with the same length and running fingerprint. Returns {next}: where to
 * carry on from, or null once every list has been checked; or {problem}.
 */
export async function verifyLists(env, url, mi, after) {
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS move_checked (list TEXT PRIMARY KEY, n INTEGER NOT NULL, head TEXT NOT NULL, checkpoints TEXT NOT NULL, authored TEXT)").run();
  const { results: lists } = await db.prepare("SELECT id, owner, n, head FROM lists_move WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?")
    .bind(String(after ?? ""), VERIFY_BATCH).all();
  const key = await hostingKey(env);
  const lookups = lookupsFor(env, mi);
  for (const l of lists) {
    const id = String(l.id), owner = String(l.owner), n = Number(l.n), head = String(l.head);
    const { results: pages } = await db.prepare("SELECT entries FROM list_pages_move WHERE list = ? ORDER BY page").bind(id).all();
    let entries;
    try { entries = pages.flatMap((p) => JSON.parse(String(p.entries))); } catch { return { problem: id }; }
    // The end is this site's own signature on the length and running fingerprint the download gives: the list must
    // add up to exactly that, entry by entry, from the start.
    const signedHead = await signHead(key.privateKey, { host: mi.person, list: id, n, head });
    const checked = await checkList({ host: mi.person, hostingKey: key.publicKey, list: id, owner, entries, signedHead, lookups });
    if (checked.problem || checked.upTo !== n || checked.head !== head || entries.length !== n) return { problem: id };
    const item = await db.prepare("SELECT author, content, audience FROM items_move WHERE id = ?").bind(id).first();
    if (item) {
      if (String(item.author) !== owner) return { problem: id };
      const guests = item.audience === "invited"
        ? (await db.prepare("SELECT person FROM item_guests_move WHERE item = ?").bind(id).all()).results.map((r) => String(r.person)) : null;
      const w = itemFromList(id, item, entries, guests);
      await db.prepare(`UPDATE items_move SET content = ?, earlier = ?, edited_at = ?, comments = ?, others = ?, author_last = ?,
        changed_at = ?, version = ?, tally = ? WHERE id = ?`)
        .bind(w.content, w.earlier, w.edited_at, w.comments, w.others, w.author_last, now(), w.version, w.tally, id).run();
    }
    const checkpoints = [];
    for (let at = CHECKPOINT; at <= n; at += CHECKPOINT) {
      checkpoints.push({ n: at, signed: JSON.stringify(await signHead(key.privateKey, { host: mi.person, list: id, n: at, head: entries[at - 1].head })) });
    }
    // Others' records on it, indexed again here (sentchecks.js): those deleted or removed with no writer (decision 7).
    const authored = checked.entries.filter((e) => (e.record ? e.record.author !== mi.person : true))
      .map((e) => ({ fp: e.fp, author: e.record?.author ?? null, n: e.n, taken: e.taken }));
    await db.prepare("INSERT OR REPLACE INTO move_checked (list, n, head, checkpoints, authored) VALUES (?, ?, ?, ?, ?)")
      .bind(id, n, head, JSON.stringify(checkpoints), JSON.stringify(authored)).run();
  }
  return { next: lists.length === VERIFY_BATCH ? String(lists.at(-1).id) : null };
}

/**
 * What Bring everything over adds for a move with its identity, in its one transaction (move.js), as SQL statements:
 * fails as a whole if any list wasn't checked as it now is. The owner's identity becomes this site's.
 * @param {{ person: string, chain: { bytes: Uint8Array, sig: any }[], state: any }} mi
 */
export function identityStatements(url, mi) {
  const move = moveOf(mi.state);
  return [
    // Every list that came, checked as it now is (verifyLists): otherwise none of this happens.
    [`SELECT CASE WHEN EXISTS (SELECT 1 FROM lists_move l WHERE l.deleted_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM move_checked c WHERE c.list = l.id AND c.n = l.n AND c.head = l.head)) THEN json('not checked') END`],
    ["INSERT INTO checkpoints (list, n, signed) SELECT c.list, json_extract(j.value, '$.n'), json_extract(j.value, '$.signed') FROM move_checked c, json_each(c.checkpoints) j"],
    [`INSERT OR IGNORE INTO authored (fp, author, list, n, taken) SELECT json_extract(j.value, '$.fp'), json_extract(j.value, '$.author'), c.list,
      json_extract(j.value, '$.n'), json_extract(j.value, '$.taken') FROM move_checked c, json_each(COALESCE(c.authored, '[]')) j`],
    ["INSERT INTO own_identity (id, person, chain, created_at, moving_to, moving_at) VALUES (1, ?, ?, ?, ?, ?)",
      mi.person, JSON.stringify(mi.chain.map(({ bytes, sig }) => ({ bytes: b64url(bytes), sig }))), now(), move?.to ?? null, move?.at ?? null],
    ["DELETE FROM move_in"],
    // Friends: as they were, approved, but never this site itself; and nothing pointing at what didn't come.
    ["DELETE FROM connections WHERE origin = ?", url.origin],
    ["UPDATE connections SET approved_at = COALESCE(approved_at, connected_at, ?), connected_at = COALESCE(connected_at, ?)", now(), now()],
    ["DELETE FROM items WHERE id NOT IN (SELECT id FROM lists WHERE deleted_at IS NULL)"],
    ["DELETE FROM list_pages WHERE list NOT IN (SELECT id FROM lists WHERE deleted_at IS NULL)"],
    ["DELETE FROM item_photos WHERE photo NOT IN (SELECT id FROM items) OR post NOT IN (SELECT id FROM items)"],
    ["DELETE FROM item_guests WHERE item NOT IN (SELECT id FROM items) OR connection_id NOT IN (SELECT id FROM connections)"],
    ["DELETE FROM item_uninvited WHERE item NOT IN (SELECT id FROM lists) OR connection_id NOT IN (SELECT id FROM connections)"],
    ["UPDATE media SET item_id = NULL WHERE item_id IS NOT NULL AND item_id NOT IN (SELECT id FROM items)"],
  ];
}

/**
 * A row of the owner's `sent` (their own records on friends' posts), checked: it must be the record it says, and theirs.
 * @param {Record<string, unknown>} row @param {string} person
 */
export async function sentOk(row, person) {
  try {
    const sent = JSON.parse(String(row.record));
    const bytes = fromB64url(sent.record);
    const record = bytes && decode(bytes);
    return Boolean(record && (await fingerprintOf("record", bytes)) === row.fp && record.author === person && record.host === row.host
      && (record.item ?? row.fp) === row.item && record.kind === row.kind);
  } catch { return false; }
}
