-- An agent's handle can change (I-51). Owner (Drew, 2026-10-18): "Handles I think can also change, that seems fine because
-- there's an id, right?" Earlier: "the handle is never reused." Every record keys on identities.id, so only the handle text moves;
-- the old handle is retired at once and never used again.

-- handle_changed_at is the app clock's time of the last change, so the retire trigger and the 30-day rule need no SQL clock.
ALTER TABLE identities ADD COLUMN handle_changed_at INTEGER;

DROP TRIGGER identities_handle_only_anonymize;
DROP TRIGGER identities_handle_retire;

-- Only an enabled agent's handle changes; a human's moves only to deleted-<id> (delete my data), as before.
CREATE TRIGGER identities_handle_change BEFORE UPDATE OF handle ON identities
  WHEN NEW.handle <> OLD.handle AND NEW.handle <> ('deleted-' || OLD.id)
BEGIN
  SELECT RAISE(ABORT,'handle is immutable') WHERE OLD.kind <> 'agent' OR OLD.disabled_at IS NOT NULL;
  SELECT RAISE(ABORT,'handle change needs its time') WHERE NEW.handle_changed_at IS NULL OR NEW.handle_changed_at IS OLD.handle_changed_at;
  SELECT RAISE(ABORT,'handle changes once in 30 days') WHERE NEW.handle_changed_at - OLD.handle_changed_at < 2592000000;
  SELECT RAISE(ABORT,'handle was used before') WHERE EXISTS (SELECT 1 FROM retired_handles WHERE handle = NEW.handle);  -- I-3
END;

CREATE TRIGGER identities_handle_retire AFTER UPDATE OF handle ON identities WHEN NEW.handle <> OLD.handle
BEGIN
  INSERT INTO retired_handles(handle, identity_id, retired_at)
  VALUES (OLD.handle, OLD.id, CASE WHEN NEW.handle = ('deleted-' || OLD.id) THEN NEW.disabled_at ELSE NEW.handle_changed_at END);
END;

-- An agent asks the owner for a new handle; the owner approves it with one tap in Now. Like identity_requests, a request reserves
-- nothing: the rules run again on approval. One request waits per agent; filing for another handle withdraws it.
-- owner: identity
CREATE TABLE handle_requests (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE CHECK (length(ref) = 36 AND ref GLOB 'hdr_*' AND substr(ref, 5) NOT GLOB '*[^0-9a-f]*'),
  identity_id INTEGER NOT NULL REFERENCES agents(identity_id),
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL CHECK (length(to_handle) BETWEEN 2 AND 40 AND to_handle NOT GLOB '*[^a-z0-9-]*' AND substr(to_handle,1,1) GLOB '[a-z]'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','withdrawn')),   -- expiry is by time
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_by INTEGER REFERENCES humans(identity_id), decided_at INTEGER,
  CHECK (expires_at > created_at AND expires_at - created_at <= 86400000),             -- pending ≤ 24 h
  CHECK ((state IN ('approved','denied')) = (decided_by IS NOT NULL)),
  CHECK ((state = 'pending') = (decided_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX handle_requests_one_pending ON handle_requests(identity_id) WHERE state = 'pending';
CREATE INDEX handle_requests_identity ON handle_requests(identity_id, created_at);
CREATE INDEX handle_requests_pending ON handle_requests(created_at) WHERE state = 'pending';
CREATE INDEX handle_requests_decided_by ON handle_requests(decided_by) WHERE decided_by IS NOT NULL;
