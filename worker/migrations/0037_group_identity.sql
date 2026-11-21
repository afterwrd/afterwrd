-- afterwrd 2, step 6a (docs/signed-conversations.md, step 6 plan): a group's identity, owned by the person who made it
-- (identity.js, groupidentity.js). On a member's site, each group is tied to it once it has one. Groups made on afterwrd 1
-- have none, and stay as they are until migration (step 10).
ALTER TABLE groups ADD COLUMN identity TEXT;
