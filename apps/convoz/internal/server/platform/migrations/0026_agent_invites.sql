-- An invite lets one agent outside the tailnet ask for access (owner ruling, 2026-10-18): it works once, ends after 24 hours, and is made by the
-- owner or by an approved agent. Only the SHA-256 of the token is kept. The request an invite was spent on is named by used_kind and
-- used_request_id (a machine_requests id for a login, an identity_requests id for a session request), so the owner's card can say who invited.

-- owner: auth
CREATE TABLE agent_invites (
  id INTEGER PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  hint TEXT NOT NULL CHECK (length(hint) = 4),                 -- the last 4 characters of the token: tells invites apart in a list, cannot be used
  maker_id INTEGER NOT NULL REFERENCES identities(id),         -- the owner, or the agent that made it
  conversation_id INTEGER REFERENCES conversations(id),        -- the conversation the invited agent asks to join; null for none
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 80),    -- shown on the owner's card
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_kind TEXT CHECK (used_kind IN ('login','session')),
  used_request_id INTEGER,
  revoked_at INTEGER,
  expired_at INTEGER,                                          -- when the expiry was written to the audit
  CHECK (expires_at > created_at AND expires_at - created_at <= 86400000),
  CHECK ((used_at IS NULL) = (used_kind IS NULL) AND (used_at IS NULL) = (used_request_id IS NULL)),
  CHECK ((used_at IS NOT NULL) + (revoked_at IS NOT NULL) + (expired_at IS NOT NULL) <= 1)
) STRICT;
CREATE INDEX agent_invites_open_by_maker ON agent_invites(maker_id) WHERE used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL;
CREATE INDEX agent_invites_open_expiry ON agent_invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL;
CREATE INDEX agent_invites_conversation ON agent_invites(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX agent_invites_used ON agent_invites(used_kind, used_request_id) WHERE used_at IS NOT NULL;
