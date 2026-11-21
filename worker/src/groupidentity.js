// A group's identity (afterwrd 2, step 6a: docs/signed-conversations.md, step 6 plan). A group has no devices of its own:
// its identity is owned by the person who made it (identity.js), whose passkey signs its first document once its site
// is set up, and any change to it later. From then on, its site has an identity like a person's site: it publishes it
// (/.well-known/afterwrd, with its owner's beside it), and signs what it does as host with its hosting key.
//
// The owner's site, once the group's Worker is claimed (groupsites.js, membership.js):
//   POST /_groups/<id>/identity/start    -> {nonce, doc, allow}: the group's first identity document (its address, its
//                                         hosting key, and the owner), for one of the owner's passkeys here to sign
//   POST /_groups/<id>/identity/finish   {doc, response}: sent on to the group's site, and kept here as the group's
// The group's site, from its owner's site only (with the owner's key, as today's calls are), once:
//   POST /_group/identity                {chain, owner}: its first identity document, signed, and its owner's identity
import { learnIdentity, parseChain } from "./identities.js";
import { parseIdentity, readIdentity } from "./identity.js";
import { hostingKey, ownIdentity, proofFrom } from "./keys.js";
import { readChallenge, spendChallenge, withChallenge } from "./auth.js";
import { callSite } from "./sites.js";
import { b64url, encode, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { json, now, randomToken } from "./util.js";

const stored = (chain) => chain.map(({ bytes, sig }) => ({ bytes: b64url(bytes), sig }));

// --- the owner's site -------------------------------------------------------------------------------------------------

/** POST /_groups/<id>/identity/(start|finish), for `group` (a row of `groups` here): the owner's only. */
export async function handleGroupIdentity(request, env, url, group, action) {
  const body = await request.json().catch(() => ({}));
  if (group.role !== "owner") return json({ error: "Only the group's owner can do that." }, 403);
  if (group.identity) return json({ error: "This group's identity is already set up." }, 409);
  const own = await ownIdentity(env.DB);
  if (!own) return json({ error: "Set up signing first, in Your devices." }, 409);
  if (action === "/identity/start") {
    let ping;
    try { ping = await callSite(String(group.origin), "/_group/ping"); } catch (error) { return json({ error: `Couldn't reach the group's site: ${error.message}` }, 502); }
    if (typeof ping?.hosting !== "string") return json({ error: "The group's site needs updating to this version first." }, 409);
    const doc = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin: String(group.origin), passkeys: [], hosting: ping.hosting, owner: own.person });
    // Only passkeys that work here (they're tied to an address) and sign for the owner now.
    const allow = own.state.current.passkeys.filter((p) => p.origin === url.origin).map((p) => p.id);
    if (!allow.length) return json({ error: "No passkey here signs for you yet. Let one from Your devices." }, 409);
    const nonce = randomToken();
    return withChallenge(env, "group-identity", nonce, json({ nonce, doc: b64url(doc), allow }));
  }
  if (action === "/identity/finish") {
    const nonce = await readChallenge(request, env, "group-identity");
    const bytes = typeof body.doc === "string" ? fromB64url(body.doc) : null;
    const doc = bytes && parseIdentity(bytes);
    if (!nonce || !doc || doc.owner !== own.person || doc.origin !== group.origin || doc.seq !== 0) return json({ error: "That didn't work. Try again." }, 400);
    const proof = proofFrom(body.response, nonce, [await fingerprintOf("identity", bytes)]);
    const chain = [{ bytes, sig: { passkey: proof } }];
    const state = await readIdentity(chain, () => now(), now(), { owner: own.state });
    if (!state || state.problem || !(await spendChallenge(env, nonce))) return json({ error: "Your passkey's signature didn't check. Try again." }, 400);
    try {
      await callSite(String(group.origin), "/_group/identity", { key: group.their_key,
        body: { chain: stored(chain), owner: stored(own.chain) } });
    } catch (error) { return json({ error: `The group's site didn't take it: ${error.message}` }, 400); }
    // Known here as any identity is (identities.js), and the group tied to it.
    await learnIdentity(env, chain, { owner: own.chain });
    await env.DB.prepare("UPDATE groups SET identity = ? WHERE id = ?").bind(state.id, group.id).run();
    return json({ ok: true, person: state.id });
  }
  return json({ error: "Not found." }, 404);
}

// --- the group's site ---------------------------------------------------------------------------------------------------

/** POST /_group/identity, from the owner's site (`member`: their row in group_members). */
export async function setGroupIdentity(request, env, url, member) {
  if (member.role !== "owner") return json({ error: "Only the group's owner can do that." }, 403);
  const db = env.DB;
  if (await db.prepare("SELECT 1 FROM own_identity WHERE id = 1").first()) return json({ error: "This group's identity is already set up." }, 409);
  const body = await request.json().catch(() => ({}));
  const chain = parseChain(body.chain);
  const ownerChain = parseChain(body.owner);
  if (!chain || chain.length !== 1 || !ownerChain) return json({ error: "That didn't work." }, 400);
  // The owner's identity, as their own site has it: it must be the site that owns this group.
  const owner = await learnIdentity(env, ownerChain);
  if (!owner || owner.frozen || owner.problem || owner.current.origin !== member.origin) return json({ error: "That isn't the owner's identity." }, 400);
  const doc = parseIdentity(chain[0].bytes);
  if (!doc || doc.owner !== owner.id || doc.origin !== url.origin || doc.hosting !== (await hostingKey(env)).publicKey) {
    return json({ error: "That isn't this group's identity." }, 400);
  }
  const state = await readIdentity(chain, () => now(), now(), { owner });
  if (!state || state.problem) return json({ error: "Its signature doesn't check." }, 400);
  const [made] = await db.batch([
    db.prepare("INSERT INTO own_identity (id, person, chain, created_at) SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM own_identity)")
      .bind(state.id, JSON.stringify(stored(chain)), now()),
    db.prepare("INSERT OR IGNORE INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(state.id, now()),
  ]);
  if (!made.meta.changes) return json({ error: "This group's identity is already set up." }, 409);
  return json({ ok: true, person: state.id });
}
