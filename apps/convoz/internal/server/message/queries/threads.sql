-- name: PrevReplyID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE thread_root_id = sqlc.arg(root_id) AND id < sqlc.arg(before_id);

-- name: WroteInThread :one
SELECT EXISTS(SELECT 1 FROM messages WHERE author_id = sqlc.arg(identity_id) AND (id = sqlc.arg(root_id) OR thread_root_id = sqlc.arg(root_id)));

-- name: HasReplyFromOther :one
SELECT EXISTS(SELECT 1 FROM messages WHERE thread_root_id = sqlc.arg(root_id) AND author_id <> sqlc.arg(author_id) AND kind <> 'system' AND deleted_at IS NULL);

-- name: NewestReplyID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE thread_root_id = sqlc.arg(root_id);

-- name: CountThreadUnread :one
SELECT COUNT(*) FROM (
  SELECT id FROM messages
  WHERE thread_root_id = sqlc.arg(root_id) AND broadcast = 0 AND kind <> 'system' AND deleted_at IS NULL
    AND id > sqlc.arg(after) AND author_id <> sqlc.arg(reader_id)
  LIMIT sqlc.arg(max_rows)
);

-- name: CountBroadcastRead :one
SELECT COUNT(*) FROM messages
WHERE thread_root_id = sqlc.arg(root_id) AND broadcast = 1 AND kind <> 'system' AND deleted_at IS NULL
  AND id > sqlc.arg(after) AND id <= sqlc.arg(up_to) AND author_id <> sqlc.arg(reader_id);

-- name: NewestMessageID :one
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages WHERE conversation_id = sqlc.arg(conversation_id);

-- name: NewestOfAuthors :one
-- The newest message the given authors wrote in one place, 0 for none: the main list (root 0) or the thread of root.
-- "Seen by" sits under it.
SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) FROM messages
WHERE conversation_id = sqlc.arg(conversation_id) AND kind = 'text' AND deleted_at IS NULL AND author_id IN (sqlc.slice(authors))
  AND ((CAST(sqlc.arg(root) AS INTEGER) = 0 AND in_main = 1) OR (CAST(sqlc.arg(root) AS INTEGER) <> 0 AND (thread_root_id = CAST(sqlc.arg(root) AS INTEGER) OR id = CAST(sqlc.arg(root) AS INTEGER))));

-- name: NewestReply :one
-- The newest reply of a thread that still reads: the "last reply" under a root.
SELECT * FROM message_rows
WHERE thread_root_id = sqlc.arg(root_id) AND kind <> 'system' AND deleted_at IS NULL
ORDER BY id DESC LIMIT 1;

-- name: ThreadRoots :many
-- The top-level messages of a conversation that have replies, newest reply first: the thread rows under a conversation in the list.
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id IS NULL AND reply_count > 0 AND deleted_at IS NULL AND id > sqlc.arg(floor)
ORDER BY last_reply_id DESC LIMIT sqlc.arg(max_rows);

-- name: WatchContext :many
-- For each message: its thread root (with the root's words) and the message just before it in the same place, the main list or
-- the thread (the root counts as the first message of its thread). One query for a whole batch, so an inbox poll costs no more
-- round trips for 20 items than for one.
SELECT m.id AS message_id,
  CAST(COALESCE(m.thread_root_id, 0) AS INTEGER) AS root_id,
  COALESCE(r.body, '') AS root_body,
  CAST(COALESCE(b.id, 0) AS INTEGER) AS before_id,
  CAST(COALESCE(b.author_id, 0) AS INTEGER) AS before_author_id,
  COALESCE(b.body, '') AS before_body
FROM messages m
LEFT JOIN messages r ON r.id = m.thread_root_id AND r.deleted_at IS NULL
LEFT JOIN messages b ON b.id = (
  SELECT MAX(p.id) FROM messages p
  WHERE p.conversation_id = m.conversation_id AND p.id < m.id AND p.kind <> 'system' AND p.deleted_at IS NULL
    AND ((m.thread_root_id IS NULL AND p.in_main = 1) OR (m.thread_root_id IS NOT NULL AND (p.thread_root_id = m.thread_root_id OR p.id = m.thread_root_id))))
WHERE m.id IN (sqlc.slice(ids));

-- name: NewestCountedInMain :one
-- The newest message of the main list that counts for the unanswered reminder: not a system line, not deleted, not the result of an
-- app and not the answer to an ask (the same ones the inbox ignores).
SELECT * FROM message_rows
WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL
  AND via_app_message_id IS NULL AND answers_ask_id IS NULL
ORDER BY id DESC LIMIT 1;

-- name: RepliesAnswered :many
-- Of these replies, the ones someone other than their author posted after in the same thread.
SELECT r.id FROM messages r
WHERE r.id IN (sqlc.slice(ids)) AND EXISTS (
  SELECT 1 FROM messages m
  WHERE m.conversation_id = r.conversation_id AND m.thread_root_id = r.thread_root_id AND m.id > r.id
    AND m.author_id <> r.author_id AND m.deleted_at IS NULL
)
ORDER BY r.id;

-- name: InThread :many
-- Of these messages, the ones posted inside the thread of root.
SELECT id FROM messages WHERE thread_root_id = sqlc.arg(root_id) AND id IN (sqlc.slice(ids)) ORDER BY id;

-- name: CountThreadUnreadByRoot :many
-- Unread replies of many threads in one go, each thread with its own read point: pairs is a JSON array of [root_id, after].
-- Counts what CountThreadUnread counts, without its stop at MaxUnread.
SELECT m.thread_root_id AS root_id, COUNT(*) AS unread
FROM json_each(sqlc.arg(pairs)) p
JOIN messages m ON m.thread_root_id = json_extract(p.value, '$[0]')
WHERE m.broadcast = 0 AND m.kind <> 'system' AND m.deleted_at IS NULL
  AND m.id > json_extract(p.value, '$[1]') AND m.author_id <> sqlc.arg(reader_id)
GROUP BY m.thread_root_id;

-- name: CountUnreadMentions :one
-- The unread messages of a conversation that @mention the reader, stopping at max_rows: the main list after main_after, less the
-- broadcast replies read in their thread, and the replies of the threads in points, each after its own read point. points is a
-- JSON array of [root_id, after] for the threads the reader is in; lowest_after is the lowest of all those points, so the scan
-- starts from the reader's own mentions (mentions_identity) and never reads the whole conversation.
SELECT COUNT(*) FROM (
  SELECT m.id FROM mentions mn JOIN messages m ON m.id = mn.message_id
  WHERE mn.identity_id = sqlc.arg(identity_id) AND mn.message_id > sqlc.arg(lowest_after)
    AND m.conversation_id = sqlc.arg(conversation_id) AND m.kind <> 'system' AND m.deleted_at IS NULL AND m.author_id <> sqlc.arg(reader_id)
    AND (
      (m.in_main = 1 AND m.id > sqlc.arg(main_after) AND NOT (m.broadcast = 1 AND EXISTS (
        SELECT 1 FROM json_each(sqlc.arg(points)) p WHERE json_extract(p.value, '$[0]') = m.thread_root_id AND m.id <= json_extract(p.value, '$[1]'))))
      OR (m.broadcast = 0 AND m.thread_root_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(sqlc.arg(points)) p WHERE json_extract(p.value, '$[0]') = m.thread_root_id AND m.id > json_extract(p.value, '$[1]')))
    )
  LIMIT sqlc.arg(max_rows)
);

-- name: MainAuthorAt :one
-- The author of the newest main-list message at or before at that still reads, 0 for none: who wrote what the reader read last.
SELECT CAST(COALESCE((
  SELECT author_id FROM messages
  WHERE conversation_id = sqlc.arg(conversation_id) AND in_main = 1 AND kind <> 'system' AND deleted_at IS NULL AND id <= sqlc.arg(at)
  ORDER BY id DESC LIMIT 1
), 0) AS INTEGER);

-- name: ConversationsWithUnreadMentions :many
-- The conversations that have an unread message that @mentions the reader: CountUnreadMentions for many conversations in one
-- query. places is a JSON array of [conversation_id, main_after, lowest_after, points], points being that conversation's
-- [root_id, after] pairs and lowest_after the lowest of main_after and those points. Each conversation scans from the reader's
-- own mentions (mentions_identity) after its lowest_after and stops at the first one that counts.
SELECT CAST(json_extract(c.value, '$[0]') AS INTEGER) AS conversation_id
FROM json_each(sqlc.arg(places)) c
WHERE EXISTS (
  SELECT 1 FROM mentions mn JOIN messages m ON m.id = mn.message_id
  WHERE mn.identity_id = sqlc.arg(identity_id) AND mn.message_id > json_extract(c.value, '$[2]')
    AND m.conversation_id = json_extract(c.value, '$[0]') AND m.kind <> 'system' AND m.deleted_at IS NULL AND m.author_id <> sqlc.arg(reader_id)
    AND (
      (m.in_main = 1 AND m.id > json_extract(c.value, '$[1]') AND NOT (m.broadcast = 1 AND EXISTS (
        SELECT 1 FROM json_each(c.value, '$[3]') p WHERE json_extract(p.value, '$[0]') = m.thread_root_id AND m.id <= json_extract(p.value, '$[1]'))))
      OR (m.broadcast = 0 AND m.thread_root_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(c.value, '$[3]') p WHERE json_extract(p.value, '$[0]') = m.thread_root_id AND m.id > json_extract(p.value, '$[1]')))
    )
);
