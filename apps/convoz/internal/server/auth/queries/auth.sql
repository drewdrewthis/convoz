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

-- name: RevokeDevicesOfPasskey :many
UPDATE devices SET revoked_at = sqlc.arg(revoked_at), revoke_reason = 'passkey_revoked'
WHERE passkey_id = sqlc.arg(passkey_id) AND revoked_at IS NULL
RETURNING id;

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

-- name: CountRecoveryCodesLeft :one
SELECT COUNT(*) FROM recovery_codes WHERE human_id = sqlc.arg(human_id) AND used_at IS NULL AND revoked_at IS NULL;

-- name: UseRecoveryCode :one
UPDATE recovery_codes SET used_at = sqlc.arg(used_at)
WHERE code_hash = sqlc.arg(code_hash) AND used_at IS NULL AND revoked_at IS NULL
RETURNING human_id;

-- ===== device flow (machine requests) =====

-- name: InsertMachineRequest :one
INSERT INTO machine_requests (device_code_hash, user_code, requested_name, host_info, source, source_node, created_at, expires_at, poll_interval_ms)
VALUES (sqlc.arg(device_code_hash), sqlc.arg(user_code), sqlc.arg(requested_name), sqlc.narg(host_info), sqlc.arg(source), sqlc.narg(source_node), sqlc.arg(created_at), sqlc.arg(expires_at), sqlc.arg(poll_interval_ms))
RETURNING id;

-- name: CountPendingRequests :one
SELECT COUNT(*) FROM machine_requests WHERE state = 'pending' AND expires_at > sqlc.arg(now);

-- name: CountPendingRequestsFromSource :one
SELECT COUNT(*) FROM machine_requests WHERE state = 'pending' AND expires_at > sqlc.arg(now) AND source = sqlc.arg(source);

-- name: RequestsFromSource :one
SELECT COUNT(*) AS n, CAST(COALESCE(MIN(created_at), 0) AS INTEGER) AS oldest
FROM machine_requests WHERE source = sqlc.arg(source) AND created_at > sqlc.arg(since);

-- name: GetRequestByDeviceCode :one
SELECT id, state, expires_at, last_poll_at, poll_interval_ms, decided_at, machine_id
FROM machine_requests WHERE device_code_hash = sqlc.arg(device_code_hash);

-- name: TouchRequestPoll :exec
UPDATE machine_requests SET last_poll_at = sqlc.arg(last_poll_at), poll_count = poll_count + 1, poll_interval_ms = sqlc.arg(poll_interval_ms)
WHERE id = sqlc.arg(id);

-- name: ListPendingRequests :many
SELECT id, user_code, requested_name, host_info, source, source_node, created_at, expires_at
FROM machine_requests WHERE state = 'pending' AND expires_at > sqlc.arg(now) ORDER BY created_at, id;

-- name: GetPendingRequest :one
SELECT id, user_code, requested_name, host_info, source, source_node, created_at, expires_at
FROM machine_requests WHERE id = sqlc.arg(id) AND state = 'pending' AND expires_at > sqlc.arg(now);

-- name: DenyRequest :execrows
UPDATE machine_requests SET state = 'denied', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE id = sqlc.arg(id) AND state = 'pending' AND expires_at > sqlc.arg(decided_at);

-- name: DenyAllRequests :execrows
UPDATE machine_requests SET state = 'denied', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE state = 'pending' AND expires_at > sqlc.arg(decided_at);

-- name: ApproveRequest :execrows
UPDATE machine_requests SET state = 'approved', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at),
  expires_at = sqlc.arg(expires_at), machine_id = sqlc.arg(machine_id)
WHERE id = sqlc.arg(id) AND state = 'pending' AND expires_at > sqlc.arg(decided_at);

-- name: MarkRequestDelivered :exec
UPDATE machine_requests SET state = 'delivered' WHERE machine_id = sqlc.arg(machine_id) AND state = 'approved';

-- ===== identity requests (an agent asks to be made, owner decides) =====

-- name: InsertIdentityRequest :one
INSERT INTO identity_requests (ref, kind, machine_request_id, machine_id, handle, display_name, description, avatar_svg, conversation_id, created_at, expires_at)
VALUES (sqlc.arg(ref), sqlc.arg(kind), sqlc.narg(machine_request_id), sqlc.narg(machine_id), sqlc.arg(handle), sqlc.narg(display_name), sqlc.arg(description), sqlc.narg(avatar_svg), sqlc.narg(conversation_id), sqlc.arg(created_at), sqlc.arg(expires_at))
RETURNING id;

-- name: MarkIdentityRequestViaInternet :exec
UPDATE identity_requests SET via_internet = 1 WHERE ref = sqlc.arg(ref);

-- name: ListViaInternetIdentityRefs :many
SELECT ref FROM identity_requests WHERE via_internet = 1 AND state = 'pending';

-- name: PendingNameOrHandleTaken :one
SELECT CAST(
  EXISTS (SELECT 1 FROM machine_requests m WHERE m.state = 'pending' AND m.expires_at > sqlc.arg(now) AND m.requested_name = sqlc.arg(name))
  OR (sqlc.arg(handle) <> '' AND (
    EXISTS (SELECT 1 FROM identity_requests r JOIN machine_requests q ON q.id = r.machine_request_id
            WHERE r.kind = 'login' AND q.state = 'pending' AND q.expires_at > sqlc.arg(now) AND r.handle = sqlc.arg(handle))
    OR EXISTS (SELECT 1 FROM identity_requests s WHERE s.kind = 'session' AND s.state = 'pending' AND s.expires_at > sqlc.arg(now) AND s.handle = sqlc.arg(handle))))
AS INTEGER) AS taken;

-- name: GetIdentityRequestByRef :one
SELECT r.id, r.ref, r.kind, r.machine_request_id, r.machine_id, r.handle, r.display_name, r.description, CAST(r.avatar_svg IS NOT NULL AS INTEGER) AS has_avatar,
  r.conversation_id, r.state, r.created_at, r.expires_at, r.identity_id,
  CAST(COALESCE(m.name, q.requested_name) AS TEXT) AS machine_name
FROM identity_requests r
LEFT JOIN machines m ON m.id = r.machine_id
LEFT JOIN machine_requests q ON q.id = r.machine_request_id
WHERE r.ref = sqlc.arg(ref);

-- name: GetIdentityRequestOfLogin :one
SELECT r.id, r.ref, r.kind, r.machine_request_id, r.machine_id, r.handle, r.display_name, r.description, CAST(r.avatar_svg IS NOT NULL AS INTEGER) AS has_avatar,
  r.conversation_id, r.state, r.created_at, r.expires_at, r.identity_id,
  CAST(q.requested_name AS TEXT) AS machine_name
FROM identity_requests r JOIN machine_requests q ON q.id = r.machine_request_id
WHERE r.machine_request_id = sqlc.arg(machine_request_id);

-- name: GetIdentityRequestByID :one
SELECT id, ref, handle, display_name, description, conversation_id FROM identity_requests WHERE id = sqlc.arg(id);

-- name: GetIdentityRequestAvatar :one
SELECT avatar_svg FROM identity_requests WHERE ref = sqlc.arg(ref) AND avatar_svg IS NOT NULL;

-- name: ListPendingSessionIdentityRequests :many
SELECT r.id, r.ref, r.kind, r.machine_request_id, r.machine_id, r.handle, r.display_name, r.description, CAST(r.avatar_svg IS NOT NULL AS INTEGER) AS has_avatar,
  r.conversation_id, r.state, r.created_at, r.expires_at, r.identity_id,
  CAST(m.name AS TEXT) AS machine_name
FROM identity_requests r JOIN machines m ON m.id = r.machine_id
WHERE r.kind = 'session' AND r.state = 'pending' AND r.expires_at > sqlc.arg(now) AND m.revoked_at IS NULL
ORDER BY r.created_at, r.id;

-- name: ListPendingLoginIdentityRequests :many
SELECT r.id, r.ref, r.kind, r.machine_request_id, r.machine_id, r.handle, r.display_name, r.description, CAST(r.avatar_svg IS NOT NULL AS INTEGER) AS has_avatar,
  r.conversation_id, r.state, r.created_at, r.expires_at, r.identity_id,
  CAST(q.requested_name AS TEXT) AS machine_name
FROM identity_requests r JOIN machine_requests q ON q.id = r.machine_request_id
WHERE r.kind = 'login' AND q.state = 'pending' AND q.expires_at > sqlc.arg(now);

-- name: CountIdentityRequestsOfMachineSince :one
SELECT COUNT(*) AS n, CAST(COALESCE(MIN(created_at), 0) AS INTEGER) AS oldest
FROM identity_requests WHERE machine_id = sqlc.arg(machine_id) AND created_at > sqlc.arg(since);

-- name: FindPendingIdentityRequestOfMachine :one
SELECT ref, expires_at FROM identity_requests
WHERE machine_id = sqlc.arg(machine_id) AND handle = sqlc.arg(handle) AND state = 'pending' AND expires_at > sqlc.arg(now)
ORDER BY id DESC LIMIT 1;

-- name: ApproveIdentityRequest :execrows
UPDATE identity_requests SET state = 'approved', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at), identity_id = sqlc.arg(identity_id)
WHERE id = sqlc.arg(id) AND state = 'pending';

-- name: DenyIdentityRequest :execrows
UPDATE identity_requests SET state = 'denied', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE ref = sqlc.arg(ref) AND kind = 'session' AND state = 'pending' AND expires_at > sqlc.arg(decided_at);

-- name: DenyAllSessionIdentityRequests :execrows
UPDATE identity_requests SET state = 'denied', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE kind = 'session' AND state = 'pending' AND expires_at > sqlc.arg(decided_at);

-- name: DenyLoginIdentityRequests :exec
UPDATE identity_requests SET state = 'denied', decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE kind = 'login' AND state = 'pending'
  AND machine_request_id IN (SELECT id FROM machine_requests WHERE state = 'denied' AND decided_at = sqlc.arg(decided_at));

-- ===== machines =====

-- name: InsertMachine :one
INSERT INTO machines (name, key_hash, key_enc, key_dek_id, key_version, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at)
VALUES (sqlc.arg(name), sqlc.arg(key_hash), sqlc.arg(key_enc), 1, 1, sqlc.arg(key_hint), sqlc.arg(scopes), sqlc.arg(allow_mode), sqlc.arg(approved_by), sqlc.arg(created_at), sqlc.arg(created_at))
RETURNING id;

-- name: SealMachineKey :exec
UPDATE machines SET key_enc = sqlc.arg(key_enc) WHERE id = sqlc.arg(id);

-- name: GetActiveMachineByName :one
SELECT id FROM machines WHERE name = sqlc.arg(name) AND revoked_at IS NULL;

-- name: CountActiveMachines :one
SELECT COUNT(*) FROM machines WHERE revoked_at IS NULL;

-- name: GetMachineByKeyHash :one
SELECT id, name, key_hint, scopes, allow_mode, key_version FROM machines WHERE key_hash = sqlc.arg(key_hash) AND revoked_at IS NULL;

-- name: GetActiveMachine :one
SELECT id, name, key_hint, scopes, allow_mode, key_enc, key_version, last_used_at FROM machines WHERE id = sqlc.arg(id) AND revoked_at IS NULL;

-- name: ListActiveMachines :many
SELECT m.id, m.name, m.key_hint, m.scopes, m.allow_mode, m.last_used_at,
  (SELECT COUNT(*) FROM sessions s WHERE s.machine_id = m.id AND s.ended_at IS NULL AND s.expires_at > sqlc.arg(now)) AS live_sessions
FROM machines m WHERE m.revoked_at IS NULL ORDER BY m.id;

-- name: ListMachineNames :many
SELECT id, name FROM machines;

-- name: TouchMachine :exec
UPDATE machines SET last_used_at = sqlc.arg(last_used_at), last_used_source = sqlc.narg(last_used_source) WHERE id = sqlc.arg(id);

-- name: ReplaceMachineKey :execrows
UPDATE machines SET key_hash = sqlc.arg(key_hash), key_enc = sqlc.arg(key_enc), key_version = sqlc.arg(key_version),
  key_hint = sqlc.arg(key_hint), key_created_at = sqlc.arg(key_created_at)
WHERE id = sqlc.arg(id) AND revoked_at IS NULL;

-- name: RevokeMachine :execrows
UPDATE machines SET revoked_at = sqlc.arg(revoked_at), revoke_reason = 'user' WHERE id = sqlc.arg(id) AND revoked_at IS NULL;

-- name: SetMachineAllowMode :exec
UPDATE machines SET allow_mode = sqlc.arg(allow_mode) WHERE id = sqlc.arg(id);

-- name: DeleteMachineAllow :exec
DELETE FROM machine_allow WHERE machine_id = sqlc.arg(machine_id);

-- name: InsertAllowIdentity :exec
INSERT INTO machine_allow (machine_id, identity_id) VALUES (sqlc.arg(machine_id), sqlc.arg(identity_id));

-- name: InsertAllowGlob :exec
INSERT INTO machine_allow (machine_id, glob) VALUES (sqlc.arg(machine_id), sqlc.arg(glob));

-- name: ListMachineAllow :many
SELECT a.machine_id, a.identity_id, a.glob
FROM machine_allow a JOIN machines m ON m.id = a.machine_id WHERE m.revoked_at IS NULL ORDER BY a.id;

-- ===== sessions (leases) =====

-- name: InsertSession :one
INSERT INTO sessions (identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(machine_id), sqlc.arg(token_hash), sqlc.arg(client_id), sqlc.arg(label), sqlc.arg(scopes), sqlc.arg(now), sqlc.arg(now), sqlc.arg(expires_at))
RETURNING id;

-- name: GetSessionByTokenHash :one
SELECT s.id, s.identity_id, s.machine_id, s.client_id, s.label, s.scopes, s.last_seen_at, s.expires_at, s.ended_at, s.end_reason, m.name AS machine_name
FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.token_hash = sqlc.arg(token_hash);

-- name: EndExpiredSessionsOfClient :exec
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = 'expired'
WHERE identity_id = sqlc.arg(identity_id) AND machine_id = sqlc.arg(machine_id) AND client_id = sqlc.arg(client_id)
  AND ended_at IS NULL AND expires_at <= sqlc.arg(now);

-- name: EndOpenSessionsOfClient :many
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = 'replaced'
WHERE identity_id = sqlc.arg(identity_id) AND machine_id = sqlc.arg(machine_id) AND client_id = sqlc.arg(client_id) AND ended_at IS NULL
RETURNING id;

-- name: CountLiveSessionsOfIdentity :one
SELECT COUNT(*) FROM sessions WHERE identity_id = sqlc.arg(identity_id) AND ended_at IS NULL AND expires_at > sqlc.arg(now);

-- name: CountLiveSessionsOnMachine :one
SELECT COUNT(*) FROM sessions WHERE machine_id = sqlc.arg(machine_id) AND ended_at IS NULL AND expires_at > sqlc.arg(now);

-- name: MintsOfIdentity :one
SELECT COUNT(*) AS n, CAST(COALESCE(MIN(created_at), 0) AS INTEGER) AS oldest
FROM sessions WHERE identity_id = sqlc.arg(identity_id) AND created_at > sqlc.arg(since);

-- name: MintsOnMachine :one
SELECT COUNT(*) AS n, CAST(COALESCE(MIN(created_at), 0) AS INTEGER) AS oldest
FROM sessions WHERE machine_id = sqlc.arg(machine_id) AND created_at > sqlc.arg(since);

-- name: SlideSession :exec
UPDATE sessions SET last_seen_at = sqlc.arg(now), expires_at = sqlc.arg(expires_at) WHERE id = sqlc.arg(id) AND ended_at IS NULL;

-- name: EndSession :execrows
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = sqlc.arg(reason) WHERE id = sqlc.arg(id) AND ended_at IS NULL;

-- name: EndSessionsOfMachine :many
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = sqlc.arg(reason) WHERE machine_id = sqlc.arg(machine_id) AND ended_at IS NULL
RETURNING id;

-- name: EndSessionsOfIdentity :many
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = sqlc.arg(reason) WHERE identity_id = sqlc.arg(identity_id) AND ended_at IS NULL
RETURNING id;

-- name: EndSessionsOfIdentityOnMachine :many
UPDATE sessions SET ended_at = sqlc.arg(now), end_reason = sqlc.arg(reason)
WHERE identity_id = sqlc.arg(identity_id) AND machine_id = sqlc.arg(machine_id) AND ended_at IS NULL
RETURNING id;

-- name: LiveSessionIdentitiesOnMachine :many
SELECT DISTINCT identity_id FROM sessions WHERE machine_id = sqlc.arg(machine_id) AND ended_at IS NULL AND expires_at > sqlc.arg(now);

-- name: ListSessions :many
SELECT s.id, s.identity_id, s.client_id, s.label, s.last_seen_at, s.expires_at, s.ended_at, s.end_reason, m.name AS machine_name
FROM sessions s JOIN machines m ON m.id = s.machine_id ORDER BY s.id DESC LIMIT sqlc.arg(max_rows);

-- name: CountLiveSessionsOfClient :one
SELECT COUNT(*) FROM sessions
WHERE identity_id = sqlc.arg(identity_id) AND machine_id = sqlc.arg(machine_id) AND client_id = sqlc.arg(client_id) AND ended_at IS NULL AND expires_at > sqlc.arg(now);
