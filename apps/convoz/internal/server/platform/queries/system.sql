-- name: GetKV :one
SELECT value FROM system_kv WHERE key = sqlc.arg(key);

-- name: SetKV :exec
INSERT INTO system_kv(key, value) VALUES (sqlc.arg(key), sqlc.arg(value))
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: GetConsumerOffset :one
-- The last event a consumer (the push worker) has handled; no row means it has not run yet.
SELECT last_event_id FROM consumer_offsets WHERE consumer = sqlc.arg(consumer);

-- name: SetConsumerOffset :exec
INSERT INTO consumer_offsets(consumer, last_event_id, updated_at) VALUES (sqlc.arg(consumer), sqlc.arg(last_event_id), sqlc.arg(now))
ON CONFLICT(consumer) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at;
