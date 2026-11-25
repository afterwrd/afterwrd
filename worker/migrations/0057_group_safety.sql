-- Groups (docs/safety-plan.md 3.4).
-- On a group's site: members an admin removed, by key, so they can't ask to join again with an invite link until an
-- admin lets them (leaving doesn't put anyone here; nor does turning down a request). Their name, as the members list
-- had it, for the admins' page.
-- `clearing`: an admin asked to clear up what they wrote, and there's more to go (done a few hundred at a time).
CREATE TABLE group_removed (
    person      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    removed_at  INTEGER NOT NULL,
    clearing    INTEGER NOT NULL DEFAULT 0
);
-- The group's rules, if its owner or an admin has written some: shown on the invite and before joining, and on the
-- group's pages. (On a member's site, `groups` rows are its memberships; the column is there too, unused.)
ALTER TABLE groups ADD COLUMN rules TEXT;
