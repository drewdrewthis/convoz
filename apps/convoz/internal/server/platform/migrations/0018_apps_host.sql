-- Apps host (WP11). Two changes.
--
-- 1. The one view readers use gains what an app message and a message sent through an app carry: the app itself (empty for a
--    deleted message, like the body, E-16), the agent whose app it came from and the result (app-result.v1). The columns stay in the
--    order of 0012; the new ones are last.
-- 2. app_assets keeps the files an app points at (a Tier-2 bundle, a gallery image) until the upload module serves them. It is a
--    stand-in: when kind `app` and `image` uploads (WP10) carry these files, the appkit port that reads this table reads uploads
--    instead and this table goes.
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

-- owner: appkit
CREATE TABLE app_assets (
  public_id   TEXT PRIMARY KEY CHECK (length(public_id) = 22),   -- 128-bit random, the id an app names
  uploader_id INTEGER NOT NULL REFERENCES identities(id),
  kind        TEXT NOT NULL CHECK (kind IN ('app','image')),
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 1 AND ((kind = 'app' AND size <= 524288) OR (kind = 'image' AND size <= 5242880))),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  content     BLOB NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX app_assets_uploader ON app_assets(uploader_id);
