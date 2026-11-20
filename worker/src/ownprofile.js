// The owner's profile for a browser that signs for them to sign (afterwrd 2: keys.js keeps it). On its own, with only
// the signing library, because every owner page asks for it (photos.js headerMe): importing keys.js there pulled half
// the site into photos.js's imports, and changed the order the Worker's files start in, so a limit another file reads
// as it starts (move.js, MAX_COMMENT) was found before it was set.
import { b64url, decode, encode, fromB64url } from "../public/static/signed.js";
import { now } from "./util.js";

/**
 * The profile for a browser that signs for the owner to sign, in the background (nav.js, static/signprofile.js), when
 * the one kept doesn't say their name now, or the browser key it was signed with has run out; null when it's fine (or
 * signing isn't set up). Base64url.
 */
export async function profileToSign(db, owner) {
  const row = await db.prepare("SELECT person, profile FROM own_identity WHERE id = 1").first();
  if (!row) return null;
  try {
    const kept = row.profile ? JSON.parse(String(row.profile)) : null;
    const said = kept && decode(fromB64url(kept.bytes));
    const until = kept && decode(fromB64url(kept.delegation.bytes))?.expires;
    if (said?.name === owner.name && until > now() + 86400) return null;
  } catch {}
  return b64url(encode({ v: 2, kind: "profile", person: row.person, name: owner.name, at: now() }));
}

