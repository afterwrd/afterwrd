-- afterwrd 2, step 10d (docs/signed-conversations.md, "10d in detail"): groups from afterwrd 1, carried over in place.
-- On a group's own site: once its owner brings it over (its identity: groupidentity.js), the members it had move here
-- from group_members (they have no identity yet, so they aren't members of the signed group), and each may re-join by
-- their site's address for 30 days, with their own signed `join` (beforegroups.js), which its owner's browser approves.
CREATE TABLE group_members_before (
    origin       TEXT PRIMARY KEY,   -- their site's address
    name         TEXT NOT NULL,
    role         TEXT NOT NULL,      -- as it was (admins come back as members)
    since        INTEGER NOT NULL,   -- when the group came over: they may re-join for 30 days from then
    rejoined_at  INTEGER
);
-- On owners' and members' sites: when an afterwrd 1 group came over (its owner gave it an identity; a member re-joined
-- it), and when its site was last asked about it (whether it has come over; who from before is waiting to be let in).
ALTER TABLE groups ADD COLUMN brought_at INTEGER;
ALTER TABLE groups ADD COLUMN before_asked_at INTEGER;
