-- Lists deleted since a time (groupposts.js and friendhost.js, every pull): only those, not every list there's ever
-- been. Deleted lists stay as rows for good (so an item can't come back under its old id), so without this each pull
-- read more and more as a site or group grew older (security review 2026-11 M9).
CREATE INDEX lists_deleted ON lists(deleted_at) WHERE deleted_at IS NOT NULL;
