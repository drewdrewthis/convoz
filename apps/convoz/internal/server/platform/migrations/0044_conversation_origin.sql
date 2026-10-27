-- A conversation made from a thread keeps a link to the message the thread hangs off (owner, msgs 1591 and 2356, issue 32). One row per
-- such conversation; message_id is unique so turning the same thread twice gives the same conversation. The message is not a foreign
-- key: a purged root must not take the conversation with it, and the page then shows the link as gone.
-- owner: conversation
CREATE TABLE conversation_origins (
  conversation_id        INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  source_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id             INTEGER NOT NULL UNIQUE,
  created_at             INTEGER NOT NULL
) STRICT;
