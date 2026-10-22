-- An agent in a conversation can say it is done for now (`convoz stale`): the rail folds it into Older at once, and the next message
-- brings it back (Drew, 2026-10-22). stale_at is when it was marked, 0 when never; a message after it wins, so nothing clears it.
-- stale_reason is the agent's optional why, as it gave it with the last mark.
-- owner: conversation
ALTER TABLE conversations ADD COLUMN stale_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN stale_reason TEXT NOT NULL DEFAULT '' CHECK (length(stale_reason) <= 200);
