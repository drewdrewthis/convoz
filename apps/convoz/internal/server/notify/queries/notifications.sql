-- name: InsertSuppressed :exec
-- A repeat of the same trigger for the same person is the same notification (UNIQUE identity, reason, source_seq).
INSERT OR IGNORE INTO notifications (identity_id, reason, source_seq, conversation_id, message_id, topic, urgent, decision, suppressed_reason, created_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(reason), sqlc.arg(source_seq), sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(topic), 0, 'suppressed', sqlc.arg(suppressed_reason), sqlc.arg(at));

-- name: ListNotifications :many
SELECT id, identity_id, reason, decision, suppressed_reason, conversation_id, message_id FROM notifications ORDER BY id LIMIT sqlc.arg(max_rows);
