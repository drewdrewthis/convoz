-- The read-all right (0038) is now the triage agent: it also adds and removes agents in any conversation, itself included.
-- Owner said (msg 1217): "Triage agents, yeah, they can read all of it. They can message. They don't have to be in the conversation."
-- owner: identity
ALTER TABLE agents RENAME COLUMN can_read_all TO is_triage;
