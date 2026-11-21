-- afterwrd 2, step 6c (docs/signed-conversations.md, "6c in detail"): a group's posts are signed items its site hosts,
-- as a friend's posts are hosted by theirs. A member's site keeps copies of a group's newest posts as it does of a
-- friend's (copies), and what to tell its owner about them (notices), so both now say which group, as well as which
-- friend. Neither column can be made optional in place, so both tables are made again, and nothing in them is lost.

CREATE TABLE copies_new (
    id             TEXT PRIMARY KEY,             -- the post's id (its list's)
    connection_id  INTEGER,                      -- the friend whose site holds it, or…
    group_id       INTEGER,                      -- …the group (groups.id) whose site holds it
    author         TEXT NOT NULL,                -- who wrote it (a person id)
    record         TEXT NOT NULL,                -- JSON: its first record, as sent ({record, sig, content, salt})
    content        TEXT NOT NULL,                -- JSON: what it says now ({text, photos: [{item, hash, ..., src, thumbSrc}]})
    earlier        TEXT,                         -- JSON [{text, replaced_at}]: what its words said before
    edited_at      INTEGER,
    comments       INTEGER NOT NULL DEFAULT 0,   -- whether it shows "Comments" or "Comment"
    created_at     INTEGER NOT NULL,             -- when its host took it
    changed_at     INTEGER NOT NULL,             -- when its host last changed it (the host's clock)
    checked_n      INTEGER,                      -- the newest point in its list this site has checked
    checked_head   TEXT,
    tally          TEXT,                         -- JSON: a poll's votes, or an event's answers (the host's word)
    list_n         INTEGER,                      -- where its list was up to when its host last sent it
    list_head      TEXT
);
INSERT INTO copies_new (id, connection_id, author, record, content, earlier, edited_at, comments, created_at, changed_at, checked_n,
    checked_head, tally, list_n, list_head)
  SELECT id, connection_id, author, record, content, earlier, edited_at, comments, created_at, changed_at, checked_n, checked_head,
    tally, list_n, list_head FROM copies;
DROP TABLE copies;
ALTER TABLE copies_new RENAME TO copies;
CREATE INDEX copies_created ON copies(created_at);
CREATE INDEX copies_group ON copies(group_id, created_at) WHERE group_id IS NOT NULL;

CREATE TABLE notices_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,     -- 'post', 'comment', 'mention', 'here' (a group's @here), 'invite', 'changed', 'cancelled'
    fp             TEXT NOT NULL,     -- the record it's about
    connection_id  INTEGER,           -- the friend: whose site it's on, or (own) who wrote it on the owner's post; or…
    group_id       INTEGER,           -- …the group whose site it's on
    own            INTEGER NOT NULL DEFAULT 0, -- 1: on the owner's own post or photo
    item           TEXT NOT NULL,     -- the item it's on (a post, or a photo in one): what an open page asks about
    target         TEXT NOT NULL,     -- where to look: the post (its id), or <post id>/photos/<n> for one of its photos
    actor          TEXT,              -- who wrote it, as their signed profile (or the friend's name here) says
    text           TEXT,              -- the start of it
    created_at     INTEGER NOT NULL,
    UNIQUE (kind, fp)
);
INSERT INTO notices_new (id, kind, fp, connection_id, own, item, target, actor, text, created_at)
  SELECT id, kind, fp, connection_id, own, item, target, actor, text, created_at FROM notices;
DROP TABLE notices;
ALTER TABLE notices_new RENAME TO notices;
CREATE INDEX notices_by_time ON notices(created_at);

-- A group's posts are copied here as of this (the group's clock), and when its site was last asked (this site's clock).
ALTER TABLE groups ADD COLUMN items_since INTEGER;
ALTER TABLE groups ADD COLUMN items_checked_at INTEGER;

-- Mention receipts (receipts.js) about a comment in a group, as well as on a friend's post: which group's site took it.
CREATE TABLE mention_receipts_new (
    fp             TEXT PRIMARY KEY,           -- the comment (its record's fingerprint)
    connection_id  INTEGER,                    -- the friend whose post it's on (the host), or…
    group_id       INTEGER,                    -- …the group whose site holds it
    item           TEXT NOT NULL,              -- the post, or a photo in one
    n              INTEGER NOT NULL,           -- where the host's receipt says it took it…
    head           TEXT NOT NULL,              -- …and the running fingerprint there
    writer         TEXT NOT NULL,              -- who wrote it (a person id)
    state          TEXT NOT NULL,              -- 'unchecked', 'ok', or 'hidden' (the host shows something else at that point)
    created_at     INTEGER NOT NULL,
    checked_at     INTEGER
);
INSERT INTO mention_receipts_new (fp, connection_id, item, n, head, writer, state, created_at, checked_at)
  SELECT fp, connection_id, item, n, head, writer, state, created_at, checked_at FROM mention_receipts;
DROP TABLE mention_receipts;
ALTER TABLE mention_receipts_new RENAME TO mention_receipts;
CREATE INDEX mention_receipts_unchecked ON mention_receipts(connection_id, state);
CREATE INDEX mention_receipts_group ON mention_receipts(group_id, state) WHERE group_id IS NOT NULL;
