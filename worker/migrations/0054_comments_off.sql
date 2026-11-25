-- Comments off (docs/safety-plan.md 3.1): when the owner of a post turned its comments off (a group's post, its admins:
-- later), or null. While it's set, the site holding the post takes no new comments on it or its photos from anyone but
-- the post's writer (hosted.js takeRecord), and says so when a thread is read (friendhost.js, groupposts.js). It's the
-- host's own choice, as refusing a record always is, so nothing is signed for it and older readers needn't know it.
ALTER TABLE items ADD COLUMN comments_off_at INTEGER;
