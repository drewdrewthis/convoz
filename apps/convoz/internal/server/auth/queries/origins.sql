-- name: SessionOrigins :many
SELECT s.id, s.label, m.name AS machine_name
FROM sessions s JOIN machines m ON m.id = s.machine_id
WHERE s.id IN (sqlc.slice(ids));
