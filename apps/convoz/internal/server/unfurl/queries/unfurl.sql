-- name: Enqueue :exec
INSERT INTO unfurls (url_hash, url, status, attempts, kind)
VALUES (sqlc.arg(url_hash), sqlc.arg(url), 'pending', 0, 'generic')
ON CONFLICT (url_hash) DO NOTHING;

-- name: Lookup :one
SELECT url, status, site, title, description, kind, meta_json FROM unfurls WHERE url_hash = sqlc.arg(url_hash);

-- name: Due :many
SELECT url_hash, url, attempts FROM unfurls
WHERE status = 'pending' AND (refresh_after IS NULL OR refresh_after <= sqlc.arg(now))
ORDER BY url_hash LIMIT sqlc.arg(max);

-- name: Settle :exec
UPDATE unfurls SET status = sqlc.arg(status), attempts = sqlc.arg(attempts), site = sqlc.arg(site), title = sqlc.arg(title),
  description = sqlc.arg(description), kind = sqlc.arg(kind), meta_json = sqlc.arg(meta_json),
  fetched_at = sqlc.arg(fetched_at), refresh_after = sqlc.arg(refresh_after)
WHERE url_hash = sqlc.arg(url_hash);
