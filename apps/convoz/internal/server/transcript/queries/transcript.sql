-- name: EnqueueTranscript :exec
INSERT INTO transcripts (upload_id, state, engine, next_attempt_at, updated_at)
VALUES (sqlc.arg(upload_id), 'pending', sqlc.arg(engine), sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (upload_id) DO NOTHING;

-- name: NextTranscript :one
SELECT upload_id, engine, attempts FROM transcripts
WHERE state = 'pending' AND next_attempt_at <= sqlc.arg(now) ORDER BY next_attempt_at, upload_id LIMIT 1;

-- name: FinishTranscript :exec
UPDATE transcripts SET state = 'done', text = sqlc.arg(text), engine = sqlc.arg(engine), next_attempt_at = NULL, updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: RetryTranscript :exec
UPDATE transcripts SET attempts = attempts + 1, next_attempt_at = sqlc.arg(next_attempt_at), updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: FailTranscript :exec
UPDATE transcripts SET state = 'failed', attempts = attempts + 1, next_attempt_at = NULL, updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: TranscriptsOf :many
SELECT upload_id, state, text FROM transcripts WHERE upload_id IN (sqlc.slice('upload_ids'));
