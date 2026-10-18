-- name: MarkSeen :exec
-- The agent's claim covers the message: the first claim to cover it is the time it was seen.
INSERT INTO message_seen (identity_id, message_id, conversation_id, seen_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(message_id), sqlc.arg(conversation_id), sqlc.arg(now))
ON CONFLICT (identity_id, message_id) DO NOTHING;

-- name: SeenSince :many
-- Who has seen the message: every agent with a claim at or above it, and when its first such claim happened.
SELECT identity_id, CAST(MIN(seen_at) AS INTEGER) AS seen_at FROM message_seen
WHERE conversation_id = sqlc.arg(conversation_id) AND message_id >= sqlc.arg(message_id)
GROUP BY identity_id ORDER BY MIN(seen_at), identity_id;
