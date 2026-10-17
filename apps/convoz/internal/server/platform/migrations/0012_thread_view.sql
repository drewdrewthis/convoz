-- Threads (WP5): the reply line of a root says when the newest reply came ("5 replies, last reply 5m"), so the one view readers use
-- gains last_reply_at. The columns stay in the order of 0011; the new one is last.
DROP VIEW message_rows;
CREATE VIEW message_rows AS
SELECT id, conversation_id, author_id, kind, format,
       CAST(CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS TEXT) AS body,
       thread_root_id, broadcast, in_main, reply_count, last_reply_id, created_at, edited_at, deleted_at, purged_at,
       system_json, session_id, answers_ask_id, via_app_message_id, CAST(app_json IS NOT NULL AS INTEGER) AS has_app,
       origin_label, origin_machine, last_reply_at
FROM messages;
