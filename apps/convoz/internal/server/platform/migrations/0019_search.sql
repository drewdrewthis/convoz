-- Search (WP12): what the message transaction knows about a message when it indexes it, next to its words in messages_fts.
-- A query filters on these columns in the same statement as the full-text match (from:, is:ask, is:app, has:link, in: by id),
-- so it never reads another module's table per hit. Nothing here is content: no body, no title.
-- The row goes with the message. The trigger takes the words out of messages_fts whenever a row goes, whatever removed it: a
-- delete, a purge, or the cascade of a conversation that left the trash (I-49).

-- owner: search
CREATE TABLE search_entries (
  message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,   -- = messages_fts.rowid
  conversation_id INTEGER NOT NULL,
  author_id       INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('text','ask')),
  is_app          INTEGER NOT NULL CHECK (is_app IN (0,1)),
  has_link        INTEGER NOT NULL CHECK (has_link IN (0,1)),
  created_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX search_entries_conv   ON search_entries(conversation_id, message_id);
CREATE INDEX search_entries_author ON search_entries(author_id, message_id);

CREATE TRIGGER search_entries_gone AFTER DELETE ON search_entries
BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.message_id;
END;
