-- The rest of the v1 schema: every design draft 9 §7 table that 0001-0007 did not create, copied from §7 as written.
-- As in 0007, the tables are created whole, so the later slices add rows and code, not columns. After this file the
-- schema is frozen: a fix to one of these tables goes in a new migration with the number its slice reserved.
-- asks_seal (a trigger on asks) is here because it reads ask_options, which did not exist when 0007 made asks.

-- owner: conversation
CREATE TABLE assignments (                               -- pickup of an open conversation (I-47); row deleted on release
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id     INTEGER NOT NULL REFERENCES agents(identity_id),
  session_id   INTEGER REFERENCES sessions(id),
  fence        INTEGER NOT NULL CHECK (fence >= 1),     -- = conversations.assign_version at pickup
  picked_up_at INTEGER NOT NULL, lease_until INTEGER NOT NULL
) STRICT;
CREATE INDEX assignments_agent ON assignments(agent_id);
CREATE INDEX assignments_session ON assignments(session_id);

-- owner: message
CREATE TABLE message_edits (                              -- rows deleted on purge / delete-my-data (I-49)
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  prev_body  TEXT NOT NULL, prev_format TEXT NOT NULL,
  edited_by  INTEGER NOT NULL REFERENCES identities(id), edited_at INTEGER NOT NULL
) STRICT;
CREATE INDEX message_edits_message ON message_edits(message_id, id);
CREATE INDEX message_edits_by ON message_edits(edited_by);

-- owner: message
CREATE TABLE mentions (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  identity_id INTEGER NOT NULL REFERENCES identities(id),
  PRIMARY KEY (message_id, identity_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX mentions_identity ON mentions(identity_id, message_id);

-- owner: ask
CREATE TABLE ask_options (                                -- idx 0 = recommended, 1..4 = alternatives
  message_id INTEGER NOT NULL REFERENCES asks(message_id) ON DELETE CASCADE,
  idx   INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 4),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  why   TEXT NOT NULL CHECK (length(why) BETWEEN 1 AND 280),
  PRIMARY KEY (message_id, idx)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER asks_seal BEFORE UPDATE OF sealed ON asks WHEN NEW.sealed <> OLD.sealed
BEGIN
  SELECT RAISE(ABORT,'sealed is set once') WHERE OLD.sealed = 1;
  SELECT RAISE(ABORT,'bad options') WHERE NOT (
    EXISTS (SELECT 1 FROM ask_options WHERE message_id = NEW.message_id AND idx = 0)
    AND (SELECT count(*) FROM ask_options WHERE message_id = NEW.message_id) BETWEEN 2 AND 5
    AND (SELECT max(idx) FROM ask_options WHERE message_id = NEW.message_id)
        = (SELECT count(*) FROM ask_options WHERE message_id = NEW.message_id) - 1);
END;                                                                          -- I-11 in the DB
CREATE TRIGGER ask_options_no_update BEFORE UPDATE ON ask_options BEGIN SELECT RAISE(ABORT,'ask options are immutable'); END;
CREATE TRIGGER ask_options_no_insert_after_seal BEFORE INSERT ON ask_options
  WHEN (SELECT sealed FROM asks WHERE message_id = NEW.message_id) = 1
  BEGIN SELECT RAISE(ABORT,'ask options are sealed'); END;
CREATE TRIGGER ask_options_delete_only_scrub BEFORE DELETE ON ask_options     -- cascade from a deleted ask passes (parent gone)
  WHEN EXISTS (SELECT 1 FROM asks WHERE message_id = OLD.message_id AND scrubbed_at IS NULL)
  BEGIN SELECT RAISE(ABORT,'ask options are immutable'); END;

-- owner: ask
CREATE TABLE ask_snoozes (                                -- per user overlay; never bumps asks.version (I-13)
  message_id  INTEGER NOT NULL REFERENCES asks(message_id) ON DELETE CASCADE,
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  until_at INTEGER NOT NULL, created_at INTEGER NOT NULL, woke_at INTEGER,
  PRIMARY KEY (identity_id, message_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ask_snoozes_wake ON ask_snoozes(until_at) WHERE woke_at IS NULL;
CREATE INDEX ask_snoozes_message ON ask_snoozes(message_id);

-- owner: ask
CREATE TABLE ask_transitions (                            -- ask history: who did what, when (C-6); ids and enums only
  message_id  INTEGER NOT NULL REFERENCES asks(message_id) ON DELETE CASCADE,
  version     INTEGER NOT NULL CHECK (version >= 1),      -- asks.version after the transition
  event       TEXT NOT NULL CHECK (event IN ('create','answer','dismiss','undismiss','withdraw','close')),
  to_state    TEXT NOT NULL CHECK (to_state IN ('open','answered','dismissed','closed')),
  by_identity INTEGER REFERENCES identities(id),           -- NULL = system (removal, disable, delete)
  at          INTEGER NOT NULL,
  PRIMARY KEY (message_id, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX ask_transitions_by ON ask_transitions(by_identity);
CREATE TRIGGER ask_transitions_append_only BEFORE UPDATE ON ask_transitions
  BEGIN SELECT RAISE(ABORT,'ask history is append-only'); END;

-- ===== agent status, inbox, handoffs =====
-- owner: identity
CREATE TABLE agent_status (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(identity_id),
  state    TEXT NOT NULL CHECK (state IN ('idle','working','blocked','waiting')),
  doing    TEXT NOT NULL DEFAULT '' CHECK (length(doing) <= 200),
  next     TEXT NOT NULL DEFAULT '' CHECK (length(next) <= 200),
  progress_json TEXT CHECK (progress_json IS NULL OR (json_valid(progress_json) AND length(progress_json) <= 1024)),
  app_json TEXT CHECK (app_json IS NULL OR (json_valid(app_json) AND length(app_json) <= 65536)),
  since INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;                                                  -- "offline" = no live session

-- owner: inbox
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  body        TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 4096),   -- bytes, so it always fits the brief (M7)
  client_id   TEXT NOT NULL CHECK (length(client_id) BETWEEN 8 AND 64),
  created_at  INTEGER NOT NULL,
  UNIQUE (identity_id, client_id)
) STRICT;
CREATE INDEX handoffs_identity ON handoffs(identity_id, id);
CREATE INDEX handoffs_session ON handoffs(session_id);

-- ===== per-user state =====
-- owner: prefs
CREATE TABLE conversation_prefs (                         -- a row exists only after a star, mute or drag
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  starred_at  INTEGER,
  section     INTEGER GENERATED ALWAYS AS (starred_at IS NOT NULL) VIRTUAL,
  rail_rank   REAL,                                      -- NULL = conversations.created_at (I-21)
  muted_until INTEGER,                                   -- 253402300799000 = forever
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (identity_id, conversation_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX conversation_prefs_conv ON conversation_prefs(conversation_id);

-- owner: prefs
CREATE TABLE pins (
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (identity_id, message_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX pins_message ON pins(message_id);

-- owner: readstate
CREATE TABLE thread_reads (                               -- a row = U is involved in the thread (I-14)
  identity_id INTEGER NOT NULL REFERENCES identities(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_id     INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL CHECK (last_read_id >= 0),
  involved_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, conversation_id, root_id),
  FOREIGN KEY (root_id, conversation_id) REFERENCES messages(id, conversation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX thread_reads_root ON thread_reads(root_id);
CREATE INDEX thread_reads_conv ON thread_reads(conversation_id);
CREATE TRIGGER thread_reads_forward BEFORE UPDATE OF last_read_id ON thread_reads WHEN NEW.last_read_id < OLD.last_read_id
  BEGIN SELECT RAISE(ABORT,'read cursors only move forward'); END;

-- ===== uploads =====
-- owner: upload
CREATE TABLE uploads (                                    -- resumable (§12.3)
  id INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE CHECK (length(public_id) = 22),   -- 128-bit random; URLs and AEAD AAD
  uploader_id  INTEGER NOT NULL REFERENCES identities(id),
  session_id   INTEGER REFERENCES sessions(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('audio','image','file','app')),   -- app = Tier-2 bundle, served only by GET /api/apps/:id/frame
  state        TEXT NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving','complete')),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 26214400),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes BETWEEN 0 AND declared_size),  -- whole 1 MB segments, or all
  declared_sha256 BLOB NOT NULL CHECK (length(declared_sha256) = 32),   -- checked at completion
  mime_sniffed TEXT,
  serve_inline INTEGER NOT NULL DEFAULT 0 CHECK (serve_inline IN (0,1)),   -- I-44 allow-list result
  filename     TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  storage_name TEXT NOT NULL UNIQUE,
  dek_id       INTEGER NOT NULL, file_key_wrapped BLOB NOT NULL,
  width INTEGER, height INTEGER,
  duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 300000),
  waveform     BLOB CHECK (waveform IS NULL OR (kind = 'audio' AND length(waveform) <= 64)),   -- 64 peaks 0..255 from the recorder
  created_at INTEGER NOT NULL, completed_at INTEGER, bound_at INTEGER,
  CHECK ((state = 'complete') = (completed_at IS NOT NULL AND mime_sniffed IS NOT NULL AND committed_bytes = declared_size)),
  CHECK ((message_id IS NULL) = (bound_at IS NULL)),
  CHECK (message_id IS NULL OR state = 'complete'),
  CHECK (serve_inline = 0 OR kind IN ('audio','image'))
) STRICT;
CREATE INDEX uploads_message ON uploads(message_id);
CREATE INDEX uploads_unbound ON uploads(created_at) WHERE message_id IS NULL;      -- GC: incomplete or unbound after 24 h
CREATE INDEX uploads_conv ON uploads(conversation_id, kind, id);                   -- Shared tab
CREATE INDEX uploads_uploader ON uploads(uploader_id, created_at);                  -- FK; daily byte quota
CREATE INDEX uploads_session ON uploads(session_id);

-- owner: transcript
CREATE TABLE transcripts (
  upload_id INTEGER PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
  state     TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  text      TEXT CHECK (text IS NULL OR length(text) <= 16384),
  engine    TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at INTEGER, updated_at INTEGER NOT NULL,
  CHECK ((state = 'done') = (text IS NOT NULL))
) STRICT;
CREATE INDEX transcripts_queue ON transcripts(next_attempt_at) WHERE state = 'pending';

-- owner: unfurl
CREATE TABLE unfurls (                                    -- draft 4 §11 semantics
  url_hash BLOB PRIMARY KEY, url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','unavailable')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts <= 3),
  site TEXT, title TEXT, description TEXT,
  kind TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('generic','github_pr','github_issue')),
  meta_json TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)), fetched_at INTEGER, refresh_after INTEGER
) STRICT, WITHOUT ROWID;

-- ===== search (synchronous, written in the message tx) =====
-- owner: search
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='', contentless_delete=1,
  prefix='2 3', tokenize='unicode61 remove_diacritics 2');      -- rowid = messages.id; ranked by rowid DESC

-- owner: search
CREATE VIRTUAL TABLE conversations_fts USING fts5(title, content='', contentless_delete=1, prefix='2 3');

-- ===== settings (device-scope settings live on the device, §11) =====
-- owner: settings
CREATE TABLE workspace_settings (
  key TEXT PRIMARY KEY CHECK (length(key) <= 64),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  updated_by INTEGER NOT NULL REFERENCES humans(identity_id), updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX workspace_settings_by ON workspace_settings(updated_by);

-- owner: settings
CREATE TABLE user_settings (
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  key TEXT NOT NULL CHECK (length(key) <= 64),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1), updated_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, key)
) STRICT, WITHOUT ROWID;

-- ===== notifications =====
-- owner: notify
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL,
  identity_id INTEGER NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 1024), -- host allow-list in app (I-28)
  p256dh BLOB NOT NULL CHECK (length(p256dh) = 65), auth BLOB NOT NULL CHECK (length(auth) = 16),
  created_at INTEGER NOT NULL, last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_at INTEGER, disabled_reason TEXT CHECK (disabled_reason IN ('gone','failures','device_revoked','user')),
  FOREIGN KEY (device_id, identity_id) REFERENCES devices(id, human_id) ON DELETE CASCADE,   -- DA-8
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX push_one_per_device ON push_subscriptions(device_id) WHERE disabled_at IS NULL;
CREATE INDEX push_device ON push_subscriptions(device_id, identity_id);           -- FK
CREATE INDEX push_identity ON push_subscriptions(identity_id, disabled_at);       -- fan-out

-- owner: notify
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES humans(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('ask','ask_urgent','mention','thread_reply','agent_add','snooze_wake','paused','machine_request','security')),
  source_seq INTEGER NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  topic TEXT NOT NULL CHECK (length(topic) <= 32 AND topic NOT GLOB '*[^A-Za-z0-9_-]*'),  -- HMAC, opaque (I-28)
  urgent INTEGER NOT NULL CHECK (urgent IN (0,1)),
  decision TEXT NOT NULL CHECK (decision IN ('send','suppressed','expired')),
  suppressed_reason TEXT CHECK (suppressed_reason IN ('muted','quiet_hours','setting_off','active_here','deduped','not_visible','no_subscription')),
  created_at INTEGER NOT NULL, opened_at INTEGER,
  CHECK ((decision = 'suppressed') = (suppressed_reason IS NOT NULL)),
  UNIQUE (identity_id, reason, source_seq)
) STRICT;
CREATE INDEX notifications_dedupe ON notifications(identity_id, topic, created_at);
CREATE INDEX notifications_conv ON notifications(conversation_id);
CREATE INDEX notifications_message ON notifications(message_id);
CREATE INDEX notifications_created ON notifications(created_at);

-- owner: notify
CREATE TABLE push_deliveries (
  id INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  status  TEXT NOT NULL CHECK (status IN ('queued','retry','sent','failed','gone')),
  http_status INTEGER, next_attempt_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (notification_id, subscription_id)
) STRICT;
CREATE INDEX push_due ON push_deliveries(next_attempt_at) WHERE status IN ('queued','retry');
CREATE INDEX push_deliveries_sub ON push_deliveries(subscription_id);
