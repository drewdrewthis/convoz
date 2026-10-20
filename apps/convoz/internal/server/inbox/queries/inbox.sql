-- name: UpsertConversationItem :exec
-- The fan-out of one new main message to one agent participant: the ready conversation item for (identity, conversation)
-- takes the newest message and counts one more, or is made (design section 3.8, C-10). The reason only goes up:
-- mention over thread over activity. mention_count is how many of the item's messages mention the agent.
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, prefer_session_id, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(reason), sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(message_id), 1, CASE WHEN sqlc.arg(reason) = 'mention' THEN 1 ELSE 0 END, sqlc.arg(source_seq), sqlc.narg(prefer_session_id), 'ready', sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (identity_id, conversation_id) WHERE state = 'ready' AND reason IN ('mention','thread','activity')
-- the ordinary fan-out may have counted this very message already (an @mention made the item first): it counts once
DO UPDATE SET message_id = excluded.message_id,
    count = CASE WHEN inbox_items.message_id = excluded.message_id THEN inbox_items.count ELSE inbox_items.count + 1 END,
    mention_count = CASE WHEN inbox_items.message_id = excluded.message_id AND inbox_items.reason = 'mention' THEN inbox_items.mention_count ELSE inbox_items.mention_count + excluded.mention_count END,
    reason = CASE WHEN 'mention' IN (inbox_items.reason, excluded.reason) THEN 'mention'
                  WHEN 'thread'  IN (inbox_items.reason, excluded.reason) THEN 'thread' ELSE 'activity' END,
    source_seq = excluded.source_seq, prefer_session_id = excluded.prefer_session_id, updated_at = excluded.updated_at;

-- name: HeldItems :many
-- (1) M1: items this session already holds come back first, same tokens, no delivery counted. after -1 takes them all; else only
-- those claimed after that claim number. max_rows -1 is no limit.
SELECT id, conversation_id, first_message_id, message_id, count, mention_count, reason, state, claim_token, claim_until, deliveries
FROM inbox_items
WHERE identity_id = sqlc.arg(identity_id) AND state = 'claimed' AND claim_session_id = sqlc.arg(session_id) AND claim_until >= sqlc.arg(now)
  AND (sqlc.arg(conv) = 0 OR conversation_id = sqlc.arg(conv))
  AND (sqlc.arg(after) < 0 OR claim_seq > sqlc.arg(after))
ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: ExpirePoisonItems :exec
-- (2) M2: an item delivered 5 times leaves the queue before any claim; the batch never aborts.
UPDATE inbox_items
SET state = 'expired', expired_reason = 'deliveries', claim_session_id = NULL, claim_token = NULL,
    claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE identity_id = sqlc.arg(identity_id) AND deliveries >= 5
  AND (state = 'ready' OR (state = 'claimed' AND claim_until < sqlc.arg(now)));

-- name: ExpiredClaimIDs :many
SELECT id FROM inbox_items
WHERE identity_id = sqlc.arg(identity_id) AND state = 'claimed' AND claim_until < sqlc.arg(now)
ORDER BY id;

-- name: ExpiredClaim :one
SELECT identity_id, conversation_id, first_message_id, count, mention_count, reason, deliveries
FROM inbox_items WHERE id = sqlc.arg(id) AND reason IN ('mention','thread','activity');

-- name: MergeIntoReady :execrows
-- (3) M4: an expired claim merges into the ready conversation item of the same conversation, if there is one.
-- (The statement of section 3.8 joins the expired row with UPDATE ... FROM, which sqlc cannot read; the caller reads the row first.)
UPDATE inbox_items
SET first_message_id = min(first_message_id, CAST(sqlc.arg(first_message_id) AS INTEGER)),
    count = count + sqlc.arg(count), mention_count = mention_count + sqlc.arg(mention_count),
    reason = CASE WHEN 'mention' IN (reason, CAST(sqlc.arg(merged_reason) AS TEXT)) THEN 'mention'
                  WHEN 'thread'  IN (reason, CAST(sqlc.arg(merged_reason) AS TEXT)) THEN 'thread' ELSE 'activity' END,
    deliveries = max(deliveries, CAST(sqlc.arg(deliveries) AS INTEGER)), updated_at = sqlc.arg(now)
WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id)
  AND state = 'ready' AND reason IN ('mention','thread','activity');

-- name: DeleteItem :exec
DELETE FROM inbox_items WHERE id = sqlc.arg(id);

-- name: MakeItemReady :exec
UPDATE inbox_items
SET state = 'ready', claim_session_id = NULL, claim_token = NULL, claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE id = sqlc.arg(id);

-- name: ClaimItems :many
-- (4) Claim; one random 128-bit token per item. conv 0 means every conversation. Not yet in the SQL of section 3.8: the
-- session-preference clause (prefer_session_id stays NULL until the post path records the posting session).
UPDATE inbox_items
SET state = 'claimed', claim_session_id = sqlc.arg(session_id), claim_token = randomblob(16), claim_seq = sqlc.arg(claim_seq),
    claim_until = sqlc.arg(now) + sqlc.arg(visibility_ms), visibility_ms = sqlc.arg(visibility_ms), deliveries = deliveries + 1, updated_at = sqlc.arg(now)
WHERE id IN (
  SELECT i.id FROM inbox_items i
  WHERE i.identity_id = sqlc.arg(identity_id) AND i.state = 'ready' AND i.deliveries < 5
    AND (i.not_before IS NULL OR i.not_before <= sqlc.arg(now))
    AND (sqlc.arg(conv) = 0 OR i.conversation_id = sqlc.arg(conv))
    AND (i.prefer_session_id IS NULL OR i.prefer_session_id = sqlc.arg(session_id) OR i.updated_at + 30000 <= sqlc.arg(now))
    AND NOT EXISTS (SELECT 1 FROM inbox_items c
                    WHERE c.identity_id = i.identity_id AND c.conversation_id = i.conversation_id
                      AND c.state = 'claimed' AND c.claim_until >= sqlc.arg(now) AND c.claim_session_id <> sqlc.arg(session_id))
  ORDER BY i.id LIMIT sqlc.arg(n_left))
RETURNING id, conversation_id, first_message_id, message_id, count, mention_count, reason, state, claim_token, claim_until, deliveries;

-- name: ClaimSeq :one
-- The newest claim number of the identity (no row before its first claim).
SELECT seq FROM inbox_claim_seqs WHERE identity_id = sqlc.arg(identity_id);

-- name: SetClaimSeq :exec
INSERT INTO inbox_claim_seqs (identity_id, seq) VALUES (sqlc.arg(identity_id), sqlc.arg(seq))
ON CONFLICT (identity_id) DO UPDATE SET seq = excluded.seq;

-- name: AckItem :execrows
-- Ack: the claim columns are cleared, or the claimed-state CHECK fails.
UPDATE inbox_items
SET state = 'acked', acked_at = sqlc.arg(now), acked_by_session = sqlc.arg(session_id), claim_session_id = NULL, claim_token = NULL,
    claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND identity_id = sqlc.arg(identity_id) AND state = 'claimed'
  AND claim_session_id = sqlc.arg(session_id) AND claim_token = sqlc.arg(token) AND claim_until >= sqlc.arg(now);

-- name: ItemConversation :one
SELECT conversation_id FROM inbox_items WHERE id = sqlc.arg(id) AND identity_id = sqlc.arg(identity_id);

-- name: ExtendClaims :many
-- Extend (M8): on a lease renewal. The rows come back so the owner's screen can move the end of "working".
UPDATE inbox_items SET claim_until = min(sqlc.arg(now) + visibility_ms, sqlc.arg(lease_expires_at)), updated_at = sqlc.arg(now)
WHERE claim_session_id = sqlc.arg(session_id) AND state = 'claimed' AND claim_until >= sqlc.arg(now)
RETURNING conversation_id, message_id, claim_until;

-- name: ReleaseClaims :many
-- Release: a session that ends lets its claims expire at once; the next claim merges them back (3).
UPDATE inbox_items SET claim_until = sqlc.arg(now) - 1 WHERE claim_session_id = sqlc.arg(session_id) AND state = 'claimed'
RETURNING identity_id, conversation_id;

-- name: PeekItems :many
SELECT id, conversation_id, first_message_id, message_id, count, mention_count, reason, state, claim_token, claim_until, deliveries, claim_session_id
FROM inbox_items
WHERE identity_id = sqlc.arg(identity_id) AND state IN ('ready','claimed')
ORDER BY id;

-- name: ExpireNotVisible :exec
UPDATE inbox_items
SET state = 'expired', expired_reason = 'not_visible', claim_session_id = NULL, claim_token = NULL,
    claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE id = sqlc.arg(id);

-- name: TransferClaims :exec
-- Re-mint (M5): the lease that replaces another keeps the claims of the old one, tokens unchanged.
UPDATE inbox_items SET claim_session_id = sqlc.arg(to_session), updated_at = sqlc.arg(now)
WHERE claim_session_id = sqlc.arg(from_session) AND state = 'claimed';

-- name: HoldsLiveClaim :one
SELECT EXISTS (SELECT 1 FROM inbox_items WHERE claim_session_id = sqlc.arg(session_id) AND state = 'claimed' AND claim_until >= sqlc.arg(now));

-- name: InsertAskResolvedItem :exec
-- The asking agent is told its ask was answered, dismissed or deleted (design 8.1): one item per resolution, ids only. It never merges.
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, ask_message_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'ask_resolved', sqlc.arg(conversation_id), sqlc.arg(ask_message_id), sqlc.arg(ask_message_id), sqlc.arg(ask_message_id), 1, 0, sqlc.arg(source_seq), 'ready', sqlc.arg(now), sqlc.arg(now));

-- name: AskOfItem :one
-- The ask an ask_resolved item of this identity is about.
SELECT ask_message_id FROM inbox_items WHERE id = sqlc.arg(id) AND identity_id = sqlc.arg(identity_id) AND reason = 'ask_resolved';

-- name: AckedItem :one
-- A repeat of an ack that went through (ask_resolved items only), or the ack of an item the watch already finished: the item is acked, by this session.
SELECT EXISTS (SELECT 1 FROM inbox_items WHERE id = sqlc.arg(id) AND identity_id = sqlc.arg(identity_id)
               AND (reason = 'ask_resolved' OR acked_by_watch = 1) AND state = 'acked' AND acked_by_session = sqlc.arg(session_id));

-- name: AckThrough :many
-- A watch that asks after=K proves it got every answer up to claim number K: its claims of this session up to K are done, no ack needed.
UPDATE inbox_items
SET state = 'acked', acked_by_watch = 1, acked_at = sqlc.arg(now), acked_by_session = sqlc.arg(session_id), claim_session_id = NULL, claim_token = NULL,
    claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE identity_id = sqlc.arg(identity_id) AND state = 'claimed' AND claim_session_id = sqlc.arg(session_id) AND claim_seq <= sqlc.arg(after)
RETURNING id;

-- name: HoldItemsFor :exec
-- E-5: the ready items that carry a voice note wait until its transcript is done or the wait ends.
UPDATE inbox_items SET not_before = sqlc.arg(until), updated_at = sqlc.arg(now)
WHERE conversation_id = sqlc.arg(conversation_id) AND state = 'ready' AND reason IN ('mention','thread','activity')
  AND first_message_id <= sqlc.arg(message_id) AND message_id >= sqlc.arg(message_id);

-- name: ReleaseItemsFor :exec
UPDATE inbox_items SET not_before = NULL, updated_at = sqlc.arg(now)
WHERE conversation_id = sqlc.arg(conversation_id) AND not_before IS NOT NULL
  AND first_message_id <= sqlc.arg(message_id) AND message_id >= sqlc.arg(message_id);

-- name: ClearPreference :exec
-- A session that ends is preferred no more: the other sessions take its items at once.
UPDATE inbox_items SET prefer_session_id = NULL WHERE prefer_session_id = sqlc.arg(session_id) AND state IN ('ready','claimed');

-- name: TransferPreference :exec
UPDATE inbox_items SET prefer_session_id = sqlc.arg(to_session) WHERE prefer_session_id = sqlc.arg(from_session) AND state IN ('ready','claimed');

-- name: DeleteAckedBefore :exec
-- Retention (design 3.8): an acked item is deleted after 7 days.
DELETE FROM inbox_items WHERE state = 'acked' AND acked_at < sqlc.arg(before);

-- name: ExpireOldItems :exec
-- Retention: an item nobody acked in 30 days leaves the queue as expired (age); the brief reports it as expired unread.
UPDATE inbox_items
SET state = 'expired', expired_reason = 'age', claim_session_id = NULL, claim_token = NULL, claim_until = NULL, visibility_ms = NULL, updated_at = sqlc.arg(now)
WHERE state IN ('ready','claimed') AND created_at < sqlc.arg(before);

-- name: DeleteExpiredBefore :exec
-- Retention: an expired row is deleted after 60 days.
DELETE FROM inbox_items WHERE state = 'expired' AND updated_at < sqlc.arg(before);

-- name: InsertAppResultItem :exec
-- The agent whose app got a result is told (design 3.8): one item per result, ids only. It never merges.
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'app_result', sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(message_id), 1, 0, sqlc.arg(source_seq), 'ready', sqlc.arg(now), sqlc.arg(now));

-- name: InsertStatusDueItem :exec
-- The server asks an agent whose plan is late to update it (plan.feature): one item per nudge, no message. It never merges.
INSERT INTO inbox_items (identity_id, reason, conversation_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'status_due', sqlc.arg(conversation_id), 1, 0, sqlc.arg(source_seq), 'ready', sqlc.arg(now), sqlc.arg(now));

-- name: HasOpenStatusDue :one
SELECT EXISTS (SELECT 1 FROM inbox_items WHERE identity_id = sqlc.arg(identity_id) AND conversation_id = sqlc.arg(conversation_id)
               AND reason = 'status_due' AND state IN ('ready','claimed'));

-- name: Unanswered :many
-- The messages that wait for an agent: per agent and conversation, since when the oldest conversation item nobody acked has waited.
SELECT identity_id, CAST(conversation_id AS INTEGER) AS conversation_id, CAST(min(created_at) AS INTEGER) AS since FROM inbox_items
WHERE state IN ('ready','claimed') AND reason IN ('mention','thread','activity') AND conversation_id IS NOT NULL
GROUP BY identity_id, conversation_id;


-- name: TrackPlace :exec
-- The owner wrote the newest counted message of a place: it is due for a reminder at due_at, and an older one is forgotten.
INSERT INTO inbox_unanswered (conversation_id, thread_root_id, message_id, due_at)
VALUES (sqlc.arg(conversation_id), sqlc.arg(thread_root_id), sqlc.arg(message_id), sqlc.arg(due_at))
ON CONFLICT (conversation_id, thread_root_id) DO UPDATE SET message_id = excluded.message_id, due_at = excluded.due_at;

-- name: ClearPlace :exec
DELETE FROM inbox_unanswered WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id = sqlc.arg(thread_root_id);

-- name: ClearMainPlaceOfRoot :exec
-- A reply in a thread answers the main-chat message that roots it (the thread is where that message was answered), when it is the one tracked.
DELETE FROM inbox_unanswered WHERE conversation_id = sqlc.arg(conversation_id) AND thread_root_id = 0 AND message_id = sqlc.arg(root_id);

-- name: DuePlaces :many
SELECT conversation_id, thread_root_id, message_id FROM inbox_unanswered
WHERE due_at <= sqlc.arg(now) ORDER BY due_at, conversation_id, thread_root_id LIMIT sqlc.arg(max_rows);

-- name: InsertUnansweredItem :exec
-- The owner's message sat unanswered: an item like the one the message made, with the reason changed. It never merges.
-- No event stands behind it, so source_seq is 0 (nothing reads it).
INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, state, created_at, updated_at)
VALUES (sqlc.arg(identity_id), 'unanswered', sqlc.arg(conversation_id), sqlc.arg(message_id), sqlc.arg(message_id), 1, 0, 0, 'ready', sqlc.arg(now), sqlc.arg(now));
