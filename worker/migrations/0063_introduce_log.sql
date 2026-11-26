-- Introductions a friend's site sent (POST /_p/introduce), kept or not, by day: the daily limit counts every one, so the
-- answer never depends on whom the owner here already knows, has declined or has blocked (security review 2026-11 M3).
CREATE TABLE introduce_log (
    at             INTEGER NOT NULL,
    connection_id  INTEGER NOT NULL
);
CREATE INDEX introduce_log_at ON introduce_log(at);
