-- Identity: one row per principal (design draft 9 §7). Humans and agents hang off identities 1:1.
-- Every CREATE TABLE has an "-- owner: <module>" line; scripts/check_table_ownership.py reads it.

-- owner: identity
CREATE TABLE identities (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('human','agent')),
  handle        TEXT    NOT NULL COLLATE NOCASE UNIQUE
                CHECK (length(handle) BETWEEN 2 AND 40 AND handle NOT GLOB '*[^a-z0-9-]*' AND substr(handle,1,1) GLOB '[a-z]'),
  display_name  TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  display_skeleton TEXT NOT NULL,                     -- UTS-39 skeleton, lowercased (confusable check, I-3)
  avatar_letter TEXT    NOT NULL CHECK (length(avatar_letter) = 1),
  avatar_palette INTEGER NOT NULL CHECK (avatar_palette BETWEEN 0 AND 11),
  avatar_svg    TEXT    CHECK (avatar_svg IS NULL OR length(avatar_svg) <= 4096),  -- sanitized (I-32)
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER,
  UNIQUE (id, kind)                                   -- target of kind-typed FKs
) STRICT;
CREATE UNIQUE INDEX identities_display_skeleton ON identities(display_skeleton) WHERE disabled_at IS NULL;
CREATE TRIGGER identities_no_delete BEFORE DELETE ON identities BEGIN SELECT RAISE(ABORT,'identities are never deleted'); END;
CREATE TRIGGER identities_kind_immutable BEFORE UPDATE OF kind ON identities WHEN NEW.kind <> OLD.kind
  BEGIN SELECT RAISE(ABORT,'kind is immutable'); END;
CREATE TRIGGER identities_handle_only_anonymize BEFORE UPDATE OF handle ON identities
  WHEN NEW.handle <> OLD.handle AND NEW.handle <> ('deleted-' || OLD.id)
  BEGIN SELECT RAISE(ABORT,'handle is immutable'); END;
CREATE TRIGGER identities_handle_retire AFTER UPDATE OF handle ON identities WHEN NEW.handle <> OLD.handle
  BEGIN INSERT INTO retired_handles(handle, identity_id, retired_at) VALUES (OLD.handle, OLD.id, NEW.disabled_at); END;
CREATE TRIGGER identities_handle_not_retired BEFORE INSERT ON identities
  WHEN EXISTS (SELECT 1 FROM retired_handles WHERE handle = NEW.handle)
  BEGIN SELECT RAISE(ABORT,'handle was used before'); END;          -- I-3: never reused

-- owner: identity
CREATE TABLE retired_handles (
  handle      TEXT PRIMARY KEY COLLATE NOCASE,
  identity_id INTEGER NOT NULL REFERENCES identities(id),
  retired_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX retired_handles_identity ON retired_handles(identity_id);

-- owner: identity
CREATE TABLE humans (
  identity_id INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'human' CHECK (kind = 'human'),
  role        TEXT NOT NULL CHECK (role IN ('owner','member','guest')),
  email       TEXT CHECK (email IS NULL OR length(email) <= 254),
  created_via TEXT NOT NULL CHECK (created_via IN ('bootstrap','invite')),
  FOREIGN KEY (identity_id, kind) REFERENCES identities(id, kind)
) STRICT;
CREATE UNIQUE INDEX humans_one_owner ON humans(role) WHERE role = 'owner';      -- I-1
CREATE TRIGGER humans_no_delete BEFORE DELETE ON humans BEGIN SELECT RAISE(ABORT,'humans are never deleted'); END;
CREATE TRIGGER humans_owner_role_fixed BEFORE UPDATE OF role ON humans
  WHEN NEW.role <> OLD.role AND (OLD.role = 'owner' OR NEW.role = 'owner')
  BEGIN SELECT RAISE(ABORT,'owner role cannot change'); END;          -- I-1

-- owner: identity
CREATE TABLE agents (
  identity_id  INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'agent' CHECK (kind = 'agent'),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 80),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities_json) AND json_array_length(capabilities_json) <= 20),
  created_by_human   INTEGER REFERENCES humans(identity_id),
  created_by_machine INTEGER REFERENCES machines(id),
  profile_changed_at INTEGER,
  FOREIGN KEY (identity_id, kind) REFERENCES identities(id, kind),
  CHECK ((created_by_human IS NULL) <> (created_by_machine IS NULL))
) STRICT;
CREATE INDEX agents_created_by_human ON agents(created_by_human);
CREATE INDEX agents_created_by_machine ON agents(created_by_machine);
CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'agents are never deleted'); END;
