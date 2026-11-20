// In a group's Worker: how many posts the group has, and how many comments each post has, kept by the database itself
// as they come and go, for the counts its pages show. Counting them on every page read every post, and every comment
// on the page's posts: a year of a few posts a day is a thousand rows on every open by every member
// (docs/speed-and-scale-plan.md, "1,000 sites on a rented server").
//
// A code step, not an .sql file, only because .sql files are split at semicolons (migrate.js) and a trigger's body has
// its own. Nothing is worked out here.

/** @param {D1Database} db */
export default async function groupCounts(db) {
  return [
    db.prepare("ALTER TABLE groups ADD COLUMN post_count INTEGER NOT NULL DEFAULT 0"),
    db.prepare("UPDATE groups SET post_count = (SELECT COUNT(*) FROM group_posts p WHERE p.group_id = groups.id)"),
    db.prepare(`CREATE TRIGGER group_post_added AFTER INSERT ON group_posts BEGIN
      UPDATE groups SET post_count = post_count + 1 WHERE id = NEW.group_id;
    END`),
    db.prepare(`CREATE TRIGGER group_post_gone AFTER DELETE ON group_posts BEGIN
      UPDATE groups SET post_count = post_count - 1 WHERE id = OLD.group_id;
    END`),
    db.prepare("ALTER TABLE group_posts ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0"),
    db.prepare("UPDATE group_posts SET comment_count = (SELECT COUNT(*) FROM group_comments c WHERE c.post_id = group_posts.id)"),
    db.prepare(`CREATE TRIGGER group_comment_added AFTER INSERT ON group_comments BEGIN
      UPDATE group_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    END`),
    db.prepare(`CREATE TRIGGER group_comment_gone AFTER DELETE ON group_comments BEGIN
      UPDATE group_posts SET comment_count = comment_count - 1 WHERE id = OLD.post_id;
    END`),
  ];
}
