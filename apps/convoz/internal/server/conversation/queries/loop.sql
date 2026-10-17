-- name: LoopState :one
SELECT agent_streak, paused_at FROM conversations WHERE id = sqlc.arg(id);

-- name: LoopCountAgentPost :one
UPDATE conversations
SET agent_streak = agent_streak + 1,
    paused_at = CASE WHEN agent_streak + 1 = sqlc.arg(limit_streak) THEN sqlc.arg(at) ELSE paused_at END
WHERE id = sqlc.arg(id) AND agent_streak < sqlc.arg(limit_streak)
RETURNING agent_streak;

-- name: LoopReset :execrows
UPDATE conversations SET agent_streak = 0, paused_at = NULL WHERE id = sqlc.arg(id) AND (agent_streak > 0 OR paused_at IS NOT NULL);

-- name: LoopWasPaused :one
SELECT paused_at IS NOT NULL FROM conversations WHERE id = sqlc.arg(id);
