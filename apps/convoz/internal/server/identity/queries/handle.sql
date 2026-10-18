-- name: GetRetiredHandle :one
SELECT r.handle AS retired, r.retired_at, i.id, i.kind, i.handle, i.display_name, i.disabled_at
FROM retired_handles r JOIN identities i ON i.id = r.identity_id WHERE r.handle = sqlc.arg(handle);

-- name: GetHandleState :one
SELECT i.id, i.kind, i.handle, i.display_name, i.display_skeleton, i.disabled_at, i.handle_changed_at
FROM identities i WHERE i.id = sqlc.arg(id);

-- name: RenameAgent :execrows
-- The old handle is in the WHERE clause: of two changes that race, the second finds no row (I-51).
UPDATE identities SET handle = sqlc.arg(to_handle), handle_changed_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND handle = sqlc.arg(from_handle) AND kind = 'agent' AND disabled_at IS NULL;

-- name: LastRetiredHandle :one
-- The handle an agent gave up at its last change, and when. It reads only migration-3 tables, so a push works on every schema.
SELECT r.handle, r.retired_at FROM retired_handles r JOIN identities i ON i.id = r.identity_id
WHERE i.id = sqlc.arg(id) AND i.kind = 'agent' ORDER BY r.retired_at DESC, r.handle LIMIT 1;

-- name: RetiredHandlesOf :many
SELECT handle, retired_at FROM retired_handles WHERE identity_id = sqlc.arg(id) ORDER BY retired_at DESC, handle;

-- name: InsertHandleRequest :one
INSERT INTO handle_requests (ref, identity_id, from_handle, to_handle, created_at, expires_at)
VALUES (sqlc.arg(ref), sqlc.arg(identity_id), sqlc.arg(from_handle), sqlc.arg(to_handle), sqlc.arg(created_at), sqlc.arg(expires_at))
RETURNING id;

-- name: PendingHandleRequestOf :one
SELECT id, ref, identity_id, from_handle, to_handle, state, created_at, expires_at FROM handle_requests
WHERE identity_id = sqlc.arg(identity_id) AND state = 'pending';

-- name: GetHandleRequestByRef :one
SELECT id, ref, identity_id, from_handle, to_handle, state, created_at, expires_at FROM handle_requests WHERE ref = sqlc.arg(ref);

-- name: ListPendingHandleRequests :many
SELECT h.id, h.ref, h.identity_id, h.from_handle, h.to_handle, h.state, h.created_at, h.expires_at, i.display_name
FROM handle_requests h JOIN identities i ON i.id = h.identity_id
WHERE h.state = 'pending' AND h.expires_at > sqlc.arg(now) AND i.handle = h.from_handle AND i.disabled_at IS NULL
ORDER BY h.created_at, h.id;

-- name: DecideHandleRequest :execrows
UPDATE handle_requests SET state = sqlc.arg(state), decided_by = sqlc.arg(decided_by), decided_at = sqlc.arg(decided_at)
WHERE id = sqlc.arg(id) AND state = 'pending';

-- name: WithdrawHandleRequests :exec
UPDATE handle_requests SET state = 'withdrawn', decided_at = sqlc.arg(now) WHERE identity_id = sqlc.arg(identity_id) AND state = 'pending';
