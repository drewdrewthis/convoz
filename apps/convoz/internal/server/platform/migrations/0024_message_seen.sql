-- Which agent has seen which message: the claim of the inbox item that covers it. One row per (agent, newest message of the
-- claimed item), written when a claim is first handed out. "Seen by @agent" under a person's message reads the rows at or
-- above that message, so it survives a reload. Ids and times only.

-- owner: inbox
CREATE TABLE message_seen (
  identity_id     INTEGER NOT NULL REFERENCES agents(identity_id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seen_at         INTEGER NOT NULL,
  PRIMARY KEY (identity_id, message_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX message_seen_conversation ON message_seen(conversation_id, message_id);
