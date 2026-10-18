-- name: PrevReplyID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE thread_root_id = sqlc.arg(root_id) AND id < sqlc.arg(before_id);

-- name: NewestReplyID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE thread_root_id = sqlc.arg(root_id);

-- name: CountThreadUnread :one
SELECT COUNT(*) FROM (
  SELECT id FROM messages
  WHERE thread_root_id = sqlc.arg(root_id) AND broadcast = 0 AND kind <> 'system' AND deleted_at IS NULL
    AND id > sqlc.arg(after) AND author_id <> sqlc.arg(reader_id)
  LIMIT sqlc.arg(max_rows)
);

-- name: CountBroadcastRead :one
SELECT COUNT(*) FROM messages
WHERE thread_root_id = sqlc.arg(root_id) AND broadcast = 1 AND kind <> 'system' AND deleted_at IS NULL
  AND id > sqlc.arg(after) AND id <= sqlc.arg(up_to) AND author_id <> sqlc.arg(reader_id);

-- name: NewestMessageID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE conversation_id = sqlc.arg(conversation_id);

-- name: NewestOfAuthors :one
-- The newest message the given authors wrote in one place, 0 for none: the main list (root 0) or the thread of root.
-- "Seen by" sits under it.
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND kind = 'text' AND deleted_at IS NULL AND author_id IN (sqlc.slice(authors))
  AND ((CAST(sqlc.arg(root) AS INTEGER) = 0 AND in_main = 1) OR (CAST(sqlc.arg(root) AS INTEGER) <> 0 AND (thread_root_id = CAST(sqlc.arg(root) AS INTEGER) OR id = CAST(sqlc.arg(root) AS INTEGER))));
