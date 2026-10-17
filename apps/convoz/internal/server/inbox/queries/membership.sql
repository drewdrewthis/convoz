-- name: UpsertMentionItem :exec
-- An @mention of an agent: the ready conversation item takes the message and becomes a mention (C-10), or is made.
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'mention', sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(message_id), 1, 1, sqlc.arg(source_seq), 'ready', sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (identity_id, conversation_id) WHERE state = 'ready' AND reason IN ('mention','thread','activity')
-- the ordinary fan-out may have counted this very message already: it counts once
DO UPDATE SET reason = 'mention', count = CASE WHEN inbox_items.message_id = excluded.message_id THEN inbox_items.count ELSE inbox_items.count + 1 END, message_id = excluded.message_id,
              mention_count = inbox_items.mention_count + 1, source_seq = excluded.source_seq, updated_at = excluded.updated_at;

-- name: InsertMembershipItem :exec
-- One notice that the agent was removed from a conversation (C-1): ids only, the message is the system line.
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'membership', sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(message_id), 1, 0, sqlc.arg(source_seq), 'ready', sqlc.arg(now), sqlc.arg(now));

-- name: ExpireConversationItems :execrows
-- Everything else the agent had waiting for the conversation leaves the queue at once (I-19).
UPDATE inbox_items
SET state = 'expired', expired_reason = 'removed', claim_session_id = NULL, claim_token = NULL, claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id) AND reason <> 'membership' AND state IN ('ready','claimed');
