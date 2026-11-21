-- afterwrd 2, step 4d (docs/signed-conversations.md): polls and events as signed items. A poll is a post whose content
-- has `poll`; an event is a post whose content is {type: "event", event, text}, seen only by those invited. Votes and
-- answers are records on their lists; what pages show of them is worked out from the list after every record (tally).
ALTER TABLE items ADD COLUMN tally TEXT;                          -- JSON: a poll's votes, or an event's answers, by person
ALTER TABLE items ADD COLUMN audience TEXT NOT NULL DEFAULT 'friends'; -- 'friends', or 'invited' (item_guests)
ALTER TABLE items ADD COLUMN version TEXT;                        -- what votes and answers must name: the item, or the
                                                                  -- owner's latest change that moved the event

-- Who's invited to one of the owner's events: the record says only how many and a salted fingerprint of who.
CREATE TABLE item_guests (
    item           TEXT NOT NULL,
    connection_id  INTEGER NOT NULL,
    person         TEXT NOT NULL,                 -- their identity, as the record's fingerprint was made from
    added_at       INTEGER NOT NULL,
    delivery       TEXT,                          -- what became of the invitation: delivered, refused, unreachable
    PRIMARY KEY (item, connection_id)
);
CREATE INDEX item_guests_connection ON item_guests(connection_id);

-- Invitations taken back, so that friend's site is told it may no longer see the event (friendhost.js since), and
-- nobody else learns it exists.
CREATE TABLE item_uninvited (
    item           TEXT NOT NULL,
    connection_id  INTEGER NOT NULL,
    at             INTEGER NOT NULL,
    PRIMARY KEY (item, connection_id)
);

-- A friend's poll or event as their site last said: its votes or answers (the host's totals, checked when it's opened).
ALTER TABLE copies ADD COLUMN tally TEXT;
-- Where its list was up to when its site last sent it: a real point in it, which a vote or answer signed from Home says
-- it saw (lists.js `seen`).
ALTER TABLE copies ADD COLUMN list_n INTEGER;
ALTER TABLE copies ADD COLUMN list_head TEXT;
