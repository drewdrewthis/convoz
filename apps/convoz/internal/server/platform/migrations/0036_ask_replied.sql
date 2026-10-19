-- An ask closes with the reason "replied" when the owner replies in its thread instead of choosing (Drew, conv 1 msg 1006:
-- "Replying to a feed item should dismiss it and the agent should have to ask it again"). asks is referenced by messages, ask_options,
-- ask_snoozes and ask_transitions, so it cannot be rebuilt in a transaction with foreign keys on (the drop would cascade). SQLite's
-- documented way to widen a CHECK without touching the rows is to edit the stored table text; RESET then reloads the schema, so
-- this connection parses the new text.
-- owner: ask
PRAGMA writable_schema = ON;
UPDATE sqlite_schema SET sql = replace(sql, '''deleted'',''agent_revoked'')', '''deleted'',''agent_revoked'',''replied'')') WHERE type = 'table' AND name = 'asks';
PRAGMA writable_schema = RESET;
-- Fail the migration (malformed JSON raises) if the replace above matched nothing, instead of leaving a CHECK that rejects 'replied'.
SELECT CASE WHEN (SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'asks') LIKE '%''replied''%' THEN 1 ELSE json('0036: asks CHECK not widened') END;
