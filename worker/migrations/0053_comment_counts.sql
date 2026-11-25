-- Friends' and groups' posts kept here now keep how many comments their site says they have, not just whether they have
-- any (friendcopies.js commentCount): read every friend's and group's posts again, from the start, at the next asking.
UPDATE connections SET items_since = NULL;
UPDATE groups SET items_since = NULL;
