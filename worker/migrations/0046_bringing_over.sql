-- afterwrd 2, step 10b (docs/signed-conversations.md, "10 in detail"): the owner's posts from afterwrd 1 become signed
-- items, brought over by their browser (before.js). `brought` says which item each old post or photo became (by its old
-- address: a post's key, or 'photo-<sha256>'), so old links still lead there and the comments made on it before can
-- follow (10c). Once brought over, an item takes no new comments until those have come (items.before_until). When the
-- update came (crossover_at) starts the 30 days everything has to come over in.
CREATE TABLE brought (
    old   TEXT PRIMARY KEY,
    item  TEXT NOT NULL,
    at    INTEGER NOT NULL
);
ALTER TABLE items ADD COLUMN before_until INTEGER;
INSERT OR IGNORE INTO settings (key, value) VALUES ('crossover_at', CAST(strftime('%s', 'now') AS TEXT));
