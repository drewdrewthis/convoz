-- name: InsertItemStaleItem :exec
-- The server reminds an agent that a started feed item went quiet: one item per quiet spell, no message. It never merges.
INSERT INTO inbox_items (identity_id, reason, conversation_id, feed_item_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'item_stale', sqlc.arg(conversation_id), sqlc.arg(feed_item_id), 1, 0, 0, 'ready', sqlc.arg(now), sqlc.arg(now));

-- name: ItemStaleOf :one
-- The feed item an item_stale reminder is about.
SELECT CAST(feed_item_id AS INTEGER) FROM inbox_items WHERE id = sqlc.arg(id) AND identity_id = sqlc.arg(identity_id) AND reason = 'item_stale';
