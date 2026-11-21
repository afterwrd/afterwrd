-- afterwrd 2, step 5 (docs/signed-conversations.md, decision 18): mention receipts. When someone mentions the owner here in
-- a comment on a friend's post, the writer's own site sends the host's receipt for it too (receipts.js), so this site
-- hears even if the host never says, and checks the host shows it the same conversation at that point.
CREATE TABLE mention_receipts (
    fp             TEXT PRIMARY KEY,           -- the comment (its record's fingerprint)
    connection_id  INTEGER NOT NULL,           -- the friend whose post it's on (the host)
    item           TEXT NOT NULL,              -- the post, or a photo in one
    n              INTEGER NOT NULL,           -- where the host's receipt says it took it…
    head           TEXT NOT NULL,              -- …and the running fingerprint there
    writer         TEXT NOT NULL,              -- who wrote it (a person id)
    state          TEXT NOT NULL,              -- 'unchecked' (the host couldn't be asked yet), 'ok', or 'hidden' (the host
                                               -- shows something else at that point)
    created_at     INTEGER NOT NULL,
    checked_at     INTEGER
);
CREATE INDEX mention_receipts_unchecked ON mention_receipts(connection_id, state);
