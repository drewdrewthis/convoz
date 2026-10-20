-- name: AsksToCloseOnRemoval :many
-- The open and the dismissed asks one agent has in one conversation (I-19).
SELECT message_id FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed')
ORDER BY message_id;

-- name: OpenAsksOfThread :many
-- The open asks (snoozed ones are open) of a thread: the ask whose message is the thread's root, and the asks asked inside the thread.
SELECT a.message_id FROM asks a JOIN messages m ON m.id = a.message_id
WHERE a.conversation_id = sqlc.arg(conversation_id) AND a.state = 'open' AND (a.message_id = sqlc.arg(thread_root) OR m.thread_root_id = sqlc.arg(thread_root))
ORDER BY a.message_id;
