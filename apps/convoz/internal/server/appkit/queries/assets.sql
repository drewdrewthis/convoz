-- name: PutAsset :exec
INSERT INTO app_assets (public_id, uploader_id, kind, mime, size, sha256, content, created_at)
VALUES (sqlc.arg(public_id), sqlc.arg(uploader_id), sqlc.arg(kind), sqlc.arg(mime), sqlc.arg(size), sqlc.arg(sha256), sqlc.arg(content), sqlc.arg(created_at));

-- name: GetAsset :one
SELECT public_id, uploader_id, kind, mime, size, sha256, content FROM app_assets WHERE public_id = sqlc.arg(public_id);

-- name: GetAssetInfo :one
SELECT public_id, uploader_id, kind, mime, size, sha256 FROM app_assets WHERE public_id = sqlc.arg(public_id);
