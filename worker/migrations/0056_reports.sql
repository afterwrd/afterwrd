-- Telling whoever runs a space about something in it (docs/safety-plan.md 3.3; src/reports.js).
--
-- On the site holding what's reported (a person's, for a comment on one of their posts; a group's, for a post or comment
-- in it): one row a report. `about` is the record's fingerprint, `item` the list it's on, `author` who wrote it, `copy`
-- what it said ({kind, text, photos}), kept until 90 days after it's dealt with even if its writer deletes it, so
-- deleting doesn't make the problem go away. `reporter` is null when they chose not to be named: then nothing here says
-- who (the daily cap is counted in the object's memory). `outcome`: 'removed', 'left' or 'member' (its writer removed
-- from the group), with who dealt with it and any word back.
CREATE TABLE reports (
    id             TEXT PRIMARY KEY,
    item           TEXT NOT NULL,
    about          TEXT NOT NULL,
    author         TEXT NOT NULL,
    reason         TEXT NOT NULL,
    note           TEXT,
    reporter       TEXT,
    reporter_name  TEXT,
    copy           TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    handled_at     INTEGER,
    handled_by     TEXT,
    outcome        TEXT,
    word           TEXT
);
CREATE INDEX reports_about ON reports (about);
CREATE INDEX reports_open ON reports (handled_at, created_at);

-- On the reporter's own site: what its owner reported, and where (a friend, or a group), so it can ask what became of
-- each (hourly, as sent records are: sentchecks.js) and say so quietly in Notifications.
CREATE TABLE reports_sent (
    id             TEXT PRIMARY KEY,
    connection_id  INTEGER,
    group_id       INTEGER,
    item           TEXT NOT NULL,
    post           TEXT NOT NULL,
    reason         TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    outcome        TEXT,
    word           TEXT,
    done_at        INTEGER,
    late_told      INTEGER NOT NULL DEFAULT 0,
    checked_at     INTEGER NOT NULL DEFAULT 0
);
