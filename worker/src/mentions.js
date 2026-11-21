// Mentions (docs/mentions-plan.md): @Ann Example in a post or comment tells Ann, and @here in a group tells everyone in
// it. Signed posts and comments say who they mention by identity (records.js pickedMentions); the owner's posts and
// comments from before signing kept who they mention beside their words, as [{ name, origin }], read back here.
import { says } from "../public/static/records.js";

export { says };

export const MAX_MENTIONS = 10;

/** @typedef {{ name: string, origin: string }} Mention */

/** What the mentions column holds, read back: [] for none or anything unexpected. */
export function readMentions(column) {
  if (!column) return [];
  try {
    const list = JSON.parse(column);
    return Array.isArray(list) ? list.filter((m) => typeof m?.name === "string" && typeof m?.origin === "string") : [];
  } catch {
    return [];
  }
}
