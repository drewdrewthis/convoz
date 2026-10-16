-- name: AppendEvent :one
INSERT INTO events (type, payload, created_at)
VALUES (sqlc.arg(type), sqlc.arg(payload), sqlc.arg(created_at))
RETURNING id;
