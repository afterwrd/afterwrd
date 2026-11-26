-- How many of a friend's posts this site has copied from them today (friendcopies.js copyAllowance): pulls and new-post
-- notes alike, so one friend's site can't use up the account's daily writes by sending thousands (security review
-- 2026-11 H3). One row per friend per day, the day before kept to make "today" easy, older ones cleared.
CREATE TABLE copy_allowance (
    connection_id  INTEGER NOT NULL,
    day            INTEGER NOT NULL,
    n              INTEGER NOT NULL,
    PRIMARY KEY (connection_id, day)
);
