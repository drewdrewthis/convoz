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
