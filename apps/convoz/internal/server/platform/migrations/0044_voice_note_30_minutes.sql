-- A voice note may run 30 minutes, not 5 (owner: notes stopped by themselves at 5 minutes, without a word). The duration check of
-- uploads goes from 300000 to 1800000 ms; SQLite cannot change a CHECK in place, so the table is rebuilt. transcripts references
-- uploads ON DELETE CASCADE, so it is rebuilt too: the new transcripts point at the new uploads, the old tables go (transcripts first,
-- so dropping uploads cascades into nothing), and the renames carry the reference along (the pattern of 0030). No down file: a
-- migration has none here; to go back, restore the pre-migrate backup the server writes to <data>/backups before this runs.
-- owner: upload
CREATE TABLE uploads_new (                                    -- resumable (§12.3)
  id INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE CHECK (length(public_id) = 22),   -- 128-bit random; URLs and AEAD AAD
  uploader_id  INTEGER NOT NULL REFERENCES identities(id),
  session_id   INTEGER REFERENCES sessions(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('audio','image','file','app')),   -- app = Tier-2 bundle, served only by GET /api/apps/:id/frame
  state        TEXT NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving','complete')),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 26214400),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes BETWEEN 0 AND declared_size),  -- whole 1 MB segments, or all
  declared_sha256 BLOB NOT NULL CHECK (length(declared_sha256) = 32),   -- checked at completion
  mime_sniffed TEXT,
  serve_inline INTEGER NOT NULL DEFAULT 0 CHECK (serve_inline IN (0,1)),   -- I-44 allow-list result
  filename     TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  storage_name TEXT NOT NULL UNIQUE,
  dek_id       INTEGER NOT NULL, file_key_wrapped BLOB NOT NULL,
  width INTEGER, height INTEGER,
  duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 1800000),
  waveform     BLOB CHECK (waveform IS NULL OR (kind = 'audio' AND length(waveform) <= 64)),   -- 64 peaks 0..255 from the recorder
  created_at INTEGER NOT NULL, completed_at INTEGER, bound_at INTEGER,
  in_app INTEGER NOT NULL DEFAULT 0 CHECK (in_app IN (0,1)),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL AND mime_sniffed IS NOT NULL AND committed_bytes = declared_size)),
  CHECK ((message_id IS NULL) = (bound_at IS NULL)),
  CHECK (message_id IS NULL OR state = 'complete'),
  CHECK (serve_inline = 0 OR kind IN ('audio','image'))
) STRICT;
INSERT INTO uploads_new (id, public_id, uploader_id, session_id, conversation_id, message_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed,
  serve_inline, filename, storage_name, dek_id, file_key_wrapped, width, height, duration_ms, waveform, created_at, completed_at, bound_at, in_app)
SELECT id, public_id, uploader_id, session_id, conversation_id, message_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed,
  serve_inline, filename, storage_name, dek_id, file_key_wrapped, width, height, duration_ms, waveform, created_at, completed_at, bound_at, in_app FROM uploads;
-- owner: transcript
CREATE TABLE transcripts_new (
  upload_id INTEGER PRIMARY KEY REFERENCES uploads_new(id) ON DELETE CASCADE,
  state     TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  text      TEXT CHECK (text IS NULL OR length(text) <= 16384),
  engine    TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at INTEGER, updated_at INTEGER NOT NULL,
  previous_text TEXT CHECK (previous_text IS NULL OR length(previous_text) <= 16384),
  redo_failed INTEGER NOT NULL DEFAULT 0 CHECK (redo_failed IN (0,1)),
  CHECK ((state = 'done') = (text IS NOT NULL))
) STRICT;
INSERT INTO transcripts_new (upload_id, state, text, engine, attempts, next_attempt_at, updated_at, previous_text, redo_failed)
SELECT upload_id, state, text, engine, attempts, next_attempt_at, updated_at, previous_text, redo_failed FROM transcripts;
DROP TABLE transcripts;
DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;
ALTER TABLE transcripts_new RENAME TO transcripts;
CREATE INDEX uploads_message ON uploads(message_id);
CREATE INDEX uploads_unbound ON uploads(created_at) WHERE message_id IS NULL;      -- GC: incomplete or unbound after 24 h
CREATE INDEX uploads_conv ON uploads(conversation_id, kind, id);                   -- Shared tab
CREATE INDEX uploads_uploader ON uploads(uploader_id, created_at);                  -- FK; daily byte quota
CREATE INDEX uploads_session ON uploads(session_id);
CREATE INDEX transcripts_queue ON transcripts(next_attempt_at) WHERE state = 'pending';
