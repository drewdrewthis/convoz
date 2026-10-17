-- name: BriefOpenAsks :many
-- The open asks of an agent, newest first, with the time the owner snoozed them until (0 when not snoozed).
SELECT a.message_id, a.conversation_id, a.question, a.urgent, a.created_at,
  CAST(COALESCE((SELECT MAX(s.until_at) FROM ask_snoozes s WHERE s.message_id = a.message_id AND s.woke_at IS NULL AND s.until_at > sqlc.arg(now)), 0) AS INTEGER) AS snoozed_until
FROM asks a
WHERE a.asker_id = sqlc.arg(asker) AND a.state = 'open'
ORDER BY a.message_id DESC LIMIT sqlc.arg(max_rows);

-- name: BriefUnackedAnswers :many
-- Answers (and dismissals) the asking agent has not acked yet, newest first.
SELECT a.message_id, a.conversation_id, a.question, a.state, a.chosen_kind, a.chosen_text, a.resolved_at, COALESCE(o.label, '') AS chosen_label
FROM asks a LEFT JOIN ask_options o ON o.message_id = a.message_id AND o.idx = COALESCE(a.chosen_index, 0) AND a.chosen_kind IN ('recommended', 'alternative')
WHERE a.asker_id = sqlc.arg(asker) AND a.acked_at IS NULL AND a.state IN ('answered', 'dismissed')
ORDER BY a.message_id DESC LIMIT sqlc.arg(max_rows);

-- name: BriefDecisions :many
-- Asks answered since a time, newest first; the caller keeps those of conversations the agent may see.
SELECT a.message_id, a.conversation_id, a.question, a.state, a.chosen_kind, a.chosen_text, a.resolved_at, COALESCE(o.label, '') AS chosen_label
FROM asks a LEFT JOIN ask_options o ON o.message_id = a.message_id AND o.idx = COALESCE(a.chosen_index, 0) AND a.chosen_kind IN ('recommended', 'alternative')
WHERE a.state = 'answered' AND a.resolved_at >= sqlc.arg(since)
ORDER BY a.resolved_at DESC, a.message_id DESC LIMIT sqlc.arg(max_rows);
