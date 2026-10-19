-- A message the owner's voice call posted (the model asked an agent through a tool) says so: every reader sees "via voice call". The owner
-- decides what a call posts, but the words come from a model that may have read an agent's text, so the mark is the visible part of the
-- defence (Owner said, msg 778: "it would probably be dope to be able to call the agent in the convo"). Only a human sender sets it.
-- owner: message
ALTER TABLE messages ADD COLUMN via_voice INTEGER NOT NULL DEFAULT 0 CHECK (via_voice IN (0,1));

-- The reader view gains the mark, last: the columns keep the order of 0018.
DROP VIEW message_rows;
CREATE VIEW message_rows AS
SELECT id, conversation_id, author_id, kind, format,
       CAST(CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS TEXT) AS body,
       thread_root_id, broadcast, in_main, reply_count, last_reply_id, created_at, edited_at, deleted_at, purged_at,
       system_json, session_id, answers_ask_id, via_app_message_id, CAST(app_json IS NOT NULL AS INTEGER) AS has_app,
       origin_label, origin_machine, last_reply_at,
       CAST(CASE WHEN deleted_at IS NULL THEN COALESCE(app_json, '') ELSE '' END AS TEXT) AS app_json,
       via_app_agent_id,
       CAST(CASE WHEN deleted_at IS NULL THEN COALESCE(app_result_json, '') ELSE '' END AS TEXT) AS app_result_json,
       via_voice
FROM messages;
