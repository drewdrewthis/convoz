-- name: InsertMessage :one
INSERT INTO messages (conversation_id, author_id, kind, format, body, thread_root_id, broadcast, answers_ask_id, app_json, session_id, device_id, client_id,
                      origin_label, origin_machine, created_at)
VALUES (sqlc.arg(conversation_id), sqlc.arg(author_id), sqlc.arg(kind), sqlc.arg(format), sqlc.arg(body), sqlc.narg(thread_root_id), sqlc.arg(broadcast), sqlc.narg(answers_ask_id),
        sqlc.narg(app_json), sqlc.narg(session_id), sqlc.narg(device_id), sqlc.arg(client_id), sqlc.narg(origin_label), sqlc.narg(origin_machine),
        sqlc.arg(created_at))
RETURNING id;

-- name: InsertSystem :one
INSERT INTO messages (conversation_id, author_id, kind, format, body, system_json, created_at)
VALUES (sqlc.arg(conversation_id), NULL, 'system', 'plain', '', sqlc.arg(system_json), sqlc.arg(created_at))
RETURNING id;

-- name: GetIDByClient :one
SELECT id FROM messages WHERE author_id = sqlc.arg(author_id) AND client_id = sqlc.arg(client_id);

-- name: GetMessage :one
SELECT * FROM message_rows WHERE id = sqlc.arg(id);

-- name: PageNewest :many
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND id > sqlc.arg(floor)
ORDER BY id DESC LIMIT sqlc.arg(max_rows);

-- name: PageAfter :many
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND id > sqlc.arg(after)
ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: PageBefore :many
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND id < sqlc.arg(before) AND id > sqlc.arg(floor)
ORDER BY id DESC LIMIT sqlc.arg(max_rows);

-- name: CountUnread :one
SELECT COUNT(*) FROM (
  SELECT id FROM messages
  WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL
    AND id > sqlc.arg(after) AND author_id <> sqlc.arg(reader_id)
  LIMIT sqlc.arg(max_rows)
);

-- name: BumpReplies :exec
UPDATE messages SET reply_count = reply_count + 1, last_reply_id = sqlc.arg(reply_id), last_reply_at = sqlc.arg(at) WHERE id = sqlc.arg(root_id);

-- name: ApplyEdit :exec
UPDATE messages SET body = sqlc.arg(body), format = sqlc.arg(format), edited_at = sqlc.arg(edited_at) WHERE id = sqlc.arg(id);

-- name: InsertEdit :exec
INSERT INTO message_edits (message_id, prev_body, prev_format, edited_by, edited_at)
VALUES (sqlc.arg(message_id), sqlc.arg(prev_body), sqlc.arg(prev_format), sqlc.arg(edited_by), sqlc.arg(edited_at));

-- name: ListEdits :many
SELECT prev_body, prev_format, edited_by, edited_at FROM message_edits WHERE message_id = sqlc.arg(message_id) ORDER BY id;

-- name: MarkDeleted :execrows
UPDATE messages SET deleted_at = sqlc.arg(at), deleted_by = sqlc.arg(by) WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: ScrubMessage :exec
UPDATE messages
SET body = '', app_json = NULL, app_result_json = NULL, purged_at = sqlc.arg(at),
    deleted_at = COALESCE(deleted_at, sqlc.arg(at)), deleted_by = COALESCE(deleted_by, sqlc.arg(by))
WHERE id = sqlc.arg(id);

-- name: DeleteEdits :exec
DELETE FROM message_edits WHERE message_id = sqlc.arg(message_id);

-- name: DeleteMentions :exec
DELETE FROM mentions WHERE message_id = sqlc.arg(message_id);

-- name: InsertMention :exec
INSERT OR IGNORE INTO mentions (message_id, identity_id) VALUES (sqlc.arg(message_id), sqlc.arg(identity_id));

-- name: ListMentions :many
SELECT identity_id FROM mentions WHERE message_id = sqlc.arg(message_id) ORDER BY identity_id;
