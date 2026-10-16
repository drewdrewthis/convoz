CREATE TABLE consumer_offsets (
  consumer      TEXT    NOT NULL PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
) STRICT;
