-- owner: platform
CREATE TABLE system_kv (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT
) STRICT;

-- owner: event
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- The event log is append-only (I-4): history is never rewritten.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;
