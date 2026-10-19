-- Plans: what each agent is doing in a conversation, what is next and what waits on the owner (plan.feature).
-- Owner (Drew, conv 1, msg 263): "there should probably be indicators on the conversation list showing that so I know things are
-- active or not. Maybe also the inbox/watch should occassionally ping the agents for a status?"
-- Owner (Drew, conv 12, msg 281): "something grabs it and it presents a decision, or it needs an approval, or it gets logged out".

-- One plan per agent and conversation, replaced whole by `convoz plan`. The items are one JSON document (body_json): Doing with its
-- step, Next (<= 5), Waiting on you (<= 5, each with the time it first showed) and the Done history (<= 20, newest first). eta is
-- outside the document so the nudge can find what is late. The nudge columns count the nudges of one miss: nudge_anchor is the
-- last update the count belongs to (a newer plan or status update starts it again).
-- owner: plan
CREATE TABLE plans (
  agent_id        INTEGER NOT NULL REFERENCES agents(identity_id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  body_json  TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 16384),
  eta        INTEGER,
  updated_at INTEGER NOT NULL,
  nudges       INTEGER NOT NULL DEFAULT 0 CHECK (nudges BETWEEN 0 AND 3),
  nudged_at    INTEGER,
  nudge_anchor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, conversation_id)
) STRICT;
CREATE INDEX plans_conversation ON plans(conversation_id);

-- One quiet note per stretch of not responding (msg 281): the system line was written for this agent in this conversation. The rows of
-- an agent go when it acks an item or holds a watch again, so the next stretch gets its own line.
-- owner: plan
CREATE TABLE plan_liveness_notes (
  agent_id        INTEGER NOT NULL REFERENCES agents(identity_id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  noted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
) STRICT;
CREATE INDEX plan_liveness_notes_conversation ON plan_liveness_notes(conversation_id);

-- inbox_items gets the reason status_due: the server asks an agent whose plan is late to update it. It names its conversation and
-- no message. SQLite cannot change a CHECK in place, so the table is rebuilt; nothing references it.
-- owner: inbox
CREATE TABLE inbox_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('mention','thread','activity','ask_resolved','membership','app_result','status_due')),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  first_message_id INTEGER, message_id INTEGER,
  ask_message_id  INTEGER,
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
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((state = 'claimed') = (claim_session_id IS NOT NULL AND claim_token IS NOT NULL
                                AND claim_until IS NOT NULL AND visibility_ms IS NOT NULL)),
  CHECK ((state = 'acked') = (acked_at IS NOT NULL)),
  CHECK ((state = 'expired') = (expired_reason IS NOT NULL)),
  CHECK ((reason = 'ask_resolved') = (ask_message_id IS NOT NULL)),
  CHECK (reason NOT IN ('mention','thread','activity','app_result','status_due') OR conversation_id IS NOT NULL)
) STRICT;
INSERT INTO inbox_items_new (id, identity_id, reason, conversation_id, first_message_id, message_id, ask_message_id, count, mention_count,
  source_seq, prefer_session_id, not_before, state, claim_session_id, claim_token, claim_until, visibility_ms, deliveries, expired_reason,
  acked_at, acked_by_session, created_at, updated_at)
SELECT id, identity_id, reason, conversation_id, first_message_id, message_id, ask_message_id, count, mention_count,
  source_seq, prefer_session_id, not_before, state, claim_session_id, claim_token, claim_until, visibility_ms, deliveries, expired_reason,
  acked_at, acked_by_session, created_at, updated_at FROM inbox_items;
DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_identity ON inbox_items(identity_id, state, id);
CREATE UNIQUE INDEX inbox_coalesce ON inbox_items(identity_id, conversation_id)
  WHERE state = 'ready' AND reason IN ('mention','thread','activity');
CREATE INDEX inbox_conv ON inbox_items(conversation_id);
CREATE INDEX inbox_claim_session ON inbox_items(claim_session_id) WHERE claim_session_id IS NOT NULL;
CREATE INDEX inbox_acked_session ON inbox_items(acked_by_session) WHERE acked_by_session IS NOT NULL;
CREATE INDEX inbox_prefer_session ON inbox_items(prefer_session_id) WHERE prefer_session_id IS NOT NULL;

-- notifications gets the reason plan_waiting: something new waits on the owner in a plan. push_deliveries references notifications, so
-- both are rebuilt: the new deliveries table points at the new notifications table, the old tables go (deliveries first, so dropping
-- notifications cascades into nothing), and the renames carry the reference along.
-- owner: notify
CREATE TABLE notifications_new (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('ask','ask_urgent','mention','thread_reply','agent_add','snooze_wake','paused','machine_request','security','plan_waiting')),
  source_seq INTEGER NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  topic TEXT NOT NULL CHECK (length(topic) <= 32 AND topic NOT GLOB '*[^A-Za-z0-9_-]*'),
  urgent INTEGER NOT NULL CHECK (urgent IN (0,1)),
  decision TEXT NOT NULL CHECK (decision IN ('send','suppressed','expired')),
  suppressed_reason TEXT CHECK (suppressed_reason IN ('muted','quiet_hours','setting_off','active_here','deduped','not_visible','no_subscription')),
  created_at INTEGER NOT NULL, opened_at INTEGER,
  CHECK ((decision = 'suppressed') = (suppressed_reason IS NOT NULL)),
  UNIQUE (identity_id, reason, source_seq)
) STRICT;
INSERT INTO notifications_new (id, identity_id, reason, source_seq, conversation_id, message_id, topic, urgent, decision, suppressed_reason, created_at, opened_at)
SELECT id, identity_id, reason, source_seq, conversation_id, message_id, topic, urgent, decision, suppressed_reason, created_at, opened_at FROM notifications;
-- owner: notify
CREATE TABLE push_deliveries_new (
  id INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications_new(id) ON DELETE CASCADE,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  status  TEXT NOT NULL CHECK (status IN ('queued','retry','sent','failed','gone')),
  http_status INTEGER, next_attempt_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (notification_id, subscription_id)
) STRICT;
INSERT INTO push_deliveries_new (id, notification_id, subscription_id, attempt, status, http_status, next_attempt_at, created_at, updated_at)
SELECT id, notification_id, subscription_id, attempt, status, http_status, next_attempt_at, created_at, updated_at FROM push_deliveries;
DROP TABLE push_deliveries;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
ALTER TABLE push_deliveries_new RENAME TO push_deliveries;
CREATE INDEX notifications_dedupe ON notifications(identity_id, topic, created_at);
CREATE INDEX notifications_conv ON notifications(conversation_id);
CREATE INDEX notifications_message ON notifications(message_id);
CREATE INDEX notifications_created ON notifications(created_at);
CREATE INDEX push_due ON push_deliveries(next_attempt_at) WHERE status IN ('queued','retry');
CREATE INDEX push_deliveries_sub ON push_deliveries(subscription_id);
