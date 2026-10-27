-- A conversation made from a thread keeps a link to the message the thread hangs off (owner, msgs 1591 and 2356, issue 32). One row per
-- such conversation; message_id is unique so turning the same thread twice gives the same conversation. The message is not a foreign
-- key: a purged root must not take the conversation with it, and the page then shows the link as gone.
-- owner: conversation
CREATE TABLE conversation_origins (
  conversation_id        INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  source_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id             INTEGER NOT NULL UNIQUE,
  created_at             INTEGER NOT NULL
) STRICT;

-- Turning a thread into a conversation moves its replies (owner, Go on ask 9259): a reply keeps its id and author and becomes a
-- top-level message of the new conversation. That changes conversation_id and thread_root_id, which messages_structure_immutable
-- forbids, so the move lists the ids it is moving in thread_moves for the length of its transaction and the trigger lets those pass.
-- owner: message
CREATE TABLE thread_moves (message_id INTEGER PRIMARY KEY) STRICT;
DROP TRIGGER messages_structure_immutable;
CREATE TRIGGER messages_structure_immutable BEFORE UPDATE OF conversation_id, thread_root_id, author_id, kind, via_app_agent_id, via_app_message_id, answers_ask_id ON messages
  WHEN ((NEW.conversation_id IS NOT OLD.conversation_id OR NEW.thread_root_id IS NOT OLD.thread_root_id)
        AND NOT EXISTS (SELECT 1 FROM thread_moves m WHERE m.message_id = OLD.id))
    OR NEW.author_id IS NOT OLD.author_id OR NEW.kind IS NOT OLD.kind
    OR NEW.via_app_agent_id IS NOT OLD.via_app_agent_id OR NEW.via_app_message_id IS NOT OLD.via_app_message_id
    OR NEW.answers_ask_id IS NOT OLD.answers_ask_id
  BEGIN SELECT RAISE(ABORT,'message structure is immutable'); END;
