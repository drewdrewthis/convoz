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

-- name: GetThreadFloor :one
SELECT thread_floor_id FROM read_cursors WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: MoveThreadFloor :execrows
UPDATE read_cursors SET thread_floor_id = sqlc.arg(floor_id), updated_at = sqlc.arg(at)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND thread_floor_id < sqlc.arg(floor_id);

-- name: CreateThreadRead :exec
INSERT INTO thread_reads (identity_id, conversation_id, root_id, last_read_id, involved_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.arg(root_id), sqlc.arg(last_read_id), sqlc.arg(at))
ON CONFLICT (identity_id, conversation_id, root_id) DO NOTHING;

-- name: MoveThreadRead :execrows
UPDATE thread_reads SET last_read_id = sqlc.arg(reply_id)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND root_id = sqlc.arg(root_id)
  AND last_read_id < sqlc.arg(reply_id);

-- name: MoveThreadReadIfCaughtUp :execrows
UPDATE thread_reads SET last_read_id = sqlc.arg(reply_id)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND root_id = sqlc.arg(root_id)
  AND last_read_id >= sqlc.arg(prev_last_id) AND last_read_id < sqlc.arg(reply_id);

-- name: ListThreadReads :many
SELECT root_id, last_read_id FROM thread_reads WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: GetThreadRead :one
SELECT last_read_id FROM thread_reads WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND root_id = sqlc.arg(root_id);

-- name: ListPositions :many
-- Every cursor of the identity with the threads it is in there, one row per thread (root_id 0 for a cursor with none).
SELECT rc.conversation_id, rc.last_read_main_id, rc.thread_floor_id,
  CAST(COALESCE(tr.root_id, 0) AS INTEGER) AS root_id, CAST(COALESCE(tr.last_read_id, 0) AS INTEGER) AS last_read_id
FROM read_cursors rc
LEFT JOIN thread_reads tr ON tr.identity_id = rc.identity_id AND tr.conversation_id = rc.conversation_id
WHERE rc.identity_id = sqlc.arg(identity_id);

-- name: DeleteThreadReads :exec
DELETE FROM thread_reads WHERE conversation_id = sqlc.arg(conversation_id) AND root_id = sqlc.arg(root_id);
