-- Found by the scale run (docs/signed-conversations.md, step 9b), each read whole on busy paths:
-- every signed call from a member looks them up by their site's address;
CREATE INDEX IF NOT EXISTS group_members_origin ON group_members(origin);
-- friends' and members' pulls ask for posts changed since they last asked (friendhost.js, groupposts.js);
CREATE INDEX IF NOT EXISTS items_changed ON items(changed_at);
-- and keeping a notice counts the day's from that friend's site or that group first (notes.js keepNotice).
CREATE INDEX IF NOT EXISTS notices_by_connection ON notices(connection_id, created_at) WHERE connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notices_by_group ON notices(group_id, created_at) WHERE group_id IS NOT NULL;
-- and a comment's or note's members are looked up by identity (groupposts.js queueToPeople, memberNames).
CREATE INDEX IF NOT EXISTS group_members_identity ON group_members(identity);
