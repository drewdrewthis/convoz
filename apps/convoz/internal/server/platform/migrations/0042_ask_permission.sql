-- A permission ask: the agent is confident in one action and asks the owner to accept its risk (Drew, conv 349 msg 6199). The ask keeps
-- the action, its risk, how to undo it (or one_way = 1 when it cannot be undone), the other ways the agent considered (a JSON array of
-- 1 to 3 lines) and the confidence it reported. All are NULL on any other ask, so an ask from before this file reads as a decision.
-- (A purge empties the texts, as it empties the question.) The answer needs no column: Go is the recommended choice, Not this is
-- alternative 1 and keeps the owner's reason in chosen_text.
ALTER TABLE asks ADD COLUMN action TEXT CHECK (action IS NULL OR length(action) <= 100);
ALTER TABLE asks ADD COLUMN risk TEXT CHECK (risk IS NULL OR length(risk) <= 140);
ALTER TABLE asks ADD COLUMN undo TEXT CHECK (undo IS NULL OR length(undo) <= 80);
ALTER TABLE asks ADD COLUMN one_way INTEGER CHECK (one_way IS NULL OR one_way IN (0, 1));
ALTER TABLE asks ADD COLUMN considered TEXT;
ALTER TABLE asks ADD COLUMN confidence INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100);
