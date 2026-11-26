-- What friends' sites may see of the Facebook download (share.js): its posts, its photos, both or neither. Until now it
-- was whatever was published from it. Sites keep that, so nothing changes for anyone: Posts and Photos as published.
-- From here, a new import starts with neither, and Memories switches either on or off.
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'friends_see', (SELECT json_group_array(j.value) FROM settings s, json_each(s.value) j
    WHERE s.key = 'sections' AND j.value IN ('posts', 'photos'))
  WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'sections');
