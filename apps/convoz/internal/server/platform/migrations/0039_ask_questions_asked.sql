-- "Questions asked" flow (Owner said, msg 1117 and msg 1131: "update this ask so it has all of my QA answered ... that's the way to do it."). The
-- owner's reply in an ask's thread no longer closes the ask (0036 did): the ask stays open and remembers the reply. The agent answers in the
-- thread and updates the same ask in place (`convoz ask --update`): its question, options and reason may change, it carries a short summary of the
-- answers, and the reply mark clears. asks is referenced by messages, ask_options, ask_snoozes and ask_transitions, so the history CHECK is widened
-- the way 0036 did (the stored table text, then RESET), not by a rebuild that would cascade.
-- owner: ask
PRAGMA writable_schema = ON;
UPDATE sqlite_schema SET sql = replace(sql, '''withdraw'',''close'')', '''withdraw'',''close'',''owner_replied'',''updated'')') WHERE type = 'table' AND name = 'ask_transitions';
PRAGMA writable_schema = RESET;
-- Fail the migration (malformed JSON raises) if the replace above matched nothing, instead of leaving a CHECK that rejects the new events.
SELECT CASE WHEN (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'ask_transitions') LIKE '%''owner_replied'',''updated''%'
            THEN 1 ELSE json('0039: ask_transitions CHECK not widened') END;

-- The latest reply of the owner in the thread (time and message id, no foreign key: a purge of the message never trips on it), the summary of
-- the answers an update carries, and what the latest update changed ("question, options").
ALTER TABLE asks ADD COLUMN owner_replied_at INTEGER;
ALTER TABLE asks ADD COLUMN owner_reply_id INTEGER;
ALTER TABLE asks ADD COLUMN answers TEXT CHECK (answers IS NULL OR length(answers) <= 1000);
ALTER TABLE asks ADD COLUMN changed TEXT CHECK (changed IS NULL OR length(changed) <= 100);

-- The question is fixed for the life of an ask except in an update by its agent, which moves the version in the same statement.
DROP TRIGGER asks_content_immutable;
CREATE TRIGGER asks_content_immutable BEFORE UPDATE OF question, asker_id, urgent, conversation_id ON asks
  WHEN NEW.asker_id IS NOT OLD.asker_id OR NEW.urgent IS NOT OLD.urgent OR NEW.conversation_id IS NOT OLD.conversation_id
    OR (NEW.question IS NOT OLD.question AND NEW.scrubbed_at IS NULL AND NEW.version = OLD.version)
  BEGIN SELECT RAISE(ABORT,'ask content is immutable'); END;                 -- I-10

-- The options of an ask are final once it is no longer open; while it is open an update by its agent replaces them as a whole (the module checks
-- that the new set is 2 to 5 options with no gap, as the seal trigger does at creation).
DROP TRIGGER ask_options_no_insert_after_seal;
CREATE TRIGGER ask_options_no_insert_after_seal BEFORE INSERT ON ask_options
  WHEN (SELECT sealed FROM asks WHERE message_id = NEW.message_id) = 1 AND (SELECT state FROM asks WHERE message_id = NEW.message_id) <> 'open'
  BEGIN SELECT RAISE(ABORT,'ask options are sealed'); END;
DROP TRIGGER ask_options_delete_only_scrub;
CREATE TRIGGER ask_options_delete_only_scrub BEFORE DELETE ON ask_options     -- cascade from a deleted ask passes (parent gone)
  WHEN EXISTS (SELECT 1 FROM asks WHERE message_id = OLD.message_id AND scrubbed_at IS NULL AND state <> 'open')
  BEGIN SELECT RAISE(ABORT,'ask options are immutable'); END;
