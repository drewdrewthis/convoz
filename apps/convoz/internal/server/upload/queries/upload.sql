-- name: InsertUpload :one
INSERT INTO uploads (public_id, uploader_id, session_id, conversation_id, kind, declared_size, declared_sha256, filename, storage_name, dek_id, file_key_wrapped, created_at, client_id)
VALUES (sqlc.arg(public_id), sqlc.arg(uploader_id), sqlc.narg(session_id), sqlc.arg(conversation_id), sqlc.arg(kind), sqlc.arg(declared_size), sqlc.arg(declared_sha256),
        sqlc.arg(filename), sqlc.arg(storage_name), sqlc.arg(dek_id), sqlc.arg(file_key_wrapped), sqlc.arg(created_at), sqlc.narg(client_id))
RETURNING id;

-- name: UploadOfClientID :one
-- The upload an identity started under a client id, for the retry of a start whose answer was lost: its id, conversation, kind and file name.
SELECT id, conversation_id, kind, filename FROM uploads WHERE uploader_id = sqlc.arg(uploader_id) AND client_id = sqlc.arg(client_id);

-- name: GetUploadByPublicID :one
SELECT id, public_id, uploader_id, session_id, conversation_id, message_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed, serve_inline,
       filename, storage_name, file_key_wrapped, width, height, duration_ms, waveform, created_at, completed_at
FROM uploads WHERE public_id = sqlc.arg(public_id);

-- name: GetUpload :one
SELECT id, public_id, uploader_id, session_id, conversation_id, message_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed, serve_inline,
       filename, storage_name, file_key_wrapped, width, height, duration_ms, waveform, created_at, completed_at
FROM uploads WHERE id = sqlc.arg(id);

-- name: SetCommitted :exec
UPDATE uploads SET committed_bytes = sqlc.arg(committed_bytes) WHERE id = sqlc.arg(id) AND state = 'receiving' AND committed_bytes <= sqlc.arg(committed_bytes);

-- name: CompleteUpload :exec
UPDATE uploads
SET state = 'complete', kind = sqlc.arg(kind), declared_size = sqlc.arg(size), committed_bytes = sqlc.arg(size), mime_sniffed = sqlc.arg(mime), serve_inline = sqlc.arg(serve_inline),
    width = sqlc.narg(width), height = sqlc.narg(height), duration_ms = sqlc.narg(duration_ms), waveform = NULLIF(sqlc.narg(waveform), x''), completed_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND state = 'receiving';

-- name: BindUpload :execrows
UPDATE uploads SET message_id = sqlc.arg(message_id), bound_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND message_id IS NULL AND state = 'complete';

-- name: BindAppUpload :execrows
UPDATE uploads SET message_id = sqlc.arg(message_id), bound_at = sqlc.arg(now), in_app = 1
WHERE id = sqlc.arg(id) AND message_id IS NULL AND state = 'complete';

-- name: UploadsOfMessages :many
SELECT id, public_id, message_id, kind, declared_size, mime_sniffed, serve_inline, filename, width, height, duration_ms, waveform
FROM uploads WHERE message_id IN (sqlc.slice('message_ids')) AND state = 'complete' AND in_app = 0 ORDER BY bound_at, id;

-- name: SumUploadedSince :one
-- What an identity has started today: the declared size, or for a length not yet known (a voice note still recording) what has arrived so far.
SELECT CAST(COALESCE(SUM(CASE WHEN state = 'receiving' AND declared_sha256 = zeroblob(32) THEN committed_bytes ELSE declared_size END), 0) AS INTEGER) AS bytes
FROM uploads WHERE uploader_id = sqlc.arg(uploader_id) AND created_at >= sqlc.arg(since);

-- name: ExpiredUploads :many
SELECT id, storage_name FROM uploads WHERE message_id IS NULL AND created_at < sqlc.arg(cutoff);

-- name: DeleteUpload :exec
DELETE FROM uploads WHERE id = sqlc.arg(id);

-- name: StorageOfMessage :many
SELECT id, storage_name FROM uploads WHERE message_id = sqlc.arg(message_id);

-- name: DeleteUploadsOfMessage :exec
DELETE FROM uploads WHERE message_id = sqlc.arg(message_id);

-- name: AllStorageNames :many
SELECT storage_name FROM uploads;

-- name: BoundAudioAfter :many
-- Stored voice notes of live messages, oldest first, after a cursor: the transcript backfill walks them. A deleted note has no row; an unbound one is not a message's.
SELECT id FROM uploads
WHERE kind = 'audio' AND state = 'complete' AND message_id IS NOT NULL AND in_app = 0 AND id > sqlc.arg(after_id)
ORDER BY id LIMIT sqlc.arg(max_rows);
