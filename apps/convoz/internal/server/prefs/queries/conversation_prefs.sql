-- name: GetConversationPrefs :one
SELECT starred_at, muted_until FROM conversation_prefs WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: IsStarredByAnyone :one
SELECT COUNT(*) FROM conversation_prefs WHERE conversation_id = sqlc.arg(conversation_id) AND starred_at IS NOT NULL;
