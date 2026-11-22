// When a site learnt each delegation, and when each identity it knows last changed (its profile included), so a
// group's answer to a member's pull sends only the people and delegations learnt since that member last asked
// (docs/signed-conversations.md, step 9, option 1A: the scale run's group of 1,000 read about 2 million rows a day
// sending members what they already had). And conversations as this site checked them (threads.js, option 3A), so
// opening one again asks only for what's new; they go with their copy. A code step, not an .sql file, only because
// .sql files are split at semicolons (migrate.js) and a trigger's body has its own.

/** @param {D1Database} db */
export default async function learnt(db) {
  return [
    db.prepare("ALTER TABLE known_delegations ADD COLUMN learnt_at INTEGER"),
    db.prepare("CREATE INDEX known_delegations_learnt ON known_delegations(learnt_at)"),
    db.prepare("CREATE INDEX identities_updated ON identities(updated_at)"),
    // A new name (a signed profile) counts as a change, wherever it's kept.
    db.prepare(`CREATE TRIGGER identities_profile_changed AFTER UPDATE OF profile ON identities WHEN NEW.profile IS NOT OLD.profile BEGIN
      UPDATE identities SET updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE person = NEW.person;
    END`),
    db.prepare(`CREATE TABLE thread_cache (
      list     TEXT NOT NULL,     -- the conversation's list: a friend's or group's post (copies.id)
      page     INTEGER NOT NULL,  -- entries in pages of 50, from the first kept
      entries  TEXT NOT NULL,     -- JSON: each entry as checked (threads.js)
      PRIMARY KEY (list, page)
    )`),
    db.prepare(`CREATE TRIGGER thread_cache_copy_gone AFTER DELETE ON copies BEGIN
      DELETE FROM thread_cache WHERE list = OLD.id;
    END`),
    // A group's members list, kept by its members' sites (groupjoin.js), goes with the group.
    db.prepare(`CREATE TRIGGER thread_cache_group_gone AFTER DELETE ON groups WHEN OLD.identity IS NOT NULL BEGIN
      DELETE FROM thread_cache WHERE list = OLD.identity;
    END`),
  ];
}
