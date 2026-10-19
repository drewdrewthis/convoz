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

-- name: NewestReply :one
-- The newest reply of a thread that still reads: the "last reply" under a root.
SELECT * FROM message_rows
WHERE thread_root_id = sqlc.arg(root_id) AND kind <> 'system' AND deleted_at IS NULL
ORDER BY id DESC LIMIT 1;

-- name: ThreadRoots :many
-- The top-level messages of a conversation that have replies, newest reply first: the thread rows under a conversation in the list.
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id IS NULL AND reply_count > 0 AND deleted_at IS NULL AND id > sqlc.arg(floor)
ORDER BY last_reply_id DESC LIMIT sqlc.arg(max_rows);

-- name: WatchContext :many
-- For each message: its thread root (with the root's words) and the message just before it in the same place, the main list or
-- the thread (the root counts as the first message of its thread). One query for a whole batch, so an inbox poll costs no more
-- round trips for 20 items than for one.
SELECT m.id AS message_id,
  CAST(COALESCE(m.thread_root_id, 0) AS INTEGER) AS root_id,
  COALESCE(r.body, '') AS root_body,
  CAST(COALESCE(b.id, 0) AS INTEGER) AS before_id,
  CAST(COALESCE(b.author_id, 0) AS INTEGER) AS before_author_id,
  COALESCE(b.body, '') AS before_body
FROM messages m
LEFT JOIN messages r ON r.id = m.thread_root_id AND r.deleted_at IS NULL
LEFT JOIN messages b ON b.id = (
  SELECT MAX(p.id) FROM messages p
  WHERE p.conversation_id = m.conversation_id AND p.id < m.id AND p.kind <> 'system' AND p.deleted_at IS NULL
    AND ((m.thread_root_id IS NULL AND p.in_main = 1) OR (m.thread_root_id IS NOT NULL AND (p.thread_root_id = m.thread_root_id OR p.id = m.thread_root_id))))
WHERE m.id IN (sqlc.slice(ids));
