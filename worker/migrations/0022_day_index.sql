-- Memories ("on this day", on Home too) looks for posts from today's date in earlier years. Without this it read posts
-- newest first until it found some, which on a big Facebook archive is thousands of rows on every Home. The query
-- must use this exact expression (archive/routes.js onThisDay) for SQLite to use the index.
CREATE INDEX posts_day ON posts(strftime('%m-%d', created_at, 'unixepoch'), created_at);
