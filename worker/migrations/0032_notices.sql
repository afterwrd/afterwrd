-- afterwrd 2, step 4c (docs/signed-conversations.md): what to tell the owner about signed posts, from the notes friends'
-- sites send (notes.js) and from comments on the owner's own posts. One row per record and kind, so a note that
-- arrives twice is told once. (The old `inbox` keeps only the old kinds until step 4e.)
CREATE TABLE notices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,     -- 'post' (a friend's new post: the live bar only), 'comment', 'mention'
    fp             TEXT NOT NULL,     -- the record it's about
    connection_id  INTEGER NOT NULL,  -- the friend: whose site it's on, or (own) who wrote it on the owner's post
    own            INTEGER NOT NULL DEFAULT 0, -- 1: on the owner's own post or photo
    item           TEXT NOT NULL,     -- the item it's on (a post, or a photo in one): what an open page asks about
    target         TEXT NOT NULL,     -- where to look: the post (its id), or <post id>/photos/<n> for one of its photos
    actor          TEXT,              -- who wrote it, as their signed profile (or the friend's name here) says
    text           TEXT,              -- the start of it
    created_at     INTEGER NOT NULL,
    UNIQUE (kind, fp)
);
CREATE INDEX notices_by_time ON notices(created_at);
