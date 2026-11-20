-- Other people's identities (afterwrd 2, src/identities.js), learnt as this site meets them: from their own site's
-- /.well-known/afterwrd, or passed along by a site that holds something they wrote. When this site first saw each of
-- their documents is in identity_seen, as for the owner's own.
CREATE TABLE identities (
    person             TEXT PRIMARY KEY,      -- their id: the fingerprint of their first identity document
    origin             TEXT NOT NULL,         -- their site's address, as their identity says now
    chain              TEXT NOT NULL,         -- JSON [{bytes, sig}], oldest first (bytes in base64url)
    origin_checked_at  INTEGER,               -- when this site last fetched their identity from that address itself
    frozen_at          INTEGER,               -- two different versions of their identity were seen: trust nothing signed
    profile            TEXT,                  -- JSON: their signed profile (name), as they or a host sent it
    updated_at         INTEGER NOT NULL
);
CREATE INDEX identities_origin ON identities(origin);

-- The owner's own profile, signed in the background by a browser that signs for them (keys.js): their name, for sites
-- that may see it. Re-signed whenever the name changes or the browser key it was signed with runs out.
ALTER TABLE own_identity ADD COLUMN profile TEXT;
