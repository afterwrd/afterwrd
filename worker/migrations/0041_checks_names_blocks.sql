-- afterwrd 2, step 7 (docs/signed-conversations.md, "7 in detail"): checking what the owner sent, and blocking.
--
-- sent: what became of each of the owner's records elsewhere, as their site last checked with its host (sentchecks.js).
--   state: NULL there (or not checked yet); 'sending' (sent, no answer yet); 'unsure' (no answer: the host may have
--   taken it); 'waiting' (a delete or leave the host hasn't taken: sent again at each round); 'deleted' (the owner's own
--   delete, taken); 'removed' (by the host or an admin: removed_by); 'missing' (gone with nothing signed saying why);
--   'gone' (the post it was on was deleted, or the group closed); 'unchecked' (no longer a friend or member: not asked)
--   next_at: when to ask again (NULL: never)
ALTER TABLE sent ADD COLUMN state TEXT;
ALTER TABLE sent ADD COLUMN removed_by TEXT;
ALTER TABLE sent ADD COLUMN next_at INTEGER;
ALTER TABLE sent ADD COLUMN checked_at INTEGER;
UPDATE sent SET next_at = created_at + 86400;
CREATE INDEX sent_due ON sent(next_at) WHERE next_at IS NOT NULL;

-- A host's index of the records it took, by fingerprint: so a writer's site can ask what became of its records (one row
-- each), and is told, with each pull, of records signed as its owner that it may not have sent (T6). Not the owner's
-- own records on their own site. `author` goes (NULL) once the record is deleted or removed: nothing kept says whose
-- it was (decision 7); its list and number stay, so its writer can still be told it was deleted or removed.
CREATE TABLE authored (
    fp      TEXT PRIMARY KEY,
    author  TEXT,
    list    TEXT NOT NULL,
    n       INTEGER NOT NULL,
    taken   INTEGER NOT NULL
);
CREATE INDEX authored_by ON authored(author, taken) WHERE author IS NOT NULL;
CREATE INDEX authored_list ON authored(list);

-- Notices about what the owner sent (sentchecks.js): 'removed' and 'missing' (Notifications), and 'forged' (Home, until
-- cleared: something signed as them that their site never sent). `about`: what of theirs ('comment', 'post', 'vote'…).
ALTER TABLE notices ADD COLUMN about TEXT;
ALTER TABLE notices ADD COLUMN dismissed_at INTEGER;

-- People the owner has blocked, by key (decision 20): quietly, so they aren't told.
CREATE TABLE blocks (
    person      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,         -- as they were known when blocked
    created_at  INTEGER NOT NULL
);
