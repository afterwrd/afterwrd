-- Lists of items only those invited may see (an event on a person's site: items.audience 'invited'), marked so that
-- once one is deleted, only its guests hear it's gone (friendhost.js GET /_p/items `gone`), from item_uninvited: the
-- rest of the owner's friends never learn it existed.
ALTER TABLE lists ADD COLUMN invited INTEGER NOT NULL DEFAULT 0;
UPDATE lists SET invited = 1 WHERE id IN (SELECT id FROM items WHERE audience = 'invited');
