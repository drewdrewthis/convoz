-- An agent the owner trusts can read every conversation and thread without being added, and post in them as itself. It is never
-- an inbox, mention or presence recipient of a conversation it is not in, and it cannot change the conversation or answer an ask.
-- Owner said (msg 784): "I think I also want an option to tag or give an agent privileges to be able to monitor and review all
-- conversations and threads without being added. Not the inbox, but, yeah." Owner said (msg 1123): "Yes, all conversations".
-- owner: identity
ALTER TABLE agents ADD COLUMN can_read_all INTEGER NOT NULL DEFAULT 0 CHECK (can_read_all IN (0,1));
