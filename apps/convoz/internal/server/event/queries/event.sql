-- name: AppendEvent :one
INSERT INTO events (type, actor_id, session_id, conversation_id, audience_id, message_id, payload_json, idem_key, created_at)
VALUES (sqlc.arg(type), sqlc.narg(actor_id), sqlc.narg(session_id), sqlc.narg(conversation_id), sqlc.narg(audience_id),
        sqlc.narg(message_id), sqlc.arg(payload_json), sqlc.narg(idem_key), sqlc.arg(created_at))
RETURNING seq;

-- name: EventsSince :many
SELECT seq, type, actor_id, session_id, conversation_id, audience_id, message_id, payload_json, created_at
FROM events WHERE seq > sqlc.arg(after) ORDER BY seq LIMIT sqlc.arg(max_rows);

-- name: MaxEventSeq :one
SELECT CAST(COALESCE(MAX(seq), 0) AS INTEGER) AS seq FROM events;

-- name: EventByIdem :one
SELECT seq, conversation_id FROM events WHERE actor_id = sqlc.arg(actor_id) AND idem_key = sqlc.arg(idem_key);
