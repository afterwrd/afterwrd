-- afterwrd 2, step 8 (docs/signed-conversations.md, "8 in detail"): daily limits.
--
-- allowances: callers past a quarter of their daily allowance on this site (allowances.js), saved now and then so the
--   object sleeping doesn't start them afresh; everyone else is counted in memory only. One row a caller: today's.
CREATE TABLE allowances (
    person  TEXT PRIMARY KEY,
    day     INTEGER NOT NULL,   -- UTC day number (seconds / 86400)
    calls   INTEGER NOT NULL,
    rows    INTEGER NOT NULL
);

-- usage: requests and rows a day, for the busy-account warning (Cloudflare only). `site` '' is this site's own object;
--   'group:<id>' a group the owner started, as its site last reported it. The last 8 days are kept.
CREATE TABLE usage (
    day           INTEGER NOT NULL,
    site          TEXT NOT NULL,
    requests      INTEGER NOT NULL DEFAULT 0,
    rows_read     INTEGER NOT NULL DEFAULT 0,
    rows_written  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, site)
);

-- notices.author: whose record set it off (their identity), so one writer's mentions and replies are capped across
--   every friend's site and group (notes.js keepNotice), not only by the site they came through.
ALTER TABLE notices ADD COLUMN author TEXT;
CREATE INDEX notices_by_author ON notices(author, created_at) WHERE author IS NOT NULL;
