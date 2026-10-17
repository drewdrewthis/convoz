-- name: InsertIdentity :one
INSERT INTO identities (kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at)
VALUES (sqlc.arg(kind), sqlc.arg(handle), sqlc.arg(display_name), sqlc.arg(display_skeleton), sqlc.arg(avatar_letter), sqlc.arg(avatar_palette), sqlc.arg(created_at))
RETURNING id;

-- name: InsertHuman :exec
INSERT INTO humans (identity_id, role, created_via)
VALUES (sqlc.arg(identity_id), sqlc.arg(role), sqlc.arg(created_via));

-- name: GetHuman :one
SELECT i.id, i.handle, i.display_name, h.role
FROM humans h JOIN identities i ON i.id = h.identity_id
WHERE h.identity_id = sqlc.arg(id);

-- name: GetOwner :one
SELECT i.id, i.handle, i.display_name, h.role
FROM humans h JOIN identities i ON i.id = h.identity_id
WHERE h.role = 'owner';

-- name: GetHumanByHandle :one
SELECT i.id, i.handle, i.display_name, h.role
FROM humans h JOIN identities i ON i.id = h.identity_id
WHERE i.handle = sqlc.arg(handle);

-- name: ListIdentities :many
SELECT i.id, i.kind, i.handle, i.display_name, CAST(COALESCE(h.role, 'agent') AS TEXT) AS role, i.created_at, i.disabled_at,
  a.created_by_human, a.created_by_machine, CAST(i.avatar_svg IS NOT NULL AS INTEGER) AS has_avatar
FROM identities i
LEFT JOIN humans h ON h.identity_id = i.id
LEFT JOIN agents a ON a.identity_id = i.id
ORDER BY i.id;

-- name: GetIdentityByHandle :one
SELECT id, kind, handle, display_name, disabled_at FROM identities WHERE handle = sqlc.arg(handle);

-- name: GetIdentity :one
SELECT id, kind, handle, display_name, disabled_at FROM identities WHERE id = sqlc.arg(id);

-- name: InsertAgent :exec
INSERT INTO agents (identity_id, created_by_human, created_by_machine)
VALUES (sqlc.arg(identity_id), sqlc.narg(created_by_human), sqlc.narg(created_by_machine));

-- name: DisableAgent :execrows
UPDATE identities SET disabled_at = sqlc.arg(disabled_at) WHERE id = sqlc.arg(id) AND kind = 'agent' AND disabled_at IS NULL;

-- name: HandleWasUsed :one
SELECT EXISTS (SELECT 1 FROM retired_handles WHERE handle = sqlc.arg(handle));

-- name: ActiveSkeletons :many
SELECT handle, display_skeleton FROM identities WHERE disabled_at IS NULL;

-- name: CountAgentsCreatedByMachineSince :one
SELECT COUNT(*) AS n, CAST(COALESCE(MIN(i.created_at), 0) AS INTEGER) AS oldest
FROM agents a JOIN identities i ON i.id = a.identity_id
WHERE a.created_by_machine = sqlc.arg(machine_id) AND i.created_at > sqlc.arg(since);

-- name: SetAvatarSVG :exec
UPDATE identities SET avatar_svg = sqlc.narg(svg) WHERE id = sqlc.arg(id);

-- name: GetAvatarSVG :one
SELECT avatar_svg FROM identities WHERE id = sqlc.arg(id) AND avatar_svg IS NOT NULL;
