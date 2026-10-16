-- name: InsertMessage :one
INSERT INTO messages (conversation_id, author_id, kind, format, body, session_id, device_id, client_id, created_at)
VALUES (sqlc.arg(conversation_id), sqlc.arg(author_id), 'text', sqlc.arg(format), sqlc.arg(body), sqlc.narg(session_id), sqlc.narg(device_id),
        sqlc.arg(client_id), sqlc.arg(created_at))
RETURNING id;

-- name: GetMessageByClient :one
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages WHERE author_id = sqlc.arg(author_id) AND client_id = sqlc.arg(client_id);

-- name: GetMessage :one
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: PageNewest :many
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL AND id > sqlc.arg(floor)
ORDER BY id DESC LIMIT sqlc.arg(max_rows);

-- name: PageAfter :many
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL AND id > sqlc.arg(after)
ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: PageBefore :many
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL
  AND id < sqlc.arg(before) AND id > sqlc.arg(floor)
ORDER BY id DESC LIMIT sqlc.arg(max_rows);

-- name: CountUnread :one
SELECT COUNT(*) FROM (
  SELECT id FROM messages
  WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL
    AND id > sqlc.arg(after) AND author_id <> sqlc.arg(reader_id)
  LIMIT sqlc.arg(max_rows)
);
