-- afterwrd 2, step 4e (docs/signed-conversations.md): every call between friends' sites is signed (src/calls.js), so the
-- per-friend passwords go, and so does everything posts used before they were signed: friends' copies of each other's
-- old posts (friend_posts), notes about them (inbox), what the old feed told friends had changed (feed_changed and its
-- triggers, posts.changed_at), and friends' old events copied here (events_elsewhere's friend rows). The owner's own
-- posts, comments, polls and events from before signing stay where they are, theirs alone and read-only, until
-- migration turns them into signed items (step 10); so does what they said on friends' old posts (comments_elsewhere).

-- What the old feed told friends' sites had changed (migrations/0025_feed_changed.js).
DROP TRIGGER IF EXISTS feed_posts_insert;
DROP TRIGGER IF EXISTS feed_posts_update;
DROP TRIGGER IF EXISTS feed_posts_delete;
DROP TRIGGER IF EXISTS feed_comments_insert;
DROP TRIGGER IF EXISTS feed_comments_update;
DROP TRIGGER IF EXISTS feed_comments_delete;
DROP TRIGGER IF EXISTS feed_comment_versions_insert;
DROP TRIGGER IF EXISTS feed_comment_versions_update;
DROP TRIGGER IF EXISTS feed_comment_versions_delete;
DROP TRIGGER IF EXISTS feed_post_versions_insert;
DROP TRIGGER IF EXISTS feed_post_versions_update;
DROP TRIGGER IF EXISTS feed_post_versions_delete;
DROP TRIGGER IF EXISTS feed_media_insert;
DROP TRIGGER IF EXISTS feed_media_update;
DROP TRIGGER IF EXISTS feed_media_delete;
DROP TRIGGER IF EXISTS feed_polls_insert;
DROP TRIGGER IF EXISTS feed_polls_update;
DROP TRIGGER IF EXISTS feed_polls_delete;
DROP TRIGGER IF EXISTS feed_poll_votes_insert;
DROP TRIGGER IF EXISTS feed_poll_votes_update;
DROP TRIGGER IF EXISTS feed_poll_votes_delete;
DROP TRIGGER IF EXISTS feed_events_insert;
DROP TRIGGER IF EXISTS feed_events_update;
DROP TRIGGER IF EXISTS feed_events_delete;
DROP TRIGGER IF EXISTS feed_event_answers_insert;
DROP TRIGGER IF EXISTS feed_event_answers_update;
DROP TRIGGER IF EXISTS feed_event_answers_delete;
DROP TRIGGER IF EXISTS feed_post_audience_insert;
DROP TRIGGER IF EXISTS feed_post_audience_update;
DROP TRIGGER IF EXISTS feed_post_audience_delete;
DROP TRIGGER IF EXISTS feed_users_name;
DROP TRIGGER IF EXISTS feed_connections_name;
DROP TRIGGER IF EXISTS feed_settings_insert;
DROP TRIGGER IF EXISTS feed_settings_update;
DROP TRIGGER IF EXISTS feed_settings_delete;
DROP TABLE IF EXISTS feed_changed;
ALTER TABLE posts DROP COLUMN changed_at;

-- Friends' old posts and the notes about them.
DROP TABLE IF EXISTS friend_posts;
DROP TABLE IF EXISTS inbox;

-- Friends' old events: their signed events are copies now (copies). Groups' stay until groups are signed (step 6).
DELETE FROM events_elsewhere WHERE connection_id IS NOT NULL;
DROP INDEX IF EXISTS events_elsewhere_friend;

-- Friends, without the passwords they called each other with (their_key, key_hash) or the old feed's bookkeeping.
-- key_hash is UNIQUE, which SQLite can't drop from a table, so the table is made again. Ids are never reused
-- (AUTOINCREMENT): the new table carries on from the highest the old one ever gave, so nothing kept about a friend
-- who's gone can attach to someone new.
CREATE TABLE connections_new (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    origin            TEXT NOT NULL UNIQUE,    -- https://their-site
    name              TEXT NOT NULL,           -- their owner's name, as their signed profile said
    identity          TEXT,                    -- their identity: the person id their site signs for
    created_at        INTEGER NOT NULL,
    connected_at      INTEGER,                 -- when asking finished
    approved_at       INTEGER,                 -- when the owner approved them (nothing's shared before)
    invited_as        TEXT,                    -- the person in the Facebook download the link was made for
    via_kind          TEXT,                    -- asked without a link: 'group' or 'introduction'…
    via_name          TEXT,                    -- …and which group, or who introduced them
    avatar_url        TEXT,                    -- their picture, as their site last signed it
    avatar_exp        INTEGER,
    reached_at        INTEGER,                 -- when their site last answered
    missing_since     INTEGER,                 -- when it stopped answering (NULL: it's answering)
    said_no           INTEGER NOT NULL DEFAULT 0, -- 1: it says this site isn't connected
    items_since       INTEGER,                 -- their posts are copied here as of this (their clock)
    items_checked_at  INTEGER                  -- when their site was last asked (this site's clock)
);
INSERT INTO connections_new (id, origin, name, identity, created_at, connected_at, approved_at, invited_as, via_kind, via_name,
    avatar_url, avatar_exp, reached_at, missing_since, said_no, items_since, items_checked_at)
  SELECT id, origin, name, identity, created_at, connected_at, approved_at, invited_as, via_kind, via_name,
    avatar_url, avatar_exp, reached_at, missing_since, said_no, items_since, items_checked_at FROM connections;
-- Numbering carries on from the highest the old table gave: a row there for a moment makes the new table's count start
-- after it.
INSERT INTO connections_new (id, origin, name, created_at)
  SELECT seq, '', '', 0 FROM sqlite_sequence WHERE name = 'connections' AND seq > (SELECT COALESCE(MAX(id), 0) FROM connections_new);
DELETE FROM connections_new WHERE origin = '' AND name = '' AND created_at = 0;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
CREATE INDEX connections_identity ON connections(identity);
