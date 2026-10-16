-- Auth: passkeys, devices, step-ups, recovery, bootstrap, machines, device flow, sessions.
-- Delta from the design DDL: machine_requests.poll_interval_ms (slow_down needs per-request state).
-- machines and sessions ship now, with the rest of the group, because audit and agents reference them.

-- owner: auth
CREATE TABLE passkeys (
  id             INTEGER PRIMARY KEY,
  human_id       INTEGER NOT NULL REFERENCES humans(identity_id),
  credential_id  BLOB    NOT NULL UNIQUE,
  public_key     BLOB    NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid         BLOB,
  backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0,1)),
  label          TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  registered_via TEXT    NOT NULL CHECK (registered_via IN ('bootstrap','session','recovery')),
  destructive_step_up_after INTEGER NOT NULL,           -- created_at, or created_at + 24 h for 'recovery' (I-26)
  created_at     INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE INDEX passkeys_human ON passkeys(human_id, revoked_at);

-- owner: auth
CREATE TABLE devices (                                   -- a human login on one browser/PWA install
  id            INTEGER PRIMARY KEY,
  human_id      INTEGER NOT NULL REFERENCES humans(identity_id),
  token_hash    BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  passkey_id    INTEGER REFERENCES passkeys(id) ON DELETE SET NULL,
  label         TEXT    NOT NULL, user_agent TEXT CHECK (length(user_agent) <= 300),
  limited       INTEGER NOT NULL DEFAULT 0 CHECK (limited IN (0,1)),   -- recovery session: register a passkey only
  created_at    INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
  revoked_at    INTEGER, revoke_reason TEXT CHECK (revoke_reason IN ('logout','user','sign_out_all','passkey_revoked','expired','deleted')),
  CHECK (expires_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  UNIQUE (id, human_id)                                   -- target of push_subscriptions (DA-8)
) STRICT;
CREATE INDEX devices_human ON devices(human_id, revoked_at);
CREATE INDEX devices_passkey ON devices(passkey_id);

-- owner: auth
CREATE TABLE step_ups (                                  -- single use, one action (SEC-1, I-26)
  id         INTEGER PRIMARY KEY,
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  passkey_id INTEGER NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action GLOB '[a-z]*.[a-z_]*' AND length(action) <= 40),
  target_id  INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  CHECK (expires_at > created_at AND expires_at - created_at <= 300000)
) STRICT;
CREATE INDEX step_ups_device ON step_ups(device_id);
CREATE INDEX step_ups_passkey ON step_ups(passkey_id);

-- owner: auth
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  human_id   INTEGER NOT NULL REFERENCES humans(identity_id),
  code_hash  BLOB NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  batch      INTEGER NOT NULL CHECK (batch >= 1),
  created_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE INDEX recovery_codes_human ON recovery_codes(human_id, used_at);

-- owner: auth
CREATE TABLE bootstrap_links (                           -- minted only over the admin Unix socket (§3.6)
  id INTEGER PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, used_passkey_id INTEGER REFERENCES passkeys(id),
  CHECK (expires_at > created_at AND expires_at - created_at <= 600000),
  CHECK ((used_at IS NULL) = (used_passkey_id IS NULL))
) STRICT;
CREATE INDEX bootstrap_links_passkey ON bootstrap_links(used_passkey_id);

-- owner: auth
CREATE TABLE machines (
  id INTEGER PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name NOT GLOB '*[^a-z0-9.-]*'),
  key_hash     BLOB NOT NULL UNIQUE CHECK (length(key_hash) = 32),      -- SHA-256 lookup (constant-time compare)
  key_enc      BLOB NOT NULL,                                           -- AES-256-GCM nonce‖ct‖tag, purpose machine_key (I-25)
  key_dek_id   INTEGER NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),      -- +1 on regenerate; part of the AAD
  key_hint     TEXT NOT NULL CHECK (length(key_hint) <= 16),             -- 'cvz_m_' + 4 chars
  scopes       INTEGER NOT NULL CHECK (scopes BETWEEN 1 AND 127),
  allow_mode   TEXT NOT NULL DEFAULT 'list' CHECK (allow_mode IN ('list','any')),
  approved_by  INTEGER NOT NULL REFERENCES humans(identity_id),
  created_at   INTEGER NOT NULL, key_created_at INTEGER NOT NULL,
  last_used_at INTEGER, last_used_source TEXT CHECK (last_used_source IS NULL OR length(last_used_source) <= 255),  -- 'unknown' until the whois spike passes
  revoked_at   INTEGER, revoke_reason TEXT CHECK (revoke_reason IN ('user','lost','compromised')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX machines_name ON machines(name) WHERE revoked_at IS NULL;   -- I-33
CREATE INDEX machines_approved_by ON machines(approved_by);

-- owner: auth
CREATE TABLE machine_allow (                             -- allow_mode='list': explicit identities and globs
  id INTEGER PRIMARY KEY,
  machine_id  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  identity_id INTEGER REFERENCES agents(identity_id),
  glob        TEXT CHECK (glob IS NULL OR (length(glob) BETWEEN 1 AND 40 AND glob NOT GLOB '*[^a-z0-9*?-]*')),
  CHECK ((identity_id IS NULL) <> (glob IS NULL))
) STRICT;
CREATE INDEX machine_allow_machine ON machine_allow(machine_id);
CREATE UNIQUE INDEX machine_allow_identity ON machine_allow(machine_id, identity_id) WHERE identity_id IS NOT NULL;
CREATE UNIQUE INDEX machine_allow_glob ON machine_allow(machine_id, glob) WHERE glob IS NOT NULL;
CREATE INDEX machine_allow_identity_fk ON machine_allow(identity_id) WHERE identity_id IS NOT NULL;

-- owner: auth
CREATE TABLE machine_requests (                          -- device flow (I-36)
  id INTEGER PRIMARY KEY,
  device_code_hash BLOB NOT NULL UNIQUE CHECK (length(device_code_hash) = 32),
  user_code      TEXT NOT NULL CHECK (user_code GLOB '[A-Z][A-Z][A-Z][A-Z]-[A-Z][A-Z][A-Z][A-Z]'),  -- not a secret
  requested_name TEXT NOT NULL CHECK (length(requested_name) BETWEEN 1 AND 60 AND requested_name NOT GLOB '*[^a-z0-9.-]*'),
  host_info      TEXT CHECK (host_info IS NULL OR length(host_info) <= 200),   -- self-reported, shown as such
  source         TEXT NOT NULL DEFAULT 'unknown' CHECK (length(source) <= 255),
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','delivered')),  -- expiry is by time
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_poll_at INTEGER, poll_count INTEGER NOT NULL DEFAULT 0,
  poll_interval_ms INTEGER NOT NULL DEFAULT 5000,
  decided_by INTEGER REFERENCES humans(identity_id), decided_at INTEGER,
  machine_id INTEGER REFERENCES machines(id),            -- the new machine (no key replace in the device flow)
  CHECK (expires_at > created_at AND expires_at - created_at <= 1200000),    -- pending ≤10 min; approved: 10 min after approval (M6)
  CHECK (state <> 'pending' OR expires_at - created_at <= 600000),            -- a pending request lives ≤10 min
  CHECK (state = 'pending' OR expires_at <= decided_at + 600000),
  CHECK ((state = 'pending') = (decided_by IS NULL)),
  CHECK ((state IN ('approved','delivered')) = (machine_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX machine_requests_user_code ON machine_requests(user_code) WHERE state = 'pending';
CREATE INDEX machine_requests_pending ON machine_requests(created_at) WHERE state = 'pending';   -- Now card, ≤3 pending
CREATE INDEX machine_requests_decided_by ON machine_requests(decided_by);
CREATE INDEX machine_requests_machine ON machine_requests(machine_id);

-- owner: auth
CREATE TABLE sessions (                                  -- one Claude session acting as one identity (I-37)
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  machine_id  INTEGER NOT NULL REFERENCES machines(id),
  token_hash  BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  client_id   TEXT NOT NULL CHECK (length(client_id) BETWEEN 8 AND 64),
  label       TEXT NOT NULL CHECK (length(label) <= 80),           -- e.g. "claude-code · ~/repo"
  scopes      INTEGER NOT NULL CHECK (scopes BETWEEN 1 AND 127),
  created_at  INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                                     -- ≤ now + 12 h, renewed on use
  ended_at    INTEGER, end_reason TEXT CHECK (end_reason IN ('expired','idle','logout','replaced','key_regenerated','machine_revoked','identity_disabled','allow_removed')),  -- 'replaced' = re-mint with the same client_id (M5)
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX sessions_open_client ON sessions(identity_id, machine_id, client_id) WHERE ended_at IS NULL;  -- DA-7
CREATE INDEX sessions_identity ON sessions(identity_id, ended_at, last_seen_at);   -- FK; live cap per identity; reaper
CREATE INDEX sessions_machine ON sessions(machine_id, ended_at);                   -- FK; revoke ends sessions; live cap per machine
CREATE TRIGGER sessions_identity_allowed BEFORE INSERT ON sessions               -- I-37 (DA-8)
BEGIN
  SELECT RAISE(ABORT,'identity not allowed on this machine') WHERE NOT EXISTS (
    SELECT 1 FROM machines m WHERE m.id = NEW.machine_id AND m.revoked_at IS NULL AND (
      m.allow_mode = 'any'
      OR EXISTS (SELECT 1 FROM machine_allow a WHERE a.machine_id = m.id AND a.identity_id = NEW.identity_id)
      OR EXISTS (SELECT 1 FROM machine_allow a, identities i
                 WHERE a.machine_id = m.id AND a.glob IS NOT NULL AND i.id = NEW.identity_id AND i.handle GLOB a.glob)));
END;
