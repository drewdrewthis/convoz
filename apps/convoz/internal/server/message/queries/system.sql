-- name: InsertSystemLine :one
-- A system line: no author, plain words in body, ids only in system_json.
INSERT INTO messages (conversation_id, author_id, kind, format, body, system_json, created_at)
VALUES (sqlc.arg(conversation_id), NULL, 'system', 'plain', sqlc.arg(body), sqlc.arg(system_json), sqlc.arg(created_at))
RETURNING id;

-- name: NewestMessageID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE conversation_id = sqlc.arg(conversation_id);

-- name: SessionsOfMessages :many
SELECT id, session_id FROM messages WHERE id IN (sqlc.slice(ids)) AND session_id IS NOT NULL;

-- name: ThreadReplies :many
SELECT id, conversation_id, author_id, kind, format, body, created_at
FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id = sqlc.arg(root_id) AND deleted_at IS NULL AND id > sqlc.arg(floor)
ORDER BY id LIMIT sqlc.arg(max_rows);
