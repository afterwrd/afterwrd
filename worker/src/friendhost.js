// What this site tells friends' sites about the owner's signed posts (afterwrd 2, step 4b: docs/signed-conversations.md),
// only in signed calls from friends' sites (calls.js friendCalling):
//   GET  /_p/items?since=<t>   the owner's posts changed since `t` (this site's clock), oldest change first, up to 50:
//                              each with its first record as signed, its words now, whether it has comments, its photos
//                              (with links to their files for this friend, as before), where its list is up to, and the
//                              delegations behind its records; and the posts deleted since. "Nothing new" reads a row or two.
//   GET  /_p/items/<id>        one post's whole list, with the signed head, and the delegations, identity chains and
//                              signed profiles of everyone in it, so a reader can check comments from people it doesn't know.
//   POST /_p/records           {sent, delegation}: the calling site's owner's own signed record (a comment, an edit, a
//                              delete) on one of the owner's posts, with the delegation behind it. Answers with the receipt.
import { friendCalling } from "./calls.js";
import { listEntries, readList } from "./hosted.js";
import { identityState } from "./identities.js";
import { checkDelegation } from "./identity.js";
import { ownHost, recordOn } from "./items.js";
import { signedFile } from "./share.js";
import { parseRecord } from "../public/static/records.js";
import { fromB64url } from "../public/static/signed.js";
import { json, now } from "./util.js";

const PAGE = 50;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** The delegations behind records signed with `keys` (browser keys): the owner's own, or ones friends' sites sent. */
async function delegationsFor(db, keys) {
  const list = [...new Set(keys)];
  if (!list.length) return {};
  const json = JSON.stringify(list);
  const [own, known] = await db.batch([
    db.prepare("SELECT key, bytes, proof FROM delegations WHERE key IN (SELECT value FROM json_each(?))").bind(json),
    db.prepare("SELECT key, bytes, proof FROM known_delegations WHERE key IN (SELECT value FROM json_each(?))").bind(json),
  ]);
  return Object.fromEntries([...own.results, ...known.results].map((r) => [String(r.key), { bytes: String(r.bytes), proof: JSON.parse(String(r.proof)) }]));
}

/** Identity chains and signed profiles of `people`: the owner's own, and those this site knows. */
async function peopleFor(db, people) {
  const out = {};
  const own = await db.prepare("SELECT person, chain, profile FROM own_identity WHERE id = 1").first();
  const others = people.filter((p) => p !== own?.person);
  const { results } = others.length ? await db.prepare("SELECT person, chain, profile FROM identities WHERE person IN (SELECT value FROM json_each(?)) AND frozen_at IS NULL")
    .bind(JSON.stringify(others)).all() : { results: [] };
  for (const r of [...(own && people.includes(String(own.person)) ? [own] : []), ...results]) {
    out[String(r.person)] = { chain: JSON.parse(String(r.chain)), ...(r.profile ? { profile: JSON.parse(String(r.profile)) } : {}) };
  }
  return out;
}

const keyOf = (sent) => parseRecord(fromB64url(sent.record))?.key;

export async function handleFriendItems(request, env, url) {
  const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
  const caller = await friendCalling(request, env, url, body);
  if (caller instanceof Response) return caller;
  const db = env.DB;
  if (request.method === "GET" && url.pathname === "/_p/items") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const { results } = await db.prepare(`SELECT i.*, l.n AS list_n, l.head AS list_head FROM items i JOIN lists l ON l.id = i.id
      WHERE i.type = 'post' AND i.changed_at > ? ORDER BY i.changed_at LIMIT ?`).bind(since, PAGE + 1).all();
    const more = results.length > PAGE;
    const rows = results.slice(0, PAGE);
    const { results: gone } = await db.prepare("SELECT id FROM lists WHERE deleted_at > ?").bind(since).all();
    const items = await Promise.all(rows.map(async (r) => {
      const [first] = await listEntries(db, String(r.id));
      const content = JSON.parse(String(r.content));
      const photos = await Promise.all((content.photos ?? []).map(async (p) => ({ ...p,
        src: await signedFile(env, url.origin, p.hash, { friend: caller.connection.id }), thumbSrc: await signedFile(env, url.origin, p.thumb_hash, { friend: caller.connection.id }) })));
      return { id: String(r.id), sent: first.sent, taken: first.taken, content: { ...content, photos },
        earlier: r.earlier ? JSON.parse(String(r.earlier)) : [], edited_at: r.edited_at, comments: Number(r.comments),
        changed_at: Number(r.changed_at), list: { n: Number(r.list_n), head: String(r.list_head) } };
    }));
    return json({ v: 2, items, gone: gone.map((g) => String(g.id)), until: rows.at(-1)?.changed_at ?? since, more,
      delegations: await delegationsFor(db, items.map((i) => keyOf(i.sent))) });
  }
  const one = /^\/_p\/items\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (request.method === "GET" && one) {
    const host = await ownHost(env);
    const list = host && (await readList(db, one[1], { host }));
    if (!list) return json({ error: "Not found." }, 404);
    if (list.deleted) return json({ error: "Deleted.", deleted: true }, 410);
    const records = list.entries.filter((e) => e.sent).map((e) => parseRecord(fromB64url(e.sent.record))).filter(Boolean);
    return json({ v: 2, owner: list.owner, entries: list.entries, signedHead: list.signedHead, checkpoint: list.checkpoint ?? null,
      delegations: await delegationsFor(db, records.map((r) => r.key)), people: await peopleFor(db, [...new Set(records.map((r) => r.author))]) });
  }
  if (request.method === "POST" && url.pathname === "/_p/records") {
    let sent = null, delegation = null;
    try { ({ sent, delegation } = JSON.parse(new TextDecoder().decode(body))); } catch {}
    const record = typeof sent?.record === "string" ? parseRecord(fromB64url(sent.record)) : null;
    if (!record || !ID_RE.test(record.item ?? "")) return json({ error: "That didn't work." }, 400);
    // A site passes on only its own owner's records, allowed by a delegation from their identity.
    if (record.author !== caller.person) return json({ error: "That isn't your site's to send." }, 403);
    const state = await identityState(env, caller.person);
    const dBytes = typeof delegation?.bytes === "string" ? fromB64url(delegation.bytes) : null;
    if (!state || !dBytes || (await checkDelegation(dBytes, delegation.proof, state, now())) !== record.key) return json({ error: "That isn't signed by them." }, 400);
    const { expires } = JSON.parse(new TextDecoder().decode(dBytes));
    await db.prepare(`INSERT OR REPLACE INTO known_delegations (key, person, bytes, proof, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(record.key, caller.person, delegation.bytes, JSON.stringify(delegation.proof), expires).run();
    const host = await ownHost(env);
    const answer = await recordOn(env, host, record.item, sent);
    if (answer.refused) return json({ error: answer.refused }, 409);
    return json({ ok: true, receipt: answer.receipt ?? null, n: answer.entry?.n ?? null });
  }
  return json({ error: "Not found." }, 404);
}
