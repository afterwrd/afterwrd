-- Home's copies of friends' posts (feed.js askSites), refreshed for less:
-- feed_since: what the friend's site said its posts were as of (peers.js feed), given back next time, so it can answer
--   "nothing new" (a row or two read), or send only the posts that have changed since, instead of all 30 again
--   (docs/speed-and-scale-plan.md, "3,000 people on eight servers").
-- copy_keys: which posts the friend's site last said were its newest (their keys, as JSON), so a refresh that brings
--   only what's changed can tell when one has come into the newest that the copy here hasn't got: then the next
--   refresh asks for them all.
ALTER TABLE connections ADD COLUMN feed_since TEXT;
ALTER TABLE connections ADD COLUMN copy_keys TEXT;
