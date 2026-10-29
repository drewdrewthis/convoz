-- The message an item's thread hangs on: the agent's one message in the item's conversation, posted when the item is created
-- (owner, Drew, 179 msgs 12145-12146: every feed item opens into a thread). NULL for an item made before this and for a message
-- that was not posted; no backfill. Rollback is a data restore of the cold copy taken before the swap: there is no down migration.
-- owner: item
ALTER TABLE feed_items ADD COLUMN thread_root_id INTEGER REFERENCES messages(id);
