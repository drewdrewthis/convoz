-- ===== agent invites (one use, 24 hours; owner ruling 2026-10-18) =====

-- name: InsertInvite :one
INSERT INTO agent_invites (token_hash, hint, maker_id, conversation_id, note, created_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(hint), sqlc.arg(maker_id), sqlc.narg(conversation_id), sqlc.arg(note), sqlc.arg(created_at), sqlc.arg(expires_at))
RETURNING id;

-- name: CountOpenInvitesOfMaker :one
SELECT COUNT(*) FROM agent_invites
WHERE maker_id = sqlc.arg(maker_id) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(now);

-- name: GetOpenInviteByHash :one
SELECT id, hint, maker_id, conversation_id, note, created_at, expires_at FROM agent_invites
WHERE token_hash = sqlc.arg(token_hash) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(now);

-- name: GetOpenInvite :one
SELECT id, hint, maker_id, conversation_id, note, created_at, expires_at FROM agent_invites
WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(now);

-- name: ListOpenInvites :many
SELECT id, hint, maker_id, conversation_id, note, created_at, expires_at FROM agent_invites
WHERE used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(now)
  AND (sqlc.arg(maker_id) = 0 OR maker_id = sqlc.arg(maker_id))
ORDER BY created_at DESC, id DESC;

-- name: SpendInvite :execrows
UPDATE agent_invites SET used_at = sqlc.arg(used_at), used_kind = sqlc.arg(used_kind), used_request_id = sqlc.arg(used_request_id)
WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(used_at);

-- name: RevokeInvite :execrows
UPDATE agent_invites SET revoked_at = sqlc.arg(revoked_at)
WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > sqlc.arg(revoked_at);

-- name: ListInvitesToExpire :many
SELECT id, maker_id FROM agent_invites
WHERE used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at <= sqlc.arg(now)
ORDER BY expires_at, id LIMIT 100;

-- name: MarkInviteExpired :exec
UPDATE agent_invites SET expired_at = sqlc.arg(now) WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL;

-- name: ListInvitesOfPendingLogins :many
SELECT i.used_request_id AS request_id, i.maker_id, i.note
FROM agent_invites i JOIN machine_requests m ON m.id = i.used_request_id
WHERE i.used_kind = 'login' AND m.state = 'pending' AND m.expires_at > sqlc.arg(now);

-- name: ListInvitesOfPendingSessions :many
SELECT i.used_request_id AS request_id, i.maker_id, i.note
FROM agent_invites i JOIN identity_requests r ON r.id = i.used_request_id
WHERE i.used_kind = 'session' AND r.state = 'pending' AND r.expires_at > sqlc.arg(now);
