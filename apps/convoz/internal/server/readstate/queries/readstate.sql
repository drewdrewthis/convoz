-- name: CreateCursor :exec
INSERT INTO read_cursors (identity_id, conversation_id, last_read_main_id, thread_floor_id, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.arg(at_message_id), sqlc.arg(at_message_id), sqlc.arg(at))
ON CONFLICT (identity_id, conversation_id) DO NOTHING;

-- name: GetCursor :one
SELECT last_read_main_id FROM read_cursors WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: MoveCursor :execrows
UPDATE read_cursors SET last_read_main_id = sqlc.arg(main_id), updated_at = sqlc.arg(at)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND last_read_main_id < sqlc.arg(main_id);

-- name: MoveCursorIfCaughtUp :execrows
UPDATE read_cursors SET last_read_main_id = sqlc.arg(main_id), updated_at = sqlc.arg(at)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id)
  AND last_read_main_id >= sqlc.arg(prev_last_main_id) AND last_read_main_id < sqlc.arg(main_id);
