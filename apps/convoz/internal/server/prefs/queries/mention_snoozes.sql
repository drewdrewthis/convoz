-- name: UpsertMentionSnooze :exec
INSERT INTO mention_snoozes (identity_id, conversation_id, until_at, after_id)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.arg(until_at), sqlc.arg(after_id))
ON CONFLICT (identity_id, conversation_id) DO UPDATE SET until_at = excluded.until_at, after_id = excluded.after_id;

-- name: ListMentionSnoozes :many
SELECT conversation_id, until_at, after_id FROM mention_snoozes WHERE identity_id = sqlc.arg(identity_id) AND until_at > sqlc.arg(now);
