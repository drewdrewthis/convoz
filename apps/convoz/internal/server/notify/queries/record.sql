-- name: InsertNotification :exec
-- One notification per (person, reason, source event): a second write of the same event changes nothing (I-28).
INSERT OR IGNORE INTO notifications (identity_id, reason, source_seq, conversation_id, message_id, topic, urgent, decision, suppressed_reason, created_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(reason), sqlc.arg(source_seq), sqlc.narg(conversation_id), sqlc.narg(message_id), sqlc.arg(topic), sqlc.arg(urgent),
        sqlc.arg(decision), sqlc.narg(suppressed_reason), sqlc.arg(now));
