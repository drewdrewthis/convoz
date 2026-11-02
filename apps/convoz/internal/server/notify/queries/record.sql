-- name: InsertNotification :execrows
-- One notification per (person, reason, source event): a second write of the same event changes nothing (I-28).
INSERT OR IGNORE INTO notifications (identity_id, reason, source_seq, conversation_id, message_id, topic, urgent, decision, suppressed_reason, created_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(reason), sqlc.arg(source_seq), sqlc.narg(conversation_id), sqlc.narg(message_id), sqlc.arg(topic), sqlc.arg(urgent),
        sqlc.arg(decision), sqlc.narg(suppressed_reason), sqlc.arg(now));

-- name: NotificationByKey :one
SELECT id FROM notifications WHERE identity_id = sqlc.arg(identity_id) AND reason = sqlc.arg(reason) AND source_seq = sqlc.arg(source_seq);

-- name: SuppressNotification :exec
UPDATE notifications SET decision = 'suppressed', suppressed_reason = sqlc.arg(why) WHERE id = sqlc.arg(id) AND decision = 'send';

-- name: ExpireNotification :exec
UPDATE notifications SET decision = 'expired' WHERE id = sqlc.arg(id) AND decision = 'send';

-- name: BurstSize :one
-- How many pushes the person was sent on one topic in the minute up to this notification, itself included (a burst reads "3 new").
SELECT count(*) FROM notifications
WHERE identity_id = sqlc.arg(identity_id) AND topic = sqlc.arg(topic) AND decision = 'send' AND id <= sqlc.arg(id) AND created_at > sqlc.arg(since);

-- name: RecentMessagePush :one
-- Whether a plain message push for this conversation rang (decision send) after since: the next one in the window is batched.
SELECT EXISTS (SELECT 1 FROM notifications WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id)
  AND reason = 'message' AND decision = 'send' AND created_at > sqlc.arg(since));

-- name: MessageBatchSize :one
-- How many plain messages a message push stands for: itself and the ones batched (suppressed 'deduped') since the last message push
-- of the conversation that rang.
SELECT count(*) FROM notifications n
WHERE n.identity_id = sqlc.arg(identity_id) AND n.conversation_id = sqlc.arg(conversation_id) AND n.reason = 'message' AND n.id <= sqlc.arg(id)
  AND (n.id = sqlc.arg(id) OR n.suppressed_reason = 'deduped')
  AND n.id > coalesce((SELECT max(p.id) FROM notifications p WHERE p.identity_id = sqlc.arg(identity_id) AND p.conversation_id = sqlc.arg(conversation_id)
                       AND p.reason = 'message' AND p.decision = 'send' AND p.id < sqlc.arg(id)), 0);
