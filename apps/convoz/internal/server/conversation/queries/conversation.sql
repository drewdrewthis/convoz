-- name: InsertConversation :one
INSERT INTO conversations (title, title_source, created_by, created_at, last_activity_at)
VALUES (sqlc.narg(title), sqlc.arg(title_source), sqlc.arg(created_by), sqlc.arg(created_at), sqlc.arg(created_at))
RETURNING id;

-- name: InsertParticipant :exec
INSERT INTO participants (conversation_id, identity_id, status, added_by, added_at, status_at)
VALUES (sqlc.arg(conversation_id), sqlc.arg(identity_id), 'active', sqlc.arg(added_by), sqlc.arg(at), sqlc.arg(at));

-- name: GetConversation :one
SELECT id, title, created_by, created_at, last_message_id, last_main_id, last_activity_at, message_count
FROM conversations WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: ListAllConversations :many
SELECT id, title, created_by, created_at, last_message_id, last_main_id, last_activity_at, message_count
FROM conversations WHERE deleted_at IS NULL
ORDER BY last_activity_at DESC, id DESC LIMIT sqlc.arg(max_rows);

-- name: ListConversationsOfIdentity :many
SELECT c.id, c.title, c.created_by, c.created_at, c.last_message_id, c.last_main_id, c.last_activity_at, c.message_count
FROM conversations c JOIN participants p ON p.conversation_id = c.id
WHERE p.identity_id = sqlc.arg(identity_id) AND p.status = 'active' AND c.deleted_at IS NULL
ORDER BY c.last_activity_at DESC, c.id DESC LIMIT sqlc.arg(max_rows);

-- name: ListActiveParticipants :many
SELECT identity_id, joined_message_id FROM participants
WHERE conversation_id = sqlc.arg(conversation_id) AND status = 'active'
ORDER BY added_at, identity_id;

-- name: GetParticipant :one
SELECT status, joined_message_id FROM participants
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id);

-- name: RecordMainPost :exec
UPDATE conversations
SET last_message_id = sqlc.arg(message_id), last_main_id = sqlc.arg(message_id), last_activity_at = sqlc.arg(at),
    message_count = message_count + 1
WHERE id = sqlc.arg(id);

-- name: SetAutoTitle :exec
UPDATE conversations SET title = sqlc.arg(title) WHERE id = sqlc.arg(id) AND title IS NULL AND title_source = 'auto';
