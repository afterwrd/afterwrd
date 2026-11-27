-- When this site last asked a friend's or group's site again for posts whose photo links had run out or soon would
-- (friendcopies.js refreshLinks, groupcopies.js refreshGroupLinks), and a friend's site for their profile picture
-- (renewPictures), so a site that can't be reached isn't asked on every page.
ALTER TABLE connections ADD COLUMN links_asked_at INTEGER;
ALTER TABLE connections ADD COLUMN avatar_asked_at INTEGER;
ALTER TABLE groups ADD COLUMN links_asked_at INTEGER;
