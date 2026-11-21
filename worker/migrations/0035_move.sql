-- afterwrd 2, step 4f (docs/signed-conversations.md, "4f in detail"): moving a site with its identity. The old site's
-- passkey signs a change of address to the new site (its hosting key and passkey), which waits 7 days like any slow
-- change; then the posts move with Download everything, and friends' sites follow.

-- A change of address the owner has signed, waiting or done: where to, and from when (by this site's clock). On the old
-- site, once that's passed, friends' calls are told where the owner has gone, and nothing new is taken.
ALTER TABLE own_identity ADD COLUMN moving_to TEXT;
ALTER TABLE own_identity ADD COLUMN moving_at INTEGER;

-- The same for other people, as this site reads their identity: a friend's site whose identity has moved is called at
-- its new address from then (calls.js), and Home says they're moving meanwhile.
ALTER TABLE identities ADD COLUMN moving_to TEXT;
ALTER TABLE identities ADD COLUMN moving_at INTEGER;
CREATE INDEX identities_moving ON identities(moving_to);

-- On a new site, a move here from another (move.js): the request this site's passkey signed, then the old site's
-- identity once its owner has agreed there. Gone once the posts have moved and the identity is this site's own.
CREATE TABLE move_in (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    from_origin  TEXT NOT NULL,               -- the old site
    request      TEXT NOT NULL,               -- base64url: {v: 2, kind: "move", from, to, hosting, passkey, at}
    proof        TEXT NOT NULL,               -- JSON: this site's passkey's signature of it
    person       TEXT,                        -- the identity moving here, once the old site has signed the move
    chain        TEXT,                        -- JSON [{bytes, sig}]: that identity, the move included
    created_at   INTEGER NOT NULL
);

-- The owner's browser keys, kept for good beside others' (keys.js rememberOwn): readers need them to check what each
-- signed after it stops signing (signed out, or its 30 days over), and a site the owner moves to needs them too.
INSERT OR IGNORE INTO known_delegations (key, person, bytes, proof, expires_at)
  SELECT d.key, o.person, d.bytes, d.proof, d.expires_at FROM delegations d, own_identity o;
