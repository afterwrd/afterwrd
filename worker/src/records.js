// Checking a record wherever it arrives (afterwrd 2: docs/signed-conversations.md, section 2): at its host, and at
// every reader. The shape and making of records are in public/static/records.js, shared with the browser.
//
// A record checks when:
// - it's well-formed for its kind (parseRecord);
// - its writer's identity is known and not frozen;
// - the key that signed it was one of their browser keys, allowed by a delegation their identity vouched for at the
//   time (`at`: the host's "taken at", or now for a host receiving it), or, only for a host's own removals and
//   closings, the host's hosting key;
// - the signature is that key's;
// - a kind that carries words comes with them, and they match its salted fingerprint.
// Pure: the caller says how to find identities and delegations. Never throws.
import { contentOf, parseRecord, WITH_CONTENT } from "../public/static/records.js";
import { checkAs, fingerprintOf, fromB64url } from "../public/static/signed.js";
import { checkDelegation, documentAt } from "./identity.js";

/** What a host may sign with its hosting key rather than a person's browser key. */
export const HOST_KINDS = new Set(["remove", "close"]);

/**
 * @typedef {{ record: string, sig: string, content?: string, salt?: string }} SentRecord
 * @typedef {{ identityOf: (person: string) => Promise<any>, delegationOf: (key: string) => Promise<{ bytes: string, proof: any } | null>, at: number }} Lookups
 */

/**
 * The record `sent` carries, checked: {record, fp, bytes, content, byHost}, with `content` its value. null if it doesn't
 * check (recordTrouble says why).
 * @param {SentRecord} sent @param {Lookups} lookups
 */
export async function checkRecord(sent, lookups) {
  const answer = await recordTrouble(sent, lookups);
  return answer.got ?? null;
}

/**
 * checkRecord, saying why a record doesn't check: {got}, or {why}:
 * - "author": its writer's identity isn't known here, or is frozen or closed: nothing they signed can be judged;
 * - "key": no delegation was found for the key that signed it;
 * - "bad": anything else. The record, its signature, its delegation or its words aren't what the writer signed, or a
 *   kind that carries words came without them. Whoever passed it on changed it (the writer's own site never would).
 * @param {SentRecord} sent @param {Lookups} lookups
 * @returns {Promise<{ got?: { record: any, fp: string, bytes: Uint8Array, content: any, byHost: boolean }, why?: "author" | "key" | "bad" }>}
 */
export async function recordTrouble(sent, { identityOf, delegationOf, at }) {
  try {
    const bytes = typeof sent?.record === "string" ? fromB64url(sent.record) : null;
    const record = bytes && parseRecord(bytes);
    if (!record || typeof sent.sig !== "string") return { why: "bad" };
    const state = await identityOf(record.author);
    if (!state || state.frozen || state.problem === "closed") return { why: "author" };
    let byHost = false;
    // The hosting key now, or as it was then: a site that has moved since signed its removals with its old one.
    if (record.key === state.current.hosting || record.key === documentAt(state, at).hosting) {
      // A host acting as itself: only on its own items, and only to remove or close.
      if (!HOST_KINDS.has(record.kind) || record.author !== record.host) return { why: "bad" };
      byHost = true;
    } else {
      const delegation = await delegationOf(record.key);
      const dBytes = delegation && fromB64url(delegation.bytes);
      if (!dBytes) return { why: "key" };
      if ((await checkDelegation(dBytes, delegation.proof, state, at)) !== record.key) return { why: "bad" };
    }
    if (!(await checkAs("record", record.key, bytes, sent.sig))) return { why: "bad" };
    // A kind that carries words always comes with them: once they're deleted, the whole record goes, not just them.
    if (WITH_CONTENT.has(record.kind) !== (sent.content !== undefined)) return { why: "bad" };
    const content = sent.content === undefined ? undefined : await contentOf(record, sent.content, sent.salt);
    if (sent.content !== undefined && content === undefined) return { why: "bad" };
    return { got: { record, fp: await fingerprintOf("record", bytes), bytes, content, byHost } };
  } catch { return { why: "bad" }; }
}
