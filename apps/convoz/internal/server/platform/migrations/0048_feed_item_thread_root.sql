-- The message an item's thread hangs on: the first message written in the thread, made when the owner first writes there (the item title
-- quoted above his text; owner, Drew, 179 msg 12168). NULL until then, and for every item made before this; no backfill. Creating or moving
-- an item posts no message. Rollback is a data restore of the cold copy taken before the swap: there is no down migration.
-- owner: item
ALTER TABLE feed_items ADD COLUMN thread_root_id INTEGER REFERENCES messages(id);
