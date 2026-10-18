-- Who set a conversation's title: nobody yet (auto), a person (human) or an agent (agent). An agent may rename only
-- a title that is auto or agent-set; a person's title stays until a person changes it. Only a human title keeps an
-- empty conversation from the 24 h clean-up (I-20). title_source stays: it says a message never renames the title.

-- owner: conversation
ALTER TABLE conversations ADD COLUMN title_set_by TEXT NOT NULL DEFAULT 'auto' CHECK (title_set_by IN ('auto','human','agent'));
UPDATE conversations SET title_set_by = 'human' WHERE title_source = 'manual';
