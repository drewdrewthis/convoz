-- name: ListNotifications :many
SELECT id, identity_id, reason, decision, suppressed_reason, conversation_id, message_id FROM notifications ORDER BY id LIMIT sqlc.arg(max_rows);
