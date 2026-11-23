-- Device links no longer carry an enrolment (src/keys.js): a new device's passkey starts signing for the owner when a
-- device that already signs lets it (the "allow" change), so nothing about the link itself is ever published.
ALTER TABLE device_links DROP COLUMN enrolment;
ALTER TABLE credentials DROP COLUMN enrolment;
