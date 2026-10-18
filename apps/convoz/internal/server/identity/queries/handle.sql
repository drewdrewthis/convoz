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

-- name: RecentHandleChanges :many
-- When the agent changed its handle in the window, newest first: the rate limit counts them.
SELECT changed_at FROM handle_changes WHERE identity_id = sqlc.arg(id) AND changed_at > sqlc.arg(since) ORDER BY changed_at DESC LIMIT 3;
