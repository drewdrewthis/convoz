-- "Transcribe again" keeps the words on show while the new transcript is pending: the old text waits in previous_text (the state/text
-- check forbids text on a pending row). A redo that fails every try puts the old words back as done and sets redo_failed, so the page
-- can say so; the next requeue or a finished transcript clears it.

-- owner: transcript
ALTER TABLE transcripts ADD COLUMN previous_text TEXT CHECK (previous_text IS NULL OR length(previous_text) <= 16384);
ALTER TABLE transcripts ADD COLUMN redo_failed INTEGER NOT NULL DEFAULT 0 CHECK (redo_failed IN (0,1));
