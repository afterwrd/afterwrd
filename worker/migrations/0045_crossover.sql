-- afterwrd 2, step 10a (docs/signed-conversations.md, "10 in detail"): a friend whose site still answers as afterwrd
-- does, but has no afterwrd 2 identity yet (it's still on afterwrd 1, or has updated and its owner hasn't signed in
-- since). Home says their site hasn't moved yet, rather than that it isn't answering, and it's asked daily, never
-- counted as gone (friendcopies.js). Cleared the first time their site answers with an identity, or stops answering.
ALTER TABLE connections ADD COLUMN unmoved_since INTEGER;
