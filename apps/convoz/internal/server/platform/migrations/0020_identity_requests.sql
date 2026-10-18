-- Add agent by prompt: the agent sends its own identity and the owner approves it on one card (owner decision, design §3.1).
-- Two kinds share one table:
--   login:   rides on a device-flow request (machine_request_id); the one Approve makes the machine AND the identity.
--   session: a machine that is already logged in asks for an identity it may not create itself (machine_id).
-- The ref is the only id the machine ever sees: 128 random bits, so it cannot be guessed. The request reserves no handle:
-- the handle is checked again when the owner approves.

-- owner: auth
CREATE TABLE identity_requests (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE CHECK (length(ref) = 36 AND ref GLOB 'idr_*' AND substr(ref, 5) NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('login','session')),
  machine_request_id INTEGER REFERENCES machine_requests(id),
  machine_id INTEGER REFERENCES machines(id),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 2 AND 40 AND handle NOT GLOB '*[^a-z0-9-]*' AND substr(handle,1,1) GLOB '[a-z]'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 80),
  avatar_svg TEXT CHECK (avatar_svg IS NULL OR length(avatar_svg) <= 4096),            -- sanitized (I-32)
  conversation_id INTEGER REFERENCES conversations(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied')),   -- expiry is by time
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_by INTEGER REFERENCES humans(identity_id), decided_at INTEGER,
  identity_id INTEGER REFERENCES agents(identity_id),                                  -- the agent the approval made
  CHECK ((kind = 'login') = (machine_request_id IS NOT NULL)),
  CHECK ((kind = 'session') = (machine_id IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at - created_at <= 86400000),             -- pending ≤ 24 h
  CHECK ((state = 'pending') = (decided_by IS NULL)),
  CHECK ((state = 'approved') = (identity_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX identity_requests_login ON identity_requests(machine_request_id) WHERE machine_request_id IS NOT NULL;
CREATE INDEX identity_requests_machine ON identity_requests(machine_id, created_at) WHERE machine_id IS NOT NULL;
CREATE INDEX identity_requests_pending ON identity_requests(created_at) WHERE state = 'pending';
CREATE INDEX identity_requests_conversation ON identity_requests(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX identity_requests_decided_by ON identity_requests(decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX identity_requests_identity ON identity_requests(identity_id) WHERE identity_id IS NOT NULL;
