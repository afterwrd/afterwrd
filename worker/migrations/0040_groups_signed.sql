-- afterwrd 2, step 6e (docs/signed-conversations.md, "6e in detail"): groups are signed only. Members' sites and the
-- group's site know each other by their identities and signed calls, so neither keeps keys for the other any more;
-- groups made on afterwrd 1 keep their posts here (group_*) untouched, read-only, until migration (step 10).
--   groups: no keys (`setup` holds the setup code of a group's site still to be claimed); `closed_at` and `closed_by`:
--     its owner closed it (signed `close` on its members list), and it goes 30 days after; no post count (only old,
--     read-only groups had one)
--   group_members: no keys
--   group_inbox, answer_log: only groups from before had them (signed ones use notices, and no rate log)
--   events_elsewhere: copies of friends' and old groups' events, empty since signing (signed events are copies)

-- Old groups' posts are read-only now: nothing to count (migrations/0024_group_counts.js).
DROP TRIGGER IF EXISTS group_post_added;
DROP TRIGGER IF EXISTS group_post_gone;
DROP TRIGGER IF EXISTS group_comment_added;
DROP TRIGGER IF EXISTS group_comment_gone;

CREATE TABLE groups_new (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    about             TEXT,
    created_at        INTEGER NOT NULL,
    origin            TEXT,              -- a member's site: the group's site (NULL on the group's own site: the group)
    remote_id         INTEGER,
    host_name         TEXT,              -- its owner's name
    setup             TEXT,              -- the setup code of a group's site made here, until it's claimed
    joined_at         INTEGER,
    role              TEXT,
    script            TEXT,              -- a group's Worker this site made (and its account and database)
    account           TEXT,
    database          TEXT,
    here_anyone       INTEGER NOT NULL DEFAULT 0,
    identity          TEXT,              -- the group's identity (none: made on afterwrd 1, kept read-only)
    items_since       INTEGER,
    items_checked_at  INTEGER,
    closed_at         INTEGER,           -- when its owner closed it: it goes 30 days after
    closed_by         TEXT               -- the members list's `close` (its fingerprint)
);
INSERT INTO groups_new (id, name, about, created_at, origin, remote_id, host_name, setup, joined_at, role, script, account, database,
    here_anyone, identity, items_since, items_checked_at)
  SELECT id, name, about, created_at, origin, remote_id, host_name, CASE WHEN joined_at IS NULL THEN their_key END, joined_at, role,
    script, account, database, here_anyone, identity, items_since, items_checked_at FROM groups;
DROP TABLE groups;
ALTER TABLE groups_new RENAME TO groups;
CREATE UNIQUE INDEX groups_remote ON groups(origin, remote_id);

CREATE TABLE group_members_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL,
    origin       TEXT NOT NULL,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',
    created_at   INTEGER NOT NULL,
    approved_at  INTEGER,
    identity     TEXT,                   -- who they are (none: an old group's member, kept for migration)
    join_fp      TEXT,                   -- their signed `join` on the members list
    UNIQUE (group_id, origin)
);
INSERT INTO group_members_new (id, group_id, origin, name, role, created_at, approved_at, identity, join_fp)
  SELECT id, group_id, origin, name, role, created_at, approved_at, identity, join_fp FROM group_members;
DROP TABLE group_members;
ALTER TABLE group_members_new RENAME TO group_members;
CREATE INDEX group_members_join ON group_members(join_fp);

DROP TABLE IF EXISTS group_inbox;
DROP TABLE IF EXISTS answer_log;
DROP TABLE IF EXISTS events_elsewhere;
