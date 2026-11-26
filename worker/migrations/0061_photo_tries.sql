-- On a group's site: a member's posts whose photos couldn't be copied from their site, by day (groupposts.js newPost).
-- The post is taken back, and its writes with it, so without counting these a member could repeat it all day past every
-- posting limit (security review 2026-11 M8). A few a day are allowed, for real network trouble.
CREATE TABLE photo_tries (
    identity  TEXT NOT NULL,
    day       INTEGER NOT NULL,
    n         INTEGER NOT NULL,
    PRIMARY KEY (identity, day)
);
