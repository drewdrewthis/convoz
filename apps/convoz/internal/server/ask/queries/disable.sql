-- name: AsksToCloseOnDisable :many
-- The open and the dismissed asks of an agent in every conversation (I-38).
SELECT message_id, conversation_id, state, version FROM asks
WHERE asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed');

-- name: CloseAskAgentRevoked :exec
UPDATE asks
SET state = 'closed', close_reason = 'agent_revoked', resolved_by = NULL, resolved_at = NULL, version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id);
