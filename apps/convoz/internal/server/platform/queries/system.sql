-- name: GetKV :one
SELECT value FROM system_kv WHERE key = sqlc.arg(key);

-- name: SetKV :exec
INSERT INTO system_kv(key, value) VALUES (sqlc.arg(key), sqlc.arg(value))
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
