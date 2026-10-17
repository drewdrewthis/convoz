-- name: UpsertEntry :exec
-- A re-index (an edit) keeps who and when and refreshes what the words say.
INSERT INTO search_entries (message_id, conversation_id, author_id, kind, is_app, has_link, created_at)
VALUES (sqlc.arg(message_id), sqlc.arg(conversation_id), sqlc.arg(author_id), sqlc.arg(kind), sqlc.arg(is_app), sqlc.arg(has_link), sqlc.arg(created_at))
ON CONFLICT (message_id) DO UPDATE SET kind = excluded.kind, is_app = excluded.is_app, has_link = excluded.has_link;

-- name: DeleteEntry :exec
-- The trigger search_entries_gone takes the words out of messages_fts with it.
DELETE FROM search_entries WHERE message_id = sqlc.arg(message_id);
