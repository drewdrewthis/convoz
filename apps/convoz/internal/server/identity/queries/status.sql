-- name: GetAgentStatus :one
SELECT state, doing, next, since, updated_at FROM agent_status WHERE agent_id = sqlc.arg(agent_id);

-- name: ListAgentStatuses :many
SELECT agent_id, state, doing, next, since, updated_at FROM agent_status;

-- name: UpsertAgentStatus :exec
-- since moves only when the state changes; every assignment reads the row as it was before the update.
INSERT INTO agent_status (agent_id, state, doing, next, since, updated_at)
VALUES (sqlc.arg(agent_id), sqlc.arg(state), sqlc.arg(doing), sqlc.arg(next), sqlc.arg(at), sqlc.arg(at))
ON CONFLICT (agent_id) DO UPDATE SET
  since = CASE WHEN agent_status.state = excluded.state THEN agent_status.since ELSE excluded.since END,
  state = excluded.state, doing = excluded.doing, next = excluded.next, updated_at = excluded.updated_at, version = agent_status.version + 1;
