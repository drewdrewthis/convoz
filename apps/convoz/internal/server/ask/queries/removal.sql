-- name: AsksToCloseOnRemoval :many
-- The open and the dismissed asks one agent has in one conversation (I-19).
SELECT message_id, state, version FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed');

-- name: CloseAskRemoved :exec
UPDATE asks
SET state = 'closed', close_reason = 'removed', resolved_by = NULL, resolved_at = NULL, version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id);

-- name: InsertAskTransition :exec
INSERT INTO ask_transitions (message_id, version, event, to_state, by_identity, at)
VALUES (sqlc.arg(message_id), sqlc.arg(version), sqlc.arg(event), sqlc.arg(to_state), NULL, sqlc.arg(at));

-- name: AskStatesOf :many
SELECT message_id, state, close_reason FROM asks WHERE message_id IN (sqlc.slice(ids));
