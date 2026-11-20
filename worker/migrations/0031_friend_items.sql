-- afterwrd 2, step 4b (docs/signed-conversations.md): friends' signed posts. Making friends works as before; each friend
-- is tied to their identity (identities.js), and what friends' sites send each other about posts is signed (calls.js).
-- The per-friend passwords (their_key, key_hash) and the old /_peer routes go in step 4e, once nothing uses them.
ALTER TABLE connections ADD COLUMN identity TEXT;        -- their identity: the person id their site signs for
ALTER TABLE connections ADD COLUMN items_since INTEGER;  -- their posts are copied here as of this (their clock)
ALTER TABLE connections ADD COLUMN items_checked_at INTEGER; -- when their site was last asked (this site's clock)
CREATE INDEX connections_identity ON connections(identity);

-- Friends' posts, as this site keeps them for Home (hosts' own pages are what's read when a post is opened). Each came
-- with its first record as signed, checked when it arrived.
CREATE TABLE copies (
    id             TEXT PRIMARY KEY,             -- the post's id (its list's)
    connection_id  INTEGER NOT NULL,             -- the friend whose site holds it
    author         TEXT NOT NULL,                -- who wrote it (a person id)
    record         TEXT NOT NULL,                -- JSON: its first record, as sent ({record, sig, content, salt})
    content        TEXT NOT NULL,                -- JSON: what it says now ({text, photos: [{item, hash, ..., src, thumbSrc}]})
    earlier        TEXT,                         -- JSON [{text, replaced_at}]: what its words said before
    edited_at      INTEGER,
    comments       INTEGER NOT NULL DEFAULT 0,   -- whether it shows "Comments" or "Comment"
    created_at     INTEGER NOT NULL,             -- when its host took it
    changed_at     INTEGER NOT NULL,             -- when its host last changed it (the host's clock)
    checked_n      INTEGER,                      -- the newest point in its list this site has checked
    checked_head   TEXT
);
CREATE INDEX copies_created ON copies(created_at);

-- What this site's owner has signed and sent to friends' posts (comments, edits, deletes), with the host's receipt:
-- their own record of what they said, kept when a host loses or changes it (docs/signed-conversations.md, "Your own
-- record"). The words go when the owner deletes them.
CREATE TABLE sent (
    fp          TEXT PRIMARY KEY,                -- the record's fingerprint
    host        TEXT NOT NULL,                   -- the friend's identity
    item        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    record      TEXT NOT NULL,                   -- JSON: as sent ({record, sig, content?, salt?})
    receipt     TEXT,                            -- JSON: the host's signed head when it took it
    created_at  INTEGER NOT NULL
);
CREATE INDEX sent_item ON sent(item);
