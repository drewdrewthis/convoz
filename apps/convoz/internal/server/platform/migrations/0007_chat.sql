-- Chat: conversations, participants, messages, inbox, read cursors, asks, and the events table in its final shape.
-- Design draft 9 §7. The tables are created whole (every column), so the later slices add rows and code, not columns.
-- One transaction (the runner's): the new tables, the events rebuild and the version bump land together or not at all.

-- owner: conversation
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  title        TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
  title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','manual')),
  created_by   INTEGER NOT NULL REFERENCES identities(id),
  created_at   INTEGER NOT NULL,
  link_url     TEXT CHECK (link_url IS NULL OR (length(link_url) <= 500 AND link_url LIKE 'https://%')),
  last_message_id  INTEGER NOT NULL DEFAULT 0,
  last_main_id     INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  open_ask_count   INTEGER NOT NULL DEFAULT 0 CHECK (open_ask_count >= 0),
  agent_streak     INTEGER NOT NULL DEFAULT 0 CHECK (agent_streak BETWEEN 0 AND 20),
  paused_at        INTEGER,
  pickup_opened_at INTEGER, pickup_opened_by INTEGER REFERENCES humans(identity_id),   -- SEC-6
  assign_version   INTEGER NOT NULL DEFAULT 0 CHECK (assign_version >= 0),             -- pickup fencing counter; never resets
  deleted_at       INTEGER, deleted_by INTEGER REFERENCES humans(identity_id),         -- soft delete (DA-6)
  CHECK (paused_at IS NULL OR agent_streak = 20),
  CHECK ((pickup_opened_at IS NULL) = (pickup_opened_by IS NULL)),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
) STRICT;
CREATE INDEX conversations_created_by ON conversations(created_by);
CREATE INDEX conversations_activity ON conversations(last_activity_at);
CREATE INDEX conversations_gc ON conversations(created_at) WHERE message_count = 0;    -- empty GC (I-20)
CREATE INDEX conversations_deleted ON conversations(deleted_at) WHERE deleted_at IS NOT NULL;  -- trash; auto-purge after 30 d
CREATE INDEX conversations_pickup_by ON conversations(pickup_opened_by);
CREATE INDEX conversations_deleted_by ON conversations(deleted_by);

-- owner: conversation
CREATE TABLE participants (
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id       INTEGER NOT NULL REFERENCES identities(id),
  status            TEXT NOT NULL CHECK (status IN ('pending','active','left','removed','declined')),
  joined_message_id INTEGER NOT NULL DEFAULT 0 CHECK (joined_message_id >= 0),  -- visibility floor; 0 = full history
  joined_seq        INTEGER NOT NULL DEFAULT 0,                                 -- event floor (I-7)
  added_by          INTEGER NOT NULL REFERENCES identities(id),
  requested_by      INTEGER REFERENCES agents(identity_id),
  decided_by        INTEGER REFERENCES humans(identity_id),
  last_post_session_id INTEGER REFERENCES sessions(id),                         -- agents: inbox session preference (§3.8)
  added_at INTEGER NOT NULL, status_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, identity_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX participants_identity ON participants(identity_id, status, conversation_id);
CREATE INDEX participants_pending ON participants(status_at) WHERE status = 'pending';
CREATE INDEX participants_added_by ON participants(added_by);
CREATE INDEX participants_requested_by ON participants(requested_by);
CREATE INDEX participants_decided_by ON participants(decided_by);
CREATE INDEX participants_last_post_session ON participants(last_post_session_id) WHERE last_post_session_id IS NOT NULL;
CREATE TRIGGER participants_identity_has_subtype BEFORE INSERT ON participants
  WHEN NOT EXISTS (SELECT 1 FROM humans WHERE identity_id = NEW.identity_id)
   AND NOT EXISTS (SELECT 1 FROM agents WHERE identity_id = NEW.identity_id)
  BEGIN SELECT RAISE(ABORT,'identity has no human or agent row'); END;

-- owner: message
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,                   -- never reused (cursors depend on it)
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES identities(id),          -- NULL only for system lines
  kind        TEXT NOT NULL CHECK (kind IN ('text','ask','system')),
  format      TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','markdownv2','plain')),
  body        TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 16384),
  system_json TEXT CHECK (system_json IS NULL OR (json_valid(system_json) AND length(system_json) <= 2048)),  -- ids only
  thread_root_id INTEGER,
  broadcast   INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0,1)),
  in_main     INTEGER GENERATED ALWAYS AS (thread_root_id IS NULL OR broadcast = 1) VIRTUAL,
  reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  last_reply_id INTEGER, last_reply_at INTEGER,
  answers_ask_id INTEGER,
  app_json    TEXT CHECK (app_json IS NULL OR (length(app_json) <= 65536 AND json_valid(app_json))),
  via_app_agent_id   INTEGER REFERENCES agents(identity_id),   -- SEC-5: the app's agent
  via_app_message_id INTEGER,                                  -- the app message the result came from
  app_result_json TEXT CHECK (app_result_json IS NULL OR (json_valid(app_result_json) AND length(app_result_json) <= 4096)),  -- app-result.v1 (E-1)
  session_id  INTEGER REFERENCES sessions(id),
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  client_id   TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
  created_at  INTEGER NOT NULL,
  edited_at INTEGER, deleted_at INTEGER, deleted_by INTEGER REFERENCES identities(id), purged_at INTEGER,
  UNIQUE (id, conversation_id),                                                  -- target of composite FKs (DA-8)
  FOREIGN KEY (thread_root_id, conversation_id) REFERENCES messages(id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (answers_ask_id, conversation_id) REFERENCES asks(message_id, conversation_id),
  FOREIGN KEY (via_app_message_id, conversation_id) REFERENCES messages(id, conversation_id),
  CHECK ((kind = 'system') = (author_id IS NULL)),
  CHECK ((kind = 'system') = (system_json IS NOT NULL)),
  CHECK (broadcast = 0 OR thread_root_id IS NOT NULL),
  CHECK (thread_root_id IS NULL OR reply_count = 0),
  CHECK (app_json IS NULL OR kind <> 'system'),
  CHECK ((via_app_agent_id IS NULL) = (via_app_message_id IS NULL)),
  CHECK (app_result_json IS NULL OR via_app_message_id IS NOT NULL),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  UNIQUE (author_id, client_id)                                                  -- idempotent send (I-24)
) STRICT;
CREATE INDEX messages_main   ON messages(conversation_id, in_main, id);
CREATE INDEX messages_conv   ON messages(conversation_id, id);
CREATE INDEX messages_thread ON messages(thread_root_id, id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_roots  ON messages(conversation_id, last_reply_id) WHERE reply_count > 0;
CREATE INDEX messages_author ON messages(author_id, id);
CREATE INDEX messages_answers ON messages(answers_ask_id) WHERE answers_ask_id IS NOT NULL;
CREATE INDEX messages_via_app_agent ON messages(via_app_agent_id) WHERE via_app_agent_id IS NOT NULL;
CREATE INDEX messages_via_app_msg ON messages(via_app_message_id) WHERE via_app_message_id IS NOT NULL;
CREATE INDEX messages_session ON messages(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX messages_device  ON messages(device_id)  WHERE device_id IS NOT NULL;
CREATE INDEX messages_deleted_by ON messages(deleted_by) WHERE deleted_by IS NOT NULL;
CREATE TRIGGER messages_thread_root_valid BEFORE INSERT ON messages WHEN NEW.thread_root_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'bad thread root') WHERE NOT EXISTS (
    SELECT 1 FROM messages r WHERE r.id = NEW.thread_root_id AND r.thread_root_id IS NULL AND r.kind <> 'system');
END;                                                      -- I-8 (same conversation: composite FK)
CREATE TRIGGER messages_structure_immutable BEFORE UPDATE OF conversation_id, thread_root_id, author_id, kind, via_app_agent_id, via_app_message_id, answers_ask_id ON messages
  WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.thread_root_id IS NOT OLD.thread_root_id
    OR NEW.author_id IS NOT OLD.author_id OR NEW.kind IS NOT OLD.kind
    OR NEW.via_app_agent_id IS NOT OLD.via_app_agent_id OR NEW.via_app_message_id IS NOT OLD.via_app_message_id
    OR NEW.answers_ask_id IS NOT OLD.answers_ask_id
  BEGIN SELECT RAISE(ABORT,'message structure is immutable'); END;           -- DA-8
CREATE TRIGGER messages_via_app_valid BEFORE INSERT ON messages WHEN NEW.via_app_message_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'via_app needs a human sender and an app message by that agent')
   WHERE NOT EXISTS (SELECT 1 FROM humans h WHERE h.identity_id = NEW.author_id)
      OR NOT EXISTS (SELECT 1 FROM messages a WHERE a.id = NEW.via_app_message_id AND a.app_json IS NOT NULL
                     AND a.author_id = NEW.via_app_agent_id AND a.deleted_at IS NULL);
END;                                                                          -- I-46 (E-2)

-- Empty until S4. Created now so the messages FK to asks holds (SQLite fails every messages write if the parent table is missing).
-- The asks_seal trigger and ask_options arrive with S4: the trigger reads ask_options, which does not exist yet.
-- owner: ask
CREATE TABLE asks (
  message_id   INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  asker_id     INTEGER NOT NULL REFERENCES agents(identity_id),
  asked_by_session INTEGER REFERENCES sessions(id),
  question     TEXT NOT NULL CHECK (length(question) <= 500),
  urgent       INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0,1)),
  sealed       INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),     -- 1 after the options are written (I-10, I-11)
  scrubbed_at  INTEGER,                                                 -- purge emptied question/options (I-49)
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','dismissed','closed')),
  close_reason TEXT CHECK (close_reason IN ('removed','withdrawn','deleted','agent_revoked')),
  chosen_kind  TEXT CHECK (chosen_kind IN ('recommended','alternative','custom')),
  chosen_index INTEGER CHECK (chosen_index BETWEEN 1 AND 4),
  chosen_text  TEXT CHECK (chosen_text IS NULL OR length(chosen_text) <= 4000),   -- '' after scrub
  answer_via   TEXT CHECK (answer_via IN ('inline','now')),                 -- inline = in the conversation (E-4); no CLI answer in v1 (C-3)
  resolved_by  INTEGER REFERENCES humans(identity_id),
  resolved_at  INTEGER,
  acked_at     INTEGER, acked_by_session INTEGER REFERENCES sessions(id),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (message_id, conversation_id),
  FOREIGN KEY (message_id, conversation_id) REFERENCES messages(id, conversation_id) ON DELETE CASCADE,   -- DA-8
  CHECK (scrubbed_at IS NOT NULL OR length(question) >= 1),
  CHECK ((state = 'closed') = (close_reason IS NOT NULL)),
  CHECK ((state IN ('answered','dismissed')) = (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK ((state = 'answered') = (chosen_kind IS NOT NULL)),
  CHECK ((chosen_kind = 'alternative') = (chosen_index IS NOT NULL)),
  CHECK (chosen_kind IS NOT 'custom' OR chosen_text IS NOT NULL),
  CHECK (acked_at IS NULL OR state <> 'open')
) STRICT;
CREATE INDEX asks_now ON asks(urgent DESC, message_id DESC) WHERE state = 'open';
CREATE INDEX asks_conv_open ON asks(conversation_id, asker_id) WHERE state IN ('open','dismissed');   -- removal closes open + dismissed
CREATE INDEX asks_unacked ON asks(asker_id, message_id) WHERE acked_at IS NULL AND state <> 'open';  -- brief
CREATE INDEX asks_resolved ON asks(resolved_at) WHERE state IN ('answered','dismissed');
CREATE INDEX asks_conv ON asks(conversation_id);
CREATE INDEX asks_asker ON asks(asker_id);
CREATE INDEX asks_session ON asks(asked_by_session);
CREATE INDEX asks_acked_session ON asks(acked_by_session);
CREATE INDEX asks_resolved_by ON asks(resolved_by);
CREATE TRIGGER asks_insert_valid BEFORE INSERT ON asks                            -- DA-8
  WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.kind = 'ask' AND m.author_id = NEW.asker_id)
  BEGIN SELECT RAISE(ABORT,'ask must sit on its asker''s ask message'); END;
CREATE TRIGGER asks_content_immutable BEFORE UPDATE OF question, asker_id, urgent, conversation_id ON asks
  WHEN NEW.asker_id IS NOT OLD.asker_id OR NEW.urgent IS NOT OLD.urgent OR NEW.conversation_id IS NOT OLD.conversation_id
    OR (NEW.question IS NOT OLD.question AND NEW.scrubbed_at IS NULL)
  BEGIN SELECT RAISE(ABORT,'ask content is immutable'); END;                 -- I-10

-- owner: inbox
CREATE TABLE inbox_items (                                -- I-43 (§3.8)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  reason TEXT NOT NULL CHECK (reason IN ('mention','thread','activity','ask_resolved','membership','app_result')),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  first_message_id INTEGER, message_id INTEGER,           -- coalesced range (ids only; content read via canSee)
  ask_message_id  INTEGER,
  count         INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  source_seq    INTEGER NOT NULL,
  prefer_session_id INTEGER REFERENCES sessions(id),     -- pickup holder, else last poster in that conversation
  not_before    INTEGER,                                  -- voice: held until the transcript is done or 120 s pass (E-5)
  state       TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','claimed','acked','expired')),
  claim_session_id INTEGER REFERENCES sessions(id),
  claim_token BLOB CHECK (claim_token IS NULL OR length(claim_token) = 16),   -- a fence, not a credential (M3)
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
  CHECK (reason NOT IN ('mention','thread','activity','app_result') OR conversation_id IS NOT NULL)
) STRICT;
CREATE INDEX inbox_identity ON inbox_items(identity_id, state, id);              -- FK; the claim query
CREATE UNIQUE INDEX inbox_coalesce ON inbox_items(identity_id, conversation_id)
  WHERE state = 'ready' AND reason IN ('mention','thread','activity');          -- one ready conversation item (C-10, M4)
CREATE INDEX inbox_conv ON inbox_items(conversation_id);
CREATE INDEX inbox_claim_session ON inbox_items(claim_session_id) WHERE claim_session_id IS NOT NULL;
CREATE INDEX inbox_acked_session ON inbox_items(acked_by_session) WHERE acked_by_session IS NOT NULL;
CREATE INDEX inbox_prefer_session ON inbox_items(prefer_session_id) WHERE prefer_session_id IS NOT NULL;

-- owner: readstate
CREATE TABLE read_cursors (
  identity_id INTEGER NOT NULL REFERENCES identities(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_main_id INTEGER NOT NULL CHECK (last_read_main_id >= 0),
  thread_floor_id   INTEGER NOT NULL CHECK (thread_floor_id >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, conversation_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX read_cursors_conv ON read_cursors(conversation_id);
CREATE TRIGGER read_cursors_forward BEFORE UPDATE ON read_cursors
  WHEN NEW.last_read_main_id < OLD.last_read_main_id OR NEW.thread_floor_id < OLD.thread_floor_id
  BEGIN SELECT RAISE(ABORT,'read cursors only move forward'); END;           -- I-15

-- events: rebuilt to the §7 shape. `id` becomes `seq` (same numbers, so nothing that holds an id breaks), `payload`
-- becomes `payload_json`, and every old type gets ".v1". No alias column is kept: readers use `payload_json`.
-- owner: event
CREATE TABLE events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type GLOB '[a-z]*.[a-z_]*.v[0-9]*'),
  actor_id INTEGER, session_id INTEGER,                    -- no FKs: the event write never fails on an FK edge
  conversation_id INTEGER, audience_id INTEGER, message_id INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 1024),  -- ids/enums only (I-23)
  idem_key TEXT CHECK (idem_key IS NULL OR length(idem_key) <= 100),
  created_at INTEGER NOT NULL,
  CHECK (idem_key IS NULL OR actor_id IS NOT NULL)
) STRICT;
INSERT INTO events_new (seq, type, payload_json, created_at)
  SELECT id, type || '.v1', payload, created_at FROM events ORDER BY id;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX events_idem ON events(actor_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TRIGGER events_immutable BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;  -- I-23
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;  -- until S3 decides prune
