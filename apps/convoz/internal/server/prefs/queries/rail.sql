-- name: ListConversationPrefs :many
SELECT conversation_id, starred_at, rail_rank, muted_until FROM conversation_prefs WHERE identity_id = sqlc.arg(identity_id);

-- name: ClearRailRanks :exec
UPDATE conversation_prefs SET rail_rank = NULL WHERE conversation_id = sqlc.arg(conversation_id) AND starred_at IS NULL AND rail_rank IS NOT NULL;

-- name: UpsertStar :exec
INSERT INTO conversation_prefs (identity_id, conversation_id, starred_at, rail_rank, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.narg(starred_at), sqlc.arg(rail_rank), sqlc.arg(at))
ON CONFLICT (identity_id, conversation_id) DO UPDATE SET starred_at = excluded.starred_at, rail_rank = excluded.rail_rank, updated_at = excluded.updated_at;

-- name: UpsertRank :exec
INSERT INTO conversation_prefs (identity_id, conversation_id, rail_rank, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.arg(rail_rank), sqlc.arg(at))
ON CONFLICT (identity_id, conversation_id) DO UPDATE SET rail_rank = excluded.rail_rank, updated_at = excluded.updated_at;

-- name: UpsertMute :exec
INSERT INTO conversation_prefs (identity_id, conversation_id, muted_until, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(conversation_id), sqlc.narg(muted_until), sqlc.arg(at))
ON CONFLICT (identity_id, conversation_id) DO UPDATE SET muted_until = excluded.muted_until, updated_at = excluded.updated_at;

-- name: InsertPin :execrows
INSERT OR IGNORE INTO pins (identity_id, message_id, created_at) VALUES (sqlc.arg(identity_id), sqlc.arg(message_id), sqlc.arg(at));

-- name: DeletePin :execrows
DELETE FROM pins WHERE identity_id = sqlc.arg(identity_id) AND message_id = sqlc.arg(message_id);

-- name: ListPins :many
SELECT message_id FROM pins WHERE identity_id = sqlc.arg(identity_id) ORDER BY created_at DESC, message_id DESC LIMIT sqlc.arg(max_rows);
