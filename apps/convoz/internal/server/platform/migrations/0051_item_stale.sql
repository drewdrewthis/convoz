-- A started feed item that nobody touched for 15 minutes reminds its agent: inbox_items gets the reason 'item_stale' and feed_item_id,
-- the item it is about (the body is built from it when the agent reads). SQLite cannot change a CHECK in place, so the table is
-- rebuilt as 0035 did; every row is copied (feed_item_id NULL) and every index kept.
-- owner: inbox
CREATE TABLE inbox_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('mention','thread','activity','ask_resolved','membership','app_result','status_due','unanswered','item_stale')),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  first_message_id INTEGER, message_id INTEGER,
  ask_message_id  INTEGER,
  feed_item_id    INTEGER REFERENCES feed_items(id) ON DELETE CASCADE,
  count         INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  source_seq    INTEGER NOT NULL,
  prefer_session_id INTEGER REFERENCES sessions(id),
  not_before    INTEGER,
  state       TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','claimed','acked','expired')),
  claim_session_id INTEGER REFERENCES sessions(id),
  claim_token BLOB CHECK (claim_token IS NULL OR length(claim_token) = 16),
  claim_until INTEGER,
  visibility_ms INTEGER CHECK (visibility_ms IS NULL OR visibility_ms BETWEEN 30000 AND 1800000),
  deliveries  INTEGER NOT NULL DEFAULT 0 CHECK (deliveries BETWEEN 0 AND 5),
  expired_reason TEXT CHECK (expired_reason IN ('age','deliveries','removed','not_visible')),
  acked_at    INTEGER, acked_by_session INTEGER REFERENCES sessions(id),
  claim_seq   INTEGER,
  acked_by_watch INTEGER NOT NULL DEFAULT 0 CHECK (acked_by_watch IN (0,1)), -- finished by the watch (AckThrough), not by an ack
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((state = 'claimed') = (claim_session_id IS NOT NULL AND claim_token IS NOT NULL
                                AND claim_until IS NOT NULL AND visibility_ms IS NOT NULL)),
  CHECK ((state = 'acked') = (acked_at IS NOT NULL)),
  CHECK ((state = 'expired') = (expired_reason IS NOT NULL)),
  CHECK ((reason = 'ask_resolved') = (ask_message_id IS NOT NULL)),
  CHECK ((reason = 'item_stale') = (feed_item_id IS NOT NULL)),
  CHECK (reason NOT IN ('mention','thread','activity','app_result','status_due','unanswered','item_stale') OR conversation_id IS NOT NULL)
) STRICT;
INSERT INTO inbox_items_new (id, identity_id, reason, conversation_id, first_message_id, message_id, ask_message_id, feed_item_id, count, mention_count,
  source_seq, prefer_session_id, not_before, state, claim_session_id, claim_token, claim_until, visibility_ms, deliveries, expired_reason,
  acked_at, acked_by_session, claim_seq, acked_by_watch, created_at, updated_at)
SELECT id, identity_id, reason, conversation_id, first_message_id, message_id, ask_message_id, NULL, count, mention_count,
  source_seq, prefer_session_id, not_before, state, claim_session_id, claim_token, claim_until, visibility_ms, deliveries, expired_reason,
  acked_at, acked_by_session, claim_seq, acked_by_watch, created_at, updated_at FROM inbox_items;
DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_identity ON inbox_items(identity_id, state, id);
CREATE UNIQUE INDEX inbox_coalesce ON inbox_items(identity_id, conversation_id)
  WHERE state = 'ready' AND reason IN ('mention','thread','activity');
CREATE INDEX inbox_conv ON inbox_items(conversation_id);
CREATE INDEX inbox_claim_session ON inbox_items(claim_session_id) WHERE claim_session_id IS NOT NULL;
CREATE INDEX inbox_acked_session ON inbox_items(acked_by_session) WHERE acked_by_session IS NOT NULL;
CREATE INDEX inbox_prefer_session ON inbox_items(prefer_session_id) WHERE prefer_session_id IS NOT NULL;
