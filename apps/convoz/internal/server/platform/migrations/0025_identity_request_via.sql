-- A request that came in on the agents-only listener (over the internet) is marked, so the owner's card can say so.
-- Login requests carry the mark on their machine request's source; this column is for the requests of a logged-in machine.
ALTER TABLE identity_requests ADD COLUMN via_internet INTEGER NOT NULL DEFAULT 0 CHECK (via_internet IN (0, 1));
