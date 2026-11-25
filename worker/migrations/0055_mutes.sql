-- Mute (docs/safety-plan.md 3.2): someone whose posts the owner would rather not see, without unfriending or blocking
-- them. By key, as a block is (blocks.js), so it works for group members who aren't friends and holds if they move site.
-- Local only: nobody is told, and nothing is sent.
CREATE TABLE mutes (
    person      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
