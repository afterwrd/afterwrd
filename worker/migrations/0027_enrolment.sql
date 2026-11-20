-- Adding a device that can sign straight away (afterwrd 2, src/keys.js): when the owner makes a device link on a
-- device that signs for them, its passkey also signs an enrolment for that link's token. The new device's passkey
-- then signs the identity document adding itself, with the token, so other sites can see a current passkey allowed it.
ALTER TABLE device_links ADD COLUMN enrolment TEXT;  -- JSON {statement, proof}, until the link is used
ALTER TABLE credentials ADD COLUMN enrolment TEXT;   -- the same, carried to the passkey the link made, until it joins
