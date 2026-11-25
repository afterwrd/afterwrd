-- Asking a friend's friend to be friends (PROTOCOL.md 8.3 and 8.5). Tapping the name of someone who commented on a
-- friend's post asks that friend's site to pass it on (POST /_p/ask-through): it introduces the asker to them, marked
-- `asked`, and the asker's site then asks as after any introduction. Such an introduction isn't shown as one (it's
-- used at once), and the request says "you're both friends with Ann", not "introduced by".
ALTER TABLE introductions ADD COLUMN asked INTEGER;

-- On the friend's site: requests it passed on, by the friend who asked (`origin`), for its limits (a few a day each).
CREATE TABLE passed_on (
    at      INTEGER NOT NULL,
    origin  TEXT NOT NULL
);
CREATE INDEX passed_on_at ON passed_on(at);
