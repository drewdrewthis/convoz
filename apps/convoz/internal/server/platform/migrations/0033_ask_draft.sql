-- A draft ask: an agent shows the owner a message it wants to send in the owner's name, and the owner sends it (as written or
-- edited) or does not (Drew, conv 32 msg 650). The ask keeps the draft and, when there is one, the message it answers.
-- (A purge empties them, as it empties the question.) All three are NULL on any other ask. The answer needs no column: Send is the recommended choice and keeps the final text in chosen_text.
ALTER TABLE asks ADD COLUMN draft_text TEXT CHECK (draft_text IS NULL OR length(draft_text) <= 4000);
ALTER TABLE asks ADD COLUMN original_text TEXT CHECK (original_text IS NULL OR length(original_text) <= 2000);
ALTER TABLE asks ADD COLUMN original_from TEXT CHECK (original_from IS NULL OR length(original_from) <= 200);
