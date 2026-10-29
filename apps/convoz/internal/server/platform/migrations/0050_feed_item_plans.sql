-- Plans belong to agents (owner, Drew, conv 179 msg 12583, 12591): a plan is (agent, plan_key) and spans conversations. Every row made
-- before this is the plan of its conversation, c<conversation_id>, so it keeps its order and its one now; new rows default to 'main'.
-- No table rebuild. UNIQUE(agent, conversation, seq) and UNIQUE(agent, conversation, work_key) of 0049 stay: keys stay unique per agent
-- and conversation. The one-now rule moves from (agent, conversation) to (agent, plan_key). feed_items_thread_root serves ItemsByRoot.
-- There is no 0046 and none may be added. Rollback is a data restore of the cold copy taken before the deploy: no down migration.
-- owner: item
ALTER TABLE feed_items ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'main' CHECK (length(plan_key) BETWEEN 1 AND 64);
UPDATE feed_items SET plan_key = 'c' || conversation_id;
DROP INDEX feed_items_one_now;
CREATE UNIQUE INDEX feed_items_one_now ON feed_items(agent_id, plan_key) WHERE state IN ('started','blocking');
CREATE INDEX feed_items_thread_root ON feed_items(thread_root_id) WHERE thread_root_id IS NOT NULL;
