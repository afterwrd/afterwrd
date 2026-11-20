-- afterwrd 2's keys (docs/signed-conversations.md, section 1; src/keys.js). None of this is ever in a download
-- (export.js lists what is): an identity moves by a signed change of address, never by copying keys. The site's own
-- hosting key is in settings ('hosting_key'), with its other keys.

-- The owner's identity: one row once they've set up signing (a recovery code, then one passkey prompt).
CREATE TABLE own_identity (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    person      TEXT NOT NULL,                -- the owner's id: the fingerprint of their first identity document
    chain       TEXT NOT NULL,                -- JSON [{bytes, sig}]: every identity document, oldest first (bytes in base64url)
    created_at  INTEGER NOT NULL
);

-- When this site first saw each identity document: a slow change takes effect 7 days after that, never after a time
-- written in it (src/identity.js).
CREATE TABLE identity_seen (
    fp          TEXT PRIMARY KEY,
    first_seen  INTEGER NOT NULL
);

-- Browser keys allowed to sign for the owner: one per browser, for 30 days from signing in. Everything a browser
-- signs goes out through this site, which only passes on what a key listed here signed, so signing out (or removing
-- the passkey) ends a key at once, here, even though its delegation would still check elsewhere until it expires.
CREATE TABLE delegations (
    key            TEXT PRIMARY KEY,          -- the browser key, base64url
    bytes          TEXT NOT NULL,             -- the delegation, base64url, exactly as signed
    proof          TEXT NOT NULL,             -- JSON: the passkey's proof (identity.js PasskeyProof)
    credential_id  TEXT NOT NULL,             -- the passkey that signed it
    session_hash   TEXT,                      -- the session it came with
    expires_at     INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX delegations_session ON delegations(session_hash);
CREATE INDEX delegations_credential ON delegations(credential_id);
