-- afterwrd 2, step 10c (docs/signed-conversations.md, "10 in detail"): the comments made before afterwrd 2 on posts
-- brought over (0046), re-signed by whoever wrote them, from their own copy (before.js). The host keeps each old comment
-- here while it waits: for its writer's signed record (`sent`, and when it came), or for them to say they have no copy
-- of it ('declined'). Once none is waiting, or the 30 days are up, the item's comments go into its list in the order
-- they were first written, and the item takes new records again.
CREATE TABLE before_comments (
    id         INTEGER PRIMARY KEY,           -- its id in comments
    item       TEXT NOT NULL,                 -- the item it's on now
    origin     TEXT NOT NULL,                 -- who wrote it: 'site' (the owner here) or their site's address
    at         INTEGER NOT NULL,              -- when it was first written
    state      TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'signed', 'declined')),
    sent       TEXT,                          -- the signed record, once it's come
    signed_at  INTEGER                        -- when it came (the time it's taken at, so its delegation checks)
);
CREATE INDEX before_comments_item ON before_comments(item);
-- The writer's side: what the host said about each comment the owner here made on a friend's post before afterwrd 2
-- (comments_elsewhere): the item it's on now, when the host has it written (signed as `before` if it's within a day of
-- this site's own time for it), where its list was, and until when the host waits for it.
ALTER TABLE comments_elsewhere ADD COLUMN item TEXT;
ALTER TABLE comments_elsewhere ADD COLUMN host_at INTEGER;
ALTER TABLE comments_elsewhere ADD COLUMN seen TEXT;
ALTER TABLE comments_elsewhere ADD COLUMN until INTEGER;
ALTER TABLE comments_elsewhere ADD COLUMN asked_at INTEGER;
