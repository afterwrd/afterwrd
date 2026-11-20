-- afterwrd 2's items (src/items.js): one row for each post (later, each photo, poll and event) this site hosts, as
-- its pages show it. What happened to it, and what proves it, is its list (lists, list_pages): this row is worked out
-- again from that list after every record, so pages read one row an item, and a thread only when it's opened.
CREATE TABLE items (
    id          TEXT PRIMARY KEY,             -- the item's id: its list's (the fingerprint of the record that made it)
    author      TEXT NOT NULL,                -- who wrote it (a person id)
    type        TEXT NOT NULL,                -- 'post' or 'photo'
    content     TEXT NOT NULL,                -- JSON: what it says now ({type, text, photos}), after any edit
    earlier     TEXT,                         -- JSON [{text, replaced_at}]: what its words said before, oldest first
    created_at  INTEGER NOT NULL,             -- when this site took it
    edited_at   INTEGER,
    comments    INTEGER NOT NULL DEFAULT 0,   -- comments that can be seen: whether it shows "Comments" or "Comment"
    others      INTEGER NOT NULL DEFAULT 0,   -- entries by anyone but its writer: once there are any, its words stay
    author_last TEXT NOT NULL,                -- its writer's newest record on it (what their next one follows: lists.js prev)
    changed_at  INTEGER NOT NULL              -- when any of that last changed
);
CREATE INDEX items_created ON items(created_at);

-- Each photo in a signed post is an item of its own (with its own comments), and the post lists them. Its file is a
-- media row as before (photos.js), marked with the photo's item, and item_photos says which post it's in, and where.
ALTER TABLE media ADD COLUMN item_id TEXT;
CREATE TABLE item_photos (
    photo     TEXT PRIMARY KEY,               -- the photo's item id
    post      TEXT NOT NULL,                  -- the post's item id
    position  INTEGER NOT NULL                -- its place among the post's photos, from 0
);
CREATE INDEX item_photos_post ON item_photos(post, position);
