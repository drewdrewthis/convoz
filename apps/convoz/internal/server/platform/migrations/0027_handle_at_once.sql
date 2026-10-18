-- An agent's own handle change applies at once, with no owner approval (I-51). Owner (Drew, 2026-10-18), answering a Convoz ask,
-- chose "Change at once, no approval": "I think that's too defensive and requires too much machinery?"
-- So the request flow goes, and the schema's once-in-30-days rule goes with it: the server limits changes per day (3), counted from
-- handle_changes below.
-- Owner: "you can rename it back from Crew". So an identity may take back a handle it retired itself: that ends the alias (the
-- retired row goes). Any other identity still never gets it (I-3).

-- Pending requests are dropped with the table: nothing reads them any more.
DROP TABLE handle_requests;

DROP TRIGGER identities_handle_change;
CREATE TRIGGER identities_handle_change BEFORE UPDATE OF handle ON identities
  WHEN NEW.handle <> OLD.handle AND NEW.handle <> ('deleted-' || OLD.id)
BEGIN
  SELECT RAISE(ABORT,'handle is immutable') WHERE OLD.kind <> 'agent' OR OLD.disabled_at IS NOT NULL;
  SELECT RAISE(ABORT,'handle change needs its time') WHERE NEW.handle_changed_at IS NULL OR NEW.handle_changed_at IS OLD.handle_changed_at;
  SELECT RAISE(ABORT,'handle was used before') WHERE EXISTS (SELECT 1 FROM retired_handles WHERE handle = NEW.handle AND identity_id <> OLD.id);  -- I-3
END;

CREATE TRIGGER identities_handle_reclaim AFTER UPDATE OF handle ON identities WHEN NEW.handle <> OLD.handle
BEGIN
  DELETE FROM retired_handles WHERE handle = NEW.handle AND identity_id = OLD.id;
END;

-- Every change, kept for the rate limit: taking a handle back deletes its retired row, so retired_handles cannot count them.
-- owner: identity
CREATE TABLE handle_changes (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES identities(id),
  changed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX handle_changes_identity ON handle_changes(identity_id, changed_at);
INSERT INTO handle_changes(identity_id, changed_at) SELECT identity_id, retired_at FROM retired_handles r WHERE EXISTS (SELECT 1 FROM identities i WHERE i.id = r.identity_id AND i.kind = 'agent');
CREATE TRIGGER identities_handle_counted AFTER UPDATE OF handle ON identities
  WHEN NEW.handle <> OLD.handle AND NEW.handle <> ('deleted-' || OLD.id)
BEGIN
  INSERT INTO handle_changes(identity_id, changed_at) VALUES (OLD.id, NEW.handle_changed_at);
END;
