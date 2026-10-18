-- name: InsertConversation :one
INSERT INTO conversations (title, title_source, title_set_by, created_by, created_at, last_activity_at)
VALUES (sqlc.narg(title), sqlc.arg(title_source), sqlc.arg(title_set_by), sqlc.arg(created_by), sqlc.arg(created_at), sqlc.arg(created_at))
RETURNING id;

-- name: GetConversation :one
SELECT * FROM conversations WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: GetConversationAny :one
SELECT * FROM conversations WHERE id = sqlc.arg(id);

-- name: ListAllConversations :many
SELECT * FROM conversations WHERE deleted_at IS NULL
ORDER BY last_activity_at DESC, id DESC LIMIT sqlc.arg(max_rows);

-- name: ListConversationsOfIdentity :many
SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.id
WHERE p.identity_id = sqlc.arg(identity_id) AND p.status = 'active' AND c.deleted_at IS NULL
ORDER BY c.last_activity_at DESC, c.id DESC LIMIT sqlc.arg(max_rows);

-- name: ListTrash :many
SELECT * FROM conversations WHERE deleted_at IS NOT NULL
ORDER BY deleted_at DESC, id DESC LIMIT sqlc.arg(max_rows);

-- name: RecordMainPost :exec
UPDATE conversations
SET last_message_id = sqlc.arg(message_id), last_main_id = sqlc.arg(message_id), last_activity_at = sqlc.arg(at),
    message_count = message_count + 1
WHERE id = sqlc.arg(id);

-- name: TouchActivity :exec
UPDATE conversations SET last_activity_at = max(last_activity_at, sqlc.arg(at)) WHERE id = sqlc.arg(id);

-- name: SetAutoTitle :exec
UPDATE conversations SET title = sqlc.arg(title) WHERE id = sqlc.arg(id) AND title IS NULL AND title_source = 'auto';

-- name: SetTitle :exec
UPDATE conversations SET title = sqlc.narg(title), title_source = 'manual', title_set_by = sqlc.arg(title_set_by) WHERE id = sqlc.arg(id);

-- name: SetLink :exec
UPDATE conversations SET link_url = sqlc.narg(link_url) WHERE id = sqlc.arg(id);

-- name: SoftDelete :execrows
UPDATE conversations SET deleted_at = sqlc.arg(at), deleted_by = sqlc.arg(by) WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: Restore :execrows
UPDATE conversations SET deleted_at = NULL, deleted_by = NULL WHERE id = sqlc.arg(id) AND deleted_at IS NOT NULL;

-- name: PurgeTrashBefore :execrows
DELETE FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < sqlc.arg(before);

-- name: EmptyUntitledIDs :many
-- Candidates for the empty-conversation cleanup (I-20): nothing sent, no title a person chose (an agent's rename does not count), older than the cutoff.
SELECT id FROM conversations
WHERE message_count = 0 AND title_set_by <> 'human' AND deleted_at IS NULL AND created_at < sqlc.arg(before)
ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: DeleteEmptyConversation :execrows
-- Re-checks the conditions in the same statement, so a send that races the cleanup keeps the conversation.
DELETE FROM conversations
WHERE id = sqlc.arg(id) AND message_count = 0 AND title_set_by <> 'human' AND deleted_at IS NULL AND created_at < sqlc.arg(before);

-- name: GetParticipant :one
SELECT status, joined_message_id FROM participants
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id);

-- name: GetParticipantFull :one
SELECT * FROM participants WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id);

-- name: SetLastPostSession :exec
-- The inbox prefers the session of an agent that posted last in this conversation (design 3.8).
UPDATE participants SET last_post_session_id = sqlc.arg(session_id)
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id);

-- name: ListActiveParticipants :many
SELECT identity_id, joined_message_id FROM participants
WHERE conversation_id = sqlc.arg(conversation_id) AND status = 'active'
ORDER BY added_at, identity_id;

-- name: ListParticipantsByStatus :many
SELECT * FROM participants WHERE conversation_id = sqlc.arg(conversation_id) AND status = sqlc.arg(status)
ORDER BY added_at, identity_id;

-- name: CountLiveParticipants :one
SELECT COUNT(*) FROM participants WHERE conversation_id = sqlc.arg(conversation_id) AND status IN ('active','pending');

-- name: InsertParticipant :exec
INSERT INTO participants (conversation_id, identity_id, status, joined_message_id, joined_seq, added_by, requested_by, added_at, status_at)
VALUES (sqlc.arg(conversation_id), sqlc.arg(identity_id), sqlc.arg(status), sqlc.arg(joined_message_id), sqlc.arg(joined_seq),
        sqlc.arg(added_by), sqlc.narg(requested_by), sqlc.arg(at), sqlc.arg(at));

-- name: ReviveParticipant :exec
-- A person who left, was removed or was declined comes back as a new row of history: same key, new status and floor.
UPDATE participants
SET status = sqlc.arg(status), joined_message_id = sqlc.arg(joined_message_id), joined_seq = sqlc.arg(joined_seq),
    added_by = sqlc.arg(added_by), requested_by = sqlc.narg(requested_by), decided_by = NULL, added_at = sqlc.arg(at), status_at = sqlc.arg(at)
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id);

-- name: DecideParticipant :execrows
UPDATE participants
SET status = sqlc.arg(status), joined_message_id = sqlc.arg(joined_message_id), joined_seq = sqlc.arg(joined_seq),
    decided_by = sqlc.arg(decided_by), status_at = sqlc.arg(at)
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id) AND status = 'pending';

-- name: EndParticipant :execrows
UPDATE participants SET status = sqlc.arg(status), status_at = sqlc.arg(at)
WHERE conversation_id = sqlc.arg(conversation_id) AND identity_id = sqlc.arg(identity_id) AND status = 'active';

-- name: ListPendingOfConversations :many
SELECT p.conversation_id, p.identity_id, p.requested_by, p.status_at FROM participants p
JOIN conversations c ON c.id = p.conversation_id
WHERE p.status = 'pending' AND c.deleted_at IS NULL ORDER BY p.status_at, p.conversation_id;

-- name: CountAgentConversationsSince :one
SELECT COUNT(*) FROM conversations WHERE created_by = sqlc.arg(created_by) AND created_at >= sqlc.arg(since);

-- name: AddOpenAsks :exec
UPDATE conversations SET open_ask_count = max(open_ask_count + sqlc.arg(delta), 0) WHERE id = sqlc.arg(id);
