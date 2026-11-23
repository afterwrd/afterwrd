-- How many identities new to this site each other site (a group's, a friend's) has had it learn today, so one can't
-- make it learn more than a few thousand a day (identities.js learnPeopleIn). Yesterday's and older rows are dropped.
CREATE TABLE learning (
    host  TEXT NOT NULL,     -- the site that sent them (its address)
    day   INTEGER NOT NULL,  -- days since 1970 (UTC)
    n     INTEGER NOT NULL,
    PRIMARY KEY (host, day)
);
