-- afterwrd 2, step 6b (docs/signed-conversations.md, step 6 plan): a group's members list is signed (members.js). On a
-- group's site, each member who joined with an identity is recognised by it, and by their signed `join`; group_members is
-- worked out from the list (groupmembers.js). Their keys' columns hold placeholders until step 6e makes the table again.
ALTER TABLE group_members ADD COLUMN identity TEXT;
ALTER TABLE group_members ADD COLUMN join_fp TEXT;
CREATE INDEX group_members_join ON group_members(join_fp);
