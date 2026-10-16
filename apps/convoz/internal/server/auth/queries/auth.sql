-- ===== bootstrap links =====

-- name: InsertBootstrapLink :exec
INSERT INTO bootstrap_links (token_hash, created_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: GetBootstrapLink :one
SELECT id, created_at, expires_at, used_at FROM bootstrap_links WHERE token_hash = sqlc.arg(token_hash);

-- name: UseBootstrapLink :execrows
UPDATE bootstrap_links SET used_at = sqlc.arg(used_at), used_passkey_id = sqlc.arg(passkey_id)
WHERE id = sqlc.arg(id) AND used_at IS NULL;

-- ===== passkeys =====

-- name: InsertPasskey :one
INSERT INTO passkeys (human_id, credential_id, public_key, sign_count, aaguid, backup_eligible, label, registered_via, destructive_step_up_after, created_at)
VALUES (sqlc.arg(human_id), sqlc.arg(credential_id), sqlc.arg(public_key), sqlc.arg(sign_count), sqlc.arg(aaguid), sqlc.arg(backup_eligible), sqlc.arg(label), sqlc.arg(registered_via), sqlc.arg(destructive_step_up_after), sqlc.arg(created_at))
RETURNING id;

-- name: ListActivePasskeys :many
SELECT id, human_id, credential_id, public_key, sign_count, aaguid, backup_eligible, label, registered_via, destructive_step_up_after, created_at, last_used_at
FROM passkeys WHERE human_id = sqlc.arg(human_id) AND revoked_at IS NULL ORDER BY id;

-- name: GetActivePasskeyByCredential :one
SELECT id, human_id, credential_id, public_key, sign_count, aaguid, backup_eligible, label, registered_via, destructive_step_up_after, created_at, last_used_at
FROM passkeys WHERE credential_id = sqlc.arg(credential_id) AND revoked_at IS NULL;

-- name: TouchPasskey :exec
UPDATE passkeys SET sign_count = sqlc.arg(sign_count), last_used_at = sqlc.arg(last_used_at) WHERE id = sqlc.arg(id);

-- name: RevokePasskey :execrows
UPDATE passkeys SET revoked_at = sqlc.arg(revoked_at)
WHERE id = sqlc.arg(id) AND human_id = sqlc.arg(human_id) AND revoked_at IS NULL;

-- name: CountActivePasskeys :one
SELECT COUNT(*) FROM passkeys WHERE human_id = sqlc.arg(human_id) AND revoked_at IS NULL;

-- ===== devices =====

-- name: InsertDevice :one
INSERT INTO devices (human_id, token_hash, passkey_id, label, user_agent, limited, created_at, last_seen_at, expires_at, absolute_expires_at)
VALUES (sqlc.arg(human_id), sqlc.arg(token_hash), sqlc.narg(passkey_id), sqlc.arg(label), sqlc.narg(user_agent), sqlc.arg(limited), sqlc.arg(created_at), sqlc.arg(created_at), sqlc.arg(expires_at), sqlc.arg(absolute_expires_at))
RETURNING id;

-- name: GetDeviceByTokenHash :one
SELECT id, human_id, passkey_id, label, limited, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at
FROM devices WHERE token_hash = sqlc.arg(token_hash);

-- name: SlideDevice :exec
UPDATE devices SET last_seen_at = sqlc.arg(last_seen_at), expires_at = sqlc.arg(expires_at) WHERE id = sqlc.arg(id);

-- name: RevokeDevice :execrows
UPDATE devices SET revoked_at = sqlc.arg(revoked_at), revoke_reason = sqlc.arg(reason)
WHERE id = sqlc.arg(id) AND human_id = sqlc.arg(human_id) AND revoked_at IS NULL;

-- name: RevokeDevicesOfPasskey :exec
UPDATE devices SET revoked_at = sqlc.arg(revoked_at), revoke_reason = 'passkey_revoked'
WHERE passkey_id = sqlc.arg(passkey_id) AND revoked_at IS NULL;

-- name: ListDevices :many
SELECT id, label, limited, created_at, last_seen_at, expires_at
FROM devices WHERE human_id = sqlc.arg(human_id) AND revoked_at IS NULL AND expires_at > sqlc.arg(now) AND absolute_expires_at > sqlc.arg(now)
ORDER BY id;

-- ===== step-ups =====

-- name: InsertStepUp :one
INSERT INTO step_ups (device_id, passkey_id, action, target_id, created_at, expires_at)
VALUES (sqlc.arg(device_id), sqlc.arg(passkey_id), sqlc.arg(action), sqlc.narg(target_id), sqlc.arg(created_at), sqlc.arg(expires_at))
RETURNING id;

-- name: ConsumeStepUp :execrows
UPDATE step_ups SET used_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND device_id = sqlc.arg(device_id) AND action = sqlc.arg(action)
  AND target_id IS sqlc.narg(target_id) AND used_at IS NULL AND expires_at > sqlc.arg(now);

-- ===== recovery codes =====

-- name: InsertRecoveryCode :exec
INSERT INTO recovery_codes (human_id, code_hash, batch, created_at)
VALUES (sqlc.arg(human_id), sqlc.arg(code_hash), sqlc.arg(batch), sqlc.arg(created_at));

-- name: MaxRecoveryBatch :one
SELECT CAST(COALESCE(MAX(batch), 0) AS INTEGER) FROM recovery_codes WHERE human_id = sqlc.arg(human_id);

-- name: RevokeUnusedRecoveryCodes :exec
UPDATE recovery_codes SET revoked_at = sqlc.arg(revoked_at)
WHERE human_id = sqlc.arg(human_id) AND used_at IS NULL AND revoked_at IS NULL;

-- name: UseRecoveryCode :one
UPDATE recovery_codes SET used_at = sqlc.arg(used_at)
WHERE code_hash = sqlc.arg(code_hash) AND used_at IS NULL AND revoked_at IS NULL
RETURNING human_id;
