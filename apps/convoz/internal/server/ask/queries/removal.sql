-- name: AsksToCloseOnRemoval :many
-- The open and the dismissed asks one agent has in one conversation (I-19).
SELECT message_id FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed')
ORDER BY message_id;

-- name: OpenAskOfThread :many
-- The one open ask (snoozed ones are open) a reply in a thread is for: the ask whose message is the thread's root (it sits in the main
-- list, so its own thread_root_id is NULL), else the newest ask asked inside the thread. One reply counts for one ask, never for every
-- ask that shares the thread.
SELECT a.message_id FROM asks a JOIN messages m ON m.id = a.message_id
WHERE a.conversation_id = sqlc.arg(conversation_id) AND a.state = 'open' AND (a.message_id = sqlc.arg(thread_root) OR m.thread_root_id = sqlc.arg(thread_root))
ORDER BY m.thread_root_id IS NULL DESC, a.message_id DESC
LIMIT 1;
