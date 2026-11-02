-- name: InsertAsk :exec
INSERT INTO asks (message_id, conversation_id, asker_id, asked_by_session, question, urgent, owners_call_kind, owners_call_reason, draft_text, original_text, original_from,
    action, risk, undo, one_way, considered, confidence, state, version, created_at, updated_at)
VALUES (sqlc.arg(message_id), sqlc.arg(conversation_id), sqlc.arg(asker_id), sqlc.narg(asked_by_session), sqlc.arg(question), sqlc.arg(urgent), sqlc.narg(owners_call_kind), sqlc.narg(owners_call_reason), sqlc.narg(draft_text), sqlc.narg(original_text), sqlc.narg(original_from),
    sqlc.narg(action), sqlc.narg(risk), sqlc.narg(undo), sqlc.narg(one_way), sqlc.narg(considered), sqlc.narg(confidence), 'open', 1, sqlc.arg(now), sqlc.arg(now));

-- name: InsertOption :exec
INSERT INTO ask_options (message_id, idx, label, why) VALUES (sqlc.arg(message_id), sqlc.arg(idx), sqlc.arg(label), sqlc.arg(why));

-- name: SealAsk :exec
-- The trigger checks the options: a recommended one first, 2 to 5 in all, no gap (I-11).
UPDATE asks SET sealed = 1 WHERE message_id = sqlc.arg(message_id);

-- name: AskByID :one
SELECT message_id, conversation_id, asker_id, question, urgent, owners_call_kind, owners_call_reason, draft_text, original_text, original_from, action, risk, undo, one_way, considered, confidence,
       scrubbed_at, state, close_reason, chosen_kind, chosen_index, chosen_text,
       answer_via, resolved_by, resolved_at, acked_at, owner_replied_at, owner_reply_id, answers, changed, version, created_at, updated_at
FROM asks WHERE message_id = sqlc.arg(message_id);

-- name: AsksByIDs :many
SELECT message_id, conversation_id, asker_id, question, urgent, owners_call_kind, owners_call_reason, draft_text, original_text, original_from, action, risk, undo, one_way, considered, confidence,
       scrubbed_at, state, close_reason, chosen_kind, chosen_index, chosen_text,
       answer_via, resolved_by, resolved_at, acked_at, owner_replied_at, owner_reply_id, answers, changed, version, created_at, updated_at
FROM asks WHERE message_id IN (sqlc.slice(ids));

-- name: OptionsOf :many
SELECT message_id, idx, label, why FROM ask_options WHERE message_id IN (sqlc.slice(ids)) ORDER BY message_id, idx;

-- name: HistoryOf :many
SELECT message_id, version, event, to_state, by_identity, at FROM ask_transitions WHERE message_id IN (sqlc.slice(ids)) ORDER BY message_id, version;

-- name: InsertTransition :exec
INSERT INTO ask_transitions (message_id, version, event, to_state, by_identity, at)
VALUES (sqlc.arg(message_id), sqlc.arg(version), sqlc.arg(event), sqlc.arg(to_state), sqlc.narg(by_identity), sqlc.arg(at));

-- name: CountOpenOf :one
SELECT COUNT(*) FROM asks WHERE asker_id = sqlc.arg(asker_id) AND state = 'open';

-- name: MarkAnswered :execrows
-- The first answer wins: the version is the compare-and-swap. A dismissed ask can be answered too.
UPDATE asks
SET state = 'answered', close_reason = NULL, chosen_kind = CAST(sqlc.arg(chosen_kind) AS TEXT), chosen_index = sqlc.narg(chosen_index), chosen_text = sqlc.narg(chosen_text),
    answer_via = CAST(sqlc.arg(answer_via) AS TEXT), resolved_by = CAST(sqlc.arg(by) AS INTEGER), resolved_at = CAST(sqlc.arg(now) AS INTEGER), acked_at = NULL, acked_by_session = NULL,
    version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state IN ('open','dismissed');

-- name: MarkDismissed :execrows
UPDATE asks
SET state = 'dismissed', resolved_by = CAST(sqlc.arg(by) AS INTEGER), resolved_at = CAST(sqlc.arg(now) AS INTEGER), version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state = 'open';

-- name: MarkReopened :execrows
-- The dismissal stays in the history; the ack is cleared, so the asker is told again when the ask is resolved.
UPDATE asks
SET state = 'open', resolved_by = NULL, resolved_at = NULL, acked_at = NULL, acked_by_session = NULL, version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state = 'dismissed';

-- name: MarkClosed :execrows
UPDATE asks
SET state = 'closed', close_reason = CAST(sqlc.arg(reason) AS TEXT), resolved_by = NULL, resolved_at = NULL, version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state IN ('open','dismissed');

-- name: AckAsk :execrows
-- Once: the first ack after a resolution counts; a repeat changes nothing. No version change.
UPDATE asks SET acked_at = CAST(sqlc.arg(now) AS INTEGER), acked_by_session = sqlc.narg(session_id)
WHERE message_id = sqlc.arg(message_id) AND acked_at IS NULL AND state <> 'open';

-- name: UpsertSnooze :exec
INSERT INTO ask_snoozes (message_id, identity_id, until_at, created_at, woke_at)
VALUES (sqlc.arg(message_id), sqlc.arg(identity_id), sqlc.arg(until_at), sqlc.arg(now), NULL)
ON CONFLICT (identity_id, message_id) DO UPDATE SET until_at = excluded.until_at, created_at = excluded.created_at, woke_at = NULL;

-- name: DeleteSnooze :execrows
DELETE FROM ask_snoozes WHERE message_id = sqlc.arg(message_id) AND identity_id = sqlc.arg(identity_id);

-- name: DeleteSnoozesOf :exec
DELETE FROM ask_snoozes WHERE message_id = sqlc.arg(message_id);

-- name: DueSnoozes :many
SELECT message_id, identity_id, until_at FROM ask_snoozes WHERE woke_at IS NULL AND until_at <= sqlc.arg(now) ORDER BY until_at, message_id;

-- name: MarkWoke :execrows
UPDATE ask_snoozes SET woke_at = sqlc.arg(now) WHERE message_id = sqlc.arg(message_id) AND identity_id = sqlc.arg(identity_id) AND woke_at IS NULL;

-- name: ActiveSnoozes :many
-- One person's snoozes that still hide their ask: not woken, not yet due.
SELECT message_id, until_at FROM ask_snoozes WHERE identity_id = sqlc.arg(identity_id) AND woke_at IS NULL AND until_at > sqlc.arg(now);

-- name: OpenAsks :many
-- What waits for a person: urgent first, then the newest (the asks_now index).
SELECT message_id FROM asks WHERE state = 'open' ORDER BY urgent DESC, message_id DESC;

-- name: AnsweredSince :many
SELECT message_id FROM asks WHERE state = 'answered' AND resolved_at >= sqlc.arg(since) ORDER BY resolved_at DESC, message_id DESC LIMIT 50;

-- name: DismissedSince :many
-- Still dismissed (a reopened or answered ask is no longer in this state).
SELECT message_id FROM asks WHERE state = 'dismissed' AND resolved_at >= sqlc.arg(since) ORDER BY resolved_at DESC, message_id DESC LIMIT 50;

-- name: AsksOfAskerToClose :many
SELECT message_id FROM asks WHERE asker_id = sqlc.arg(asker_id) AND state IN ('open','dismissed') ORDER BY message_id;

-- name: ScrubAsk :exec
UPDATE asks SET scrubbed_at = CAST(sqlc.arg(now) AS INTEGER), question = '', owners_call_reason = CASE WHEN owners_call_reason IS NULL THEN NULL ELSE '' END,
    draft_text = CASE WHEN draft_text IS NULL THEN NULL ELSE '' END, original_text = CASE WHEN original_text IS NULL THEN NULL ELSE '' END, original_from = CASE WHEN original_from IS NULL THEN NULL ELSE '' END, chosen_text = CASE WHEN chosen_text IS NULL THEN NULL ELSE '' END,
    action = CASE WHEN action IS NULL THEN NULL ELSE '' END, risk = CASE WHEN risk IS NULL THEN NULL ELSE '' END, undo = CASE WHEN undo IS NULL THEN NULL ELSE '' END, considered = CASE WHEN considered IS NULL THEN NULL ELSE '[]' END
WHERE message_id = sqlc.arg(message_id) AND scrubbed_at IS NULL;

-- name: DeleteOptionsOf :exec
DELETE FROM ask_options WHERE message_id = sqlc.arg(message_id);

-- name: MarkOwnerReplied :execrows
-- The owner replied in the thread of an open ask: it stays open and remembers the latest reply.
UPDATE asks SET owner_replied_at = CAST(sqlc.arg(now) AS INTEGER), owner_reply_id = CAST(sqlc.arg(reply_id) AS INTEGER), version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state = 'open';

-- name: UpdateAsk :execrows
-- The asking agent updated its open ask in place: the content it may change, the summary of the answers and what changed; the owner's reply mark clears.
-- The parts of a permission ask are NULL on any other ask; the confidence is fixed when the ask is made.
UPDATE asks
SET question = sqlc.arg(question), owners_call_reason = sqlc.narg(owners_call_reason), answers = sqlc.narg(answers), changed = CAST(sqlc.arg(changed) AS TEXT),
    action = sqlc.narg(action), risk = sqlc.narg(risk), undo = sqlc.narg(undo), one_way = sqlc.narg(one_way), considered = sqlc.narg(considered),
    owner_replied_at = NULL, owner_reply_id = NULL, version = version + 1, updated_at = sqlc.arg(now)
WHERE message_id = sqlc.arg(message_id) AND version = sqlc.arg(version) AND state = 'open';
