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
// - any content sent beside it matches its salted fingerprint.
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
 * The record `sent` carries, checked: {record, fp, bytes, content, byHost}, with `content` its value (undefined if none
 * was sent, as after it's been deleted). null if it doesn't check.
 * @param {SentRecord} sent @param {Lookups} lookups
 */
export async function checkRecord(sent, { identityOf, delegationOf, at }) {
  try {
    const bytes = typeof sent?.record === "string" ? fromB64url(sent.record) : null;
    const record = bytes && parseRecord(bytes);
    if (!record || typeof sent.sig !== "string") return null;
    const state = await identityOf(record.author);
    if (!state || state.frozen || state.problem === "closed") return null;
    let byHost = false;
    // The hosting key now, or as it was then: a site that has moved since signed its removals with its old one.
    if (record.key === state.current.hosting || record.key === documentAt(state, at).hosting) {
      // A host acting as itself: only on its own items, and only to remove or close.
      if (!HOST_KINDS.has(record.kind) || record.author !== record.host) return null;
      byHost = true;
    } else {
      const delegation = await delegationOf(record.key);
      const dBytes = delegation && fromB64url(delegation.bytes);
      if (!dBytes || (await checkDelegation(dBytes, delegation.proof, state, at)) !== record.key) return null;
    }
    if (!(await checkAs("record", record.key, bytes, sent.sig))) return null;
    let content;
    if (sent.content !== undefined) {
      if (!WITH_CONTENT.has(record.kind)) return null;
      content = await contentOf(record, sent.content, sent.salt);
      if (content === undefined) return null;
    }
    return { record, fp: await fingerprintOf("record", bytes), bytes, content, byHost };
  } catch { return null; }
}
