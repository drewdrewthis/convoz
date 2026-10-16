-- Audit: written in the same transaction as the action it records.

-- owner: audit
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, event_seq INTEGER,
  actor_id   INTEGER REFERENCES identities(id),
  machine_id INTEGER REFERENCES machines(id),
  session_id INTEGER REFERENCES sessions(id),
  device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action GLOB '[a-z]*.[a-z_]*'),
  target_kind TEXT, target_id INTEGER,
  detail_json TEXT CHECK (detail_json IS NULL OR (json_valid(detail_json) AND length(detail_json) <= 1024))  -- ids/enums only, schema per action
) STRICT;
CREATE INDEX audit_at ON audit(at);                       -- admin list, 1 y retention
CREATE INDEX audit_actor ON audit(actor_id, at);
CREATE INDEX audit_machine ON audit(machine_id, at);      -- "what did machine M do"
CREATE INDEX audit_session ON audit(session_id);
CREATE INDEX audit_device ON audit(device_id);
CREATE INDEX audit_target ON audit(target_kind, target_id, at);
