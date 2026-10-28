-- Feed items (slice 1): one row is one step of an agent's work for its whole life. A plan is the rows of one (agent, conversation) in
-- seq order; exactly one is now (started or blocking), the others wait as pending, and when the now item leaves the next one is
-- promoted in the same transaction. Owner (Drew, 179 msg 11663): "a plan is an ordered list; one is now, the rest pending".
-- Rollback is a data restore of the cold copy taken before the swap: there is no down migration.
-- owner: item
CREATE TABLE feed_items (
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
  -- Every change an agent makes to what the owner reads (and every owner move) bumps it; Accept names the version it saw.
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, conversation_id, work_key),
  UNIQUE (agent_id, conversation_id, seq),
  CHECK (state <> 'blocking' OR owner_step = 1),
  CHECK ((acked_at IS NULL) = (ack_kind IS NULL) AND (acked_at IS NULL) = (acked_by IS NULL)),
  CHECK (ack_kind IS NULL OR ack_kind = 'got_it' OR state = 'done'),
  CHECK (ack_kind IS NOT 'got_it' OR state = 'fyi'),
  CHECK (ack_kind IS NOT 'accept' OR recommendation IS NOT NULL)
) STRICT;
-- Exactly one NOW per agent and conversation, enforced by the database.
CREATE UNIQUE INDEX feed_items_one_now ON feed_items(agent_id, conversation_id) WHERE state IN ('started','blocking');
CREATE INDEX feed_items_conversation ON feed_items(conversation_id);
CREATE INDEX feed_items_state ON feed_items(state, updated_at);

-- The audit of one item, in the shape of ask_transitions; say and the owner's added info are events that leave the state alone.
-- owner: item
CREATE TABLE feed_item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  event   TEXT NOT NULL CHECK (event IN ('start','edit','block','promote','done','fyi','drop','say','accept','info','answer','got_it','snooze','unsnooze')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending','started','blocking','done','fyi','dropped')),
  by_identity INTEGER REFERENCES identities(id),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX feed_item_events_item ON feed_item_events(item_id, id);
