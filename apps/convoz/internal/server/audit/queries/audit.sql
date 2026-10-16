-- name: InsertAudit :exec
INSERT INTO audit (at, actor_id, machine_id, session_id, device_id, action, target_kind, target_id, detail_json)
VALUES (sqlc.arg(at), sqlc.narg(actor_id), sqlc.narg(machine_id), sqlc.narg(session_id), sqlc.narg(device_id), sqlc.arg(action), sqlc.narg(target_kind), sqlc.narg(target_id), sqlc.narg(detail_json));

-- name: ListAudit :many
SELECT id, at, actor_id, machine_id, session_id, device_id, action, target_kind, target_id, detail_json
FROM audit ORDER BY id DESC LIMIT sqlc.arg(max_rows);
