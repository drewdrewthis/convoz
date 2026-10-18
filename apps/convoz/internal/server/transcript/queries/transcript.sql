-- name: EnqueueTranscript :exec
INSERT INTO transcripts (upload_id, state, engine, next_attempt_at, updated_at)
VALUES (sqlc.arg(upload_id), 'pending', sqlc.arg(engine), sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (upload_id) DO NOTHING;

-- name: RequeueTranscript :exec
INSERT INTO transcripts (upload_id, state, engine, attempts, next_attempt_at, updated_at)
VALUES (sqlc.arg(upload_id), 'pending', sqlc.arg(engine), 0, sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (upload_id) DO UPDATE SET previous_text = CASE WHEN transcripts.state = 'done' THEN transcripts.text ELSE transcripts.previous_text END,
  state = 'pending', text = NULL, redo_failed = 0, engine = excluded.engine, attempts = 0,
  next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at;

-- name: NextTranscript :one
SELECT upload_id, engine, attempts FROM transcripts
WHERE state = 'pending' AND next_attempt_at <= sqlc.arg(now) ORDER BY next_attempt_at, upload_id LIMIT 1;

-- name: FinishTranscript :exec
UPDATE transcripts SET state = 'done', text = sqlc.arg(text), previous_text = NULL, redo_failed = 0, engine = sqlc.arg(engine), next_attempt_at = NULL, updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: RetryTranscript :exec
UPDATE transcripts SET attempts = attempts + 1, next_attempt_at = sqlc.arg(next_attempt_at), updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: FailTranscript :exec
UPDATE transcripts SET state = CASE WHEN previous_text IS NULL THEN 'failed' ELSE 'done' END, text = previous_text, redo_failed = previous_text IS NOT NULL,
  previous_text = NULL, attempts = attempts + 1, next_attempt_at = NULL, updated_at = sqlc.arg(now)
WHERE upload_id = sqlc.arg(upload_id) AND state = 'pending';

-- name: TranscriptsOf :many
SELECT upload_id, state, COALESCE(text, previous_text) AS text, attempts, redo_failed FROM transcripts WHERE upload_id IN (sqlc.slice('upload_ids'));
