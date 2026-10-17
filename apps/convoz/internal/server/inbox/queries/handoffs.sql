-- name: InsertHandoff :execrows
-- A retry with the same client id stores nothing and changes nothing (I-24).
INSERT INTO handoffs (identity_id, session_id, body, client_id, created_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(session_id), sqlc.arg(body), sqlc.arg(client_id), sqlc.arg(now))
ON CONFLICT (identity_id, client_id) DO NOTHING;

-- name: HandoffByClient :one
SELECT id, identity_id, session_id, body, client_id, created_at FROM handoffs
WHERE identity_id = sqlc.arg(identity_id) AND client_id = sqlc.arg(client_id);

-- name: HandoffCutoff :one
-- The id of the oldest note that is kept: newer notes of the identity are kept (design section 3.8).
SELECT id FROM handoffs WHERE identity_id = sqlc.arg(identity_id) ORDER BY id DESC LIMIT 1 OFFSET sqlc.arg(skip);

-- name: DeleteHandoffsBefore :exec
DELETE FROM handoffs WHERE identity_id = sqlc.arg(identity_id) AND id < sqlc.arg(first_kept);

-- name: ListHandoffs :many
SELECT id, identity_id, session_id, body, client_id, created_at FROM handoffs
WHERE identity_id = sqlc.arg(identity_id) ORDER BY id DESC LIMIT sqlc.arg(max_rows);

-- name: CountHandoffs :one
SELECT COUNT(*) FROM handoffs WHERE identity_id = sqlc.arg(identity_id);

-- name: ExpiredUnread :many
-- Items that left the queue unread because they were old or were handed out five times; a removal or a lost view is not unread.
SELECT conversation_id, COUNT(*) AS n, MIN(updated_at) AS since
FROM inbox_items
WHERE identity_id = sqlc.arg(identity_id) AND state = 'expired' AND expired_reason IN ('age', 'deliveries') AND conversation_id IS NOT NULL
GROUP BY conversation_id ORDER BY MIN(updated_at), conversation_id;
