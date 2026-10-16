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
SELECT i.id, i.kind, i.handle, i.display_name, CAST(COALESCE(h.role, 'agent') AS TEXT) AS role, i.created_at, i.disabled_at
FROM identities i LEFT JOIN humans h ON h.identity_id = i.id
ORDER BY i.id;
