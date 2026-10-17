-- Apps host (WP11).
--
-- An upload of kind `app` or a gallery image belongs to the app of its message, not to the files the message shows: in_app marks it.
-- owner: upload
ALTER TABLE uploads ADD COLUMN in_app INTEGER NOT NULL DEFAULT 0 CHECK (in_app IN (0,1));

-- The one view readers use gains what an app message and a message sent through an app carry: the app itself (empty for a
--    deleted message, like the body, E-16), the agent whose app it came from and the result (app-result.v1). The columns stay in the
--    order of 0012; the new ones are last.
DROP VIEW message_rows;
CREATE VIEW message_rows AS
SELECT id, conversation_id, author_id, kind, format,
       CAST(CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS TEXT) AS body,
       thread_root_id, broadcast, in_main, reply_count, last_reply_id, created_at, edited_at, deleted_at, purged_at,
       system_json, session_id, answers_ask_id, via_app_message_id, CAST(app_json IS NOT NULL AS INTEGER) AS has_app,
       origin_label, origin_machine, last_reply_at,
       CAST(CASE WHEN deleted_at IS NULL THEN COALESCE(app_json, '') ELSE '' END AS TEXT) AS app_json,
       via_app_agent_id,
       CAST(CASE WHEN deleted_at IS NULL THEN COALESCE(app_result_json, '') ELSE '' END AS TEXT) AS app_result_json
FROM messages;

