-- An ask says why only the owner can decide it (Drew, conv 1 msg 252): "an ask must say why it is your call (one-way door, taste,
-- or values), or the CLI refuses it and tells the agent to decide. The card shows that line." Scope is a fourth kind.
-- Both columns are NULL on an ask from before this file; the server refuses a new ask without them.
ALTER TABLE asks ADD COLUMN owners_call_kind TEXT CHECK (owners_call_kind IN ('one-way','taste','values','scope'));
ALTER TABLE asks ADD COLUMN owners_call_reason TEXT CHECK (owners_call_reason IS NULL OR length(owners_call_reason) <= 280);
