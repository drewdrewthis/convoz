-- name: ItemByID :one
SELECT * FROM feed_items WHERE id = sqlc.arg(id);

-- name: ItemByKey :one
SELECT * FROM feed_items WHERE agent_id = sqlc.arg(agent_id) AND conversation_id = sqlc.arg(conversation_id) AND work_key = sqlc.arg(work_key);

-- name: ItemsByRoot :many
SELECT * FROM feed_items WHERE thread_root_id = sqlc.arg(thread_root_id);

-- name: NowOf :one
SELECT * FROM feed_items WHERE agent_id = sqlc.arg(agent_id) AND plan_key = sqlc.arg(plan_key) AND state IN ('started','blocking');

-- name: FirstPending :one
SELECT * FROM feed_items WHERE agent_id = sqlc.arg(agent_id) AND plan_key = sqlc.arg(plan_key) AND state = 'pending'
ORDER BY seq LIMIT 1;

-- name: NextSeq :one
SELECT CAST(COALESCE(MAX(seq), 0) + 1 AS INTEGER) FROM feed_items WHERE agent_id = sqlc.arg(agent_id);

-- name: InsertItem :one
INSERT INTO feed_items (agent_id, conversation_id, plan_key, work_key, seq, state, owner_step, title, context, recommendation, due_at, version, created_at, updated_at)
VALUES (sqlc.arg(agent_id), sqlc.arg(conversation_id), sqlc.arg(plan_key), sqlc.arg(work_key), sqlc.arg(seq), sqlc.arg(state), sqlc.arg(owner_step), sqlc.arg(title),
  sqlc.arg(context), sqlc.narg(recommendation), sqlc.narg(due_at), 1, sqlc.arg(now), sqlc.arg(now))
RETURNING *;

-- name: SaveItem :exec
UPDATE feed_items SET state = sqlc.arg(state), owner_step = sqlc.arg(owner_step), title = sqlc.arg(title), context = sqlc.arg(context),
  recommendation = sqlc.narg(recommendation), due_at = sqlc.narg(due_at), acked_at = sqlc.narg(acked_at), acked_by = sqlc.narg(acked_by),
  ack_kind = sqlc.narg(ack_kind), snoozed_until = sqlc.narg(snoozed_until), version = sqlc.arg(version), updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- name: InsertEvent :exec
INSERT INTO feed_item_events (item_id, version, event, to_state, by_identity, note, at)
VALUES (sqlc.arg(item_id), sqlc.arg(version), sqlc.arg(event), sqlc.arg(to_state), sqlc.narg(by_identity), sqlc.arg(note), sqlc.arg(at));

-- name: EventsOf :many
SELECT id, item_id, version, event, to_state, by_identity, note, at FROM feed_item_events WHERE item_id = sqlc.arg(item_id) ORDER BY id;

-- name: OpenItems :many
-- What the feed lists: every step still to do, and a "no longer needs you", that the owner has not acknowledged (Okay).
SELECT * FROM feed_items
WHERE (state IN ('pending','started','blocking','fyi')) AND acked_at IS NULL
ORDER BY agent_id, plan_key, seq;

-- name: RecentDone :many
SELECT * FROM feed_items WHERE state = 'done' ORDER BY updated_at DESC, id DESC LIMIT sqlc.arg(max);

-- name: SetThreadRoot :exec
UPDATE feed_items SET thread_root_id = sqlc.arg(thread_root_id) WHERE id = sqlc.arg(id) AND thread_root_id IS NULL;
