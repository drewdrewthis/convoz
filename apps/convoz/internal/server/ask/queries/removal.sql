-- name: AsksToCloseOnRemoval :many
-- The open and the dismissed asks one agent has in one conversation (I-19).
SELECT message_id FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed')
ORDER BY message_id;
