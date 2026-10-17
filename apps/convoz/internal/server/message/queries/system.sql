-- name: ThreadReplies :many
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id = sqlc.arg(root_id) AND id > sqlc.arg(floor)
ORDER BY id LIMIT sqlc.arg(max_rows);
