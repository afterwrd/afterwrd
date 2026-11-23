-- afterwrd 2, step 10e (docs/signed-conversations.md, "10e in detail"): an afterwrd 1 group's posts and comments, re-signed
-- by whoever wrote them, from their own copy (beforehistory.js).
--
-- On a writer's site: what the group's site said about each of the owner's posts and comments there (group_mine). For a
-- post, `offer`: exactly what its signed item will say, as the group offered it and checked here against this copy
-- (JSON: {host, post, photos, calloffs}), ready for the owner's browser to sign. For a comment: the item it's on now
-- (`item`), the group's identity (`host`), where its list was (`seen`), what the owner's first comment there follows
-- (`prev`: their own post, if it was theirs) and until when the group waits for it. `host_at`: when the group has it
-- written (signed as `before`, if it's within a day of this site's own time for it). `asked_at`: when its site was last
-- asked.
ALTER TABLE group_mine ADD COLUMN offer TEXT;
ALTER TABLE group_mine ADD COLUMN item TEXT;
ALTER TABLE group_mine ADD COLUMN host TEXT;
ALTER TABLE group_mine ADD COLUMN host_at INTEGER;
ALTER TABLE group_mine ADD COLUMN seen TEXT;
ALTER TABLE group_mine ADD COLUMN prev TEXT;
ALTER TABLE group_mine ADD COLUMN until INTEGER;
ALTER TABLE group_mine ADD COLUMN asked_at INTEGER;

-- On the group's own site: nothing new. `brought` notes which item each old post became ('gpost-<its number>'), and
-- `before_comments` holds the comments made on it before (their ids from group_comments: a group's site has no comments
-- of its own) while they wait for their writers. When the group came over (its identity: groupidentity.js) is kept in
-- settings as 'group_brought_at', set there from now on.
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'group_brought_at', CAST(created_at AS TEXT) FROM own_identity WHERE id = 1 AND EXISTS (SELECT 1 FROM group_members_before);
