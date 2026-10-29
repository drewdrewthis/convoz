-- The owner's Okay works on every item in his feed, not only an fyi (owner, Drew, 179 msg 12316: "every item must have Okay, otherwise there is no way
-- to get them out of the feed"). 0047 had a CHECK that allowed ack_kind 'got_it' only when state = 'fyi'; SQLite cannot drop a CHECK in place, so
-- feed_items is rebuilt without it (and feed_item_events, which references it ON DELETE CASCADE, with it: the pattern of 0044). Nothing else
-- changes: same columns, same other checks, same indexes. An acked item that is not an fyi leaves the feed (OpenItems); a later move of the agent clears the ack.
-- No down file: restore the pre-migrate backup the server writes to <data>/backups.
-- owner: item
CREATE TABLE feed_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL REFERENCES agents(identity_id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  work_key TEXT NOT NULL CHECK (length(work_key) BETWEEN 1 AND 64),
  seq      INTEGER NOT NULL,
  state    TEXT NOT NULL CHECK (state IN ('pending','started','blocking','done','fyi','dropped')),
  -- 1 when the step is the owner's to do: it becomes blocking (not started) when it is now.
  owner_step INTEGER NOT NULL DEFAULT 0 CHECK (owner_step IN (0,1)),
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  context        TEXT NOT NULL DEFAULT '' CHECK (length(context) <= 2000),
  -- A blocking row may have none: the owner can then only add info, never Accept.
  recommendation TEXT CHECK (recommendation IS NULL OR length(recommendation) BETWEEN 1 AND 500),
  due_at INTEGER,
  acked_at INTEGER,
  acked_by INTEGER REFERENCES humans(identity_id),
  ack_kind TEXT CHECK (ack_kind IN ('accept','answer','got_it')),
  snoozed_until INTEGER,
  thread_root_id INTEGER REFERENCES messages(id),
  -- Every change an agent makes to what the owner reads (and every owner move) bumps it; Accept names the version it saw.
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, conversation_id, work_key),
  UNIQUE (agent_id, conversation_id, seq),
  CHECK (state <> 'blocking' OR owner_step = 1),
  CHECK ((acked_at IS NULL) = (ack_kind IS NULL) AND (acked_at IS NULL) = (acked_by IS NULL)),
  CHECK (ack_kind IS NULL OR ack_kind = 'got_it' OR state = 'done'),
  CHECK (ack_kind IS NOT 'accept' OR recommendation IS NOT NULL)
) STRICT;
INSERT INTO feed_items_new (id, agent_id, conversation_id, work_key, seq, state, owner_step, title, context, recommendation, due_at, acked_at, acked_by, ack_kind, snoozed_until, thread_root_id, version, created_at, updated_at) SELECT id, agent_id, conversation_id, work_key, seq, state, owner_step, title, context, recommendation, due_at, acked_at, acked_by, ack_kind, snoozed_until, thread_root_id, version, created_at, updated_at FROM feed_items;
-- owner: item
CREATE TABLE feed_item_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES feed_items_new(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  event   TEXT NOT NULL CHECK (event IN ('start','edit','block','promote','done','fyi','drop','say','accept','info','answer','got_it','snooze','unsnooze')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending','started','blocking','done','fyi','dropped')),
  by_identity INTEGER REFERENCES identities(id),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  at INTEGER NOT NULL
) STRICT;
INSERT INTO feed_item_events_new (id, item_id, version, event, to_state, by_identity, note, at) SELECT id, item_id, version, event, to_state, by_identity, note, at FROM feed_item_events;
DROP TABLE feed_item_events;
DROP TABLE feed_items;
ALTER TABLE feed_items_new RENAME TO feed_items;
ALTER TABLE feed_item_events_new RENAME TO feed_item_events;
CREATE UNIQUE INDEX feed_items_one_now ON feed_items(agent_id, conversation_id) WHERE state IN ('started','blocking');
CREATE INDEX feed_items_conversation ON feed_items(conversation_id);
CREATE INDEX feed_items_state ON feed_items(state, updated_at);
CREATE INDEX feed_item_events_item ON feed_item_events(item_id, id);
