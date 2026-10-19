-- A watch must print every claim of its session, also one whose answer was lost and one that another loop of the same session made
-- (prod, 2026-10-19: owner messages hidden for 7 to 13 minutes behind such claims, until the watch restarted). Each claim takes the
-- next claim number of its identity; a watch asks for the held claims after the number of the last answer it got.
-- The counter has a row of its own, so a number is never handed out twice, even after the item that carried it is gone.
ALTER TABLE inbox_items ADD COLUMN claim_seq INTEGER;

-- owner: inbox
CREATE TABLE inbox_claim_seqs (
  identity_id INTEGER PRIMARY KEY REFERENCES agents(identity_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1)
) STRICT;
