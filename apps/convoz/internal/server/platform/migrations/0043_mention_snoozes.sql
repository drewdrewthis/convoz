-- "Later" on a mention card in the Now feed (issue 103). One row per person and conversation: until_at is when the card may come back
-- (epoch ms) and after_id the newest message of the conversation when it was snoozed. While the snooze runs, only a mention newer than
-- after_id counts, so a new @mention brings the card back at once; once until_at has passed the row does nothing.
-- owner: prefs
CREATE TABLE mention_snoozes (
  identity_id     INTEGER NOT NULL REFERENCES humans(identity_id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  until_at        INTEGER NOT NULL,
  after_id        INTEGER NOT NULL,
  PRIMARY KEY (identity_id, conversation_id)
) STRICT, WITHOUT ROWID;
