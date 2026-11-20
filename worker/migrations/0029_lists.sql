-- afterwrd 2's lists (src/lists.js, src/hosted.js): every item this site hosts has a numbered list of signed records,
-- with a running fingerprint this site signs. Entries are kept 50 to a row, so reading a long list is a few rows, not
-- one per entry (rows read and written are what the free plan counts).
CREATE TABLE lists (
    id          TEXT PRIMARY KEY,             -- the item's id (the fingerprint of the record that made it)
    owner       TEXT NOT NULL,                -- the item's writer: who may change, close and remove on it
    n           INTEGER NOT NULL,             -- entries so far
    head        TEXT NOT NULL,                -- the running fingerprint at n
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER                       -- its owner deleted it: everything on it goes, and this row stays, so the same
                                              -- item can't be put back (with old comments) under its old id
);

CREATE TABLE list_pages (
    list     TEXT NOT NULL,
    page     INTEGER NOT NULL,                -- entries 50 * page + 1 to 50 * (page + 1)
    entries  TEXT NOT NULL,                   -- JSON [{n, fp, taken, head, sent?, by_host?}]
    PRIMARY KEY (list, page)
);

-- The signed head every 500 entries, so a new reader of a long list starts from the nearest one.
CREATE TABLE checkpoints (
    list    TEXT NOT NULL,
    n       INTEGER NOT NULL,
    signed  TEXT NOT NULL,                    -- JSON {bytes, sig}
    PRIMARY KEY (list, n)
);

-- Writers' browser keys, as their sites sent them along with records here: passed on to readers with the records.
CREATE TABLE known_delegations (
    key         TEXT PRIMARY KEY,
    person      TEXT NOT NULL,
    bytes       TEXT NOT NULL,
    proof       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);
