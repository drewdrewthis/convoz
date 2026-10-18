-- Every member sees the whole history of a conversation, however they came in.
-- Owner (Drew, msg 143), asked whether people and agents added to a conversation should see what came before:
-- "History should be accessible yes". So the message floor goes; members added under the old rule get full history too.
-- joined_seq (the event floor, I-7) stays: old events are not replayed to a new member.
UPDATE participants SET joined_message_id = 0 WHERE joined_message_id <> 0;
