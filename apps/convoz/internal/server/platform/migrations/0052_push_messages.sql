-- News goes to the phone as a push, not a toast (owner, Drew, conv 179 msg 14826). A push subscription says whether its device takes a
-- push for every message from someone else (messages, set by the device when it subscribes; 0 for every subscription made before this),
-- and notifications get the reasons message and identity_request (an agent on a machine already connected asks to connect).
-- push_deliveries references notifications, so both are rebuilt as 0030 did: the new deliveries table points at the new notifications
-- table, the old tables go (deliveries first, so dropping notifications cascades into nothing), and the renames carry the reference
-- along. Every row is copied with its id and every index is made again. Rollback is a data restore of the backup Migrate writes before it
-- runs (<data>/backups/pre-migrate-v51-*): an older build refuses a newer schema (exit 11), so there is no down migration.
-- owner: notify
ALTER TABLE push_subscriptions ADD COLUMN messages INTEGER NOT NULL DEFAULT 0 CHECK (messages IN (0,1));
-- owner: notify
CREATE TABLE notifications_new (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('ask','ask_urgent','mention','thread_reply','agent_add','snooze_wake','paused','machine_request','security','plan_waiting','message','identity_request')),
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
