-- name: AsksToCloseOnRemoval :many
-- The open and the dismissed asks one agent has in one conversation (I-19).
SELECT message_id FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed')
ORDER BY message_id;

-- name: OpenAsksOfConversation :many
-- The open asks (snoozed ones are open) of a conversation, newest first. A reply in a thread is for one of them: the ask whose
-- message is the thread's root, else the newest ask asked inside the thread (the message module finds those).
SELECT message_id FROM asks
WHERE conversation_id = sqlc.arg(conversation_id) AND state = 'open'
ORDER BY message_id DESC;
