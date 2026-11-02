-- name: UpsertPlan :exec
-- A new plan replaces the old one whole and starts the nudge count again.
INSERT INTO plans (agent_id, conversation_id, body_json, eta, updated_at, nudges, nudged_at, nudge_anchor)
VALUES (sqlc.arg(agent_id), sqlc.arg(conversation_id), sqlc.arg(body_json), sqlc.narg(eta), sqlc.arg(updated_at), 0, NULL, 0)
ON CONFLICT (agent_id, conversation_id) DO UPDATE SET
  body_json = excluded.body_json, eta = excluded.eta, updated_at = excluded.updated_at, nudges = 0, nudged_at = NULL, nudge_anchor = 0;

-- name: SetPlanBody :exec
-- Rewrites the items alone (a deliverable's asked-about date): the update time and the nudge count stay.
UPDATE plans SET body_json = sqlc.arg(body_json) WHERE agent_id = sqlc.arg(agent_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: GetPlan :one
SELECT agent_id, conversation_id, body_json, eta, updated_at, nudges, nudged_at, nudge_anchor
FROM plans WHERE agent_id = sqlc.arg(agent_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: PlansOfConversation :many
SELECT agent_id, conversation_id, body_json, eta, updated_at, nudges, nudged_at, nudge_anchor
FROM plans WHERE conversation_id = sqlc.arg(conversation_id) ORDER BY agent_id;

-- name: AllPlans :many
SELECT agent_id, conversation_id, body_json, eta, updated_at, nudges, nudged_at, nudge_anchor
FROM plans ORDER BY conversation_id, agent_id;

-- name: RecordNudge :exec
UPDATE plans SET nudges = sqlc.arg(nudges), nudged_at = sqlc.arg(nudged_at), nudge_anchor = sqlc.arg(nudge_anchor)
WHERE agent_id = sqlc.arg(agent_id) AND conversation_id = sqlc.arg(conversation_id);

-- name: HasNote :one
SELECT EXISTS (SELECT 1 FROM plan_liveness_notes WHERE agent_id = sqlc.arg(agent_id) AND conversation_id = sqlc.arg(conversation_id));

-- name: InsertNote :exec
INSERT OR IGNORE INTO plan_liveness_notes (agent_id, conversation_id, noted_at) VALUES (sqlc.arg(agent_id), sqlc.arg(conversation_id), sqlc.arg(noted_at));

-- name: AnyNote :one
SELECT EXISTS (SELECT 1 FROM plan_liveness_notes WHERE agent_id = sqlc.arg(agent_id));

-- name: DeleteNotes :many
DELETE FROM plan_liveness_notes WHERE agent_id = sqlc.arg(agent_id) RETURNING conversation_id;
