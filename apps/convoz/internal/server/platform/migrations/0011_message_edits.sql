-- Messages (WP4): where an agent's message came from, and the one view readers use so a deleted body never leaves the table.
-- The label and machine name are copied at post time (I-40): the owner reads them in the message details without a join into
-- the auth tables, and they stay when the session ends. Both are names, never content.

ALTER TABLE messages ADD COLUMN origin_label   TEXT CHECK (origin_label   IS NULL OR length(origin_label)   <= 80);
ALTER TABLE messages ADD COLUMN origin_machine TEXT CHECK (origin_machine IS NULL OR length(origin_machine) <= 60);

-- A deleted message reads as a tombstone: its body is empty in this view whatever the row holds (E-16). app_json and the app
-- result are not columns of it: a page never carries an app (a stub names it; GET /api/messages/:id/app serves it).
CREATE VIEW message_rows AS
SELECT id, conversation_id, author_id, kind, format,
       CAST(CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS TEXT) AS body,
       thread_root_id, broadcast, in_main, reply_count, last_reply_id, created_at, edited_at, deleted_at, purged_at,
       system_json, session_id, answers_ask_id, via_app_message_id, CAST(app_json IS NOT NULL AS INTEGER) AS has_app,
       origin_label, origin_machine
FROM messages;
