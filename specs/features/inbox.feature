# Source: design draft 9 §3.8 (inbox, transport), I-19, I-43, AC-6, AC-18, AC-20(e).
# Draft 9 folds in the devil's-advocate review of draft 8:
#   M1 a poll first re-returns the items this session already holds, without counting a delivery
#   M2 an item delivered 5 times is moved out as expired before the claim; the brief reports it
#   M3 a claim returns a claim_token; the ack must carry it; an old token gets 409
#   M4 an expired claim merges into the conversation's ready row (<=1 item per conversation)
#   M8 any call from the claiming session (or a lease renewal) extends its claims
# Cuts: no `inbox --follow` SSE in v1, no parked state, no `ack --parked`, no ask_snoozed item, no inbox_floor_id.
# Added: prefer the session that posted last in that conversation; `convoz inbox --conv <id>`.
# Also C-1 (the removal notice is delivered, then nothing more) and C-10 (one conversation item; the
# highest reason wins: mention > thread > activity). Voice items wait for their transcript (E-5).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Agent inbox
  As an agent session
  I want every event that concerns my identity collected in one inbox I can claim and ack
  So that I never miss a mention or an answer and two sessions never handle the same item

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
    And sessions "s1" and "s2" of "devtool" run on "box-2"

  Rule: Items are written with the event that causes them

    @v1 @cli @I-43 @unimplemented
    Scenario: A mention reaches the inbox at once
      Given session "s1" waits with "convoz inbox --wait 60"
      When the owner posts "@devtool can you check the flaky test?" in conversation 41
      Then "s1" returns 1 item with reason "mention", conversation 41 and the message id within 1 second

    @v1 @cli @I-43 @unimplemented
    Scenario: An agent's own messages create no item for itself
      When session "s1" posts "Starting on it" in conversation 41
      Then "convoz inbox --peek --sid s2" shows no item for that message
      And "convoz inbox --peek" as "docs" shows 1 "activity" item for conversation 41

    @v1 @cli @I-43 @unimplemented
    Scenario Outline: Each kind of event makes an item with its reason
      When <event>
      Then "convoz inbox --peek --sid s1" shows an item with reason "<reason>"

      Examples:
        | event                                                                  | reason       |
        | the owner posts "@devtool look" in conversation 41                     | mention      |
        | the owner posts "next step?" in conversation 41                        | activity     |
        | the owner replies in a thread that "devtool" started in conversation 41 | thread       |
        | the owner answers an ask of "devtool"                                  | ask_resolved |
        | the owner dismisses an ask of "devtool"                                | ask_resolved |
        | the owner adds "devtool" to conversation 52                            | membership   |
        | the owner declines an add that "devtool" requested in conversation 52  | membership   |
        | the owner sends a result through an app of "devtool"                    | app_result   |

    @v1 @cli @I-43 @unimplemented
    Scenario: Snoozing an ask makes no inbox item
      Given "devtool" has an open ask in conversation 41
      When the owner snoozes it for 1 hour
      Then "convoz inbox --peek --sid s1" shows no new item

    @v1 @cli @I-43 @AC-M11 @unimplemented
    Scenario: A voice message reaches the agent as words
      Given the transcription engine takes 30 seconds
      When the owner sends a voice note that says "ship the filters on Thursday" in conversation 41
      Then "convoz inbox --wait 60 --sid s1" returns the item only after the transcript is done
      And the item text is "ship the filters on Thursday"

  Rule: Mentions, thread replies and activity make one item per conversation (M4, C-10)

    @v1 @cli @I-43 @M4 @AC-18 @unimplemented
    Scenario: Thirty messages make one activity item
      When the owner posts 30 messages in conversation 41
      Then "convoz inbox --peek --sid s1" shows 1 "activity" item for conversation 41 with count 30
      And the item points at the newest of the 30 messages

    @v1 @cli @I-43 @C-10 @unimplemented
    Scenario: Thread replies join the conversation item
      Given "devtool" started thread 900 in conversation 41
      When the owner posts 5 replies in thread 900 and 2 messages in the main list
      Then "convoz inbox --peek --sid s1" shows 1 item for conversation 41 with reason "thread" and count 7

    @v1 @cli @I-43 @C-10 @AC-18 @unimplemented
    Scenario: A mention raises the conversation item to a mention
      Given the owner posted 3 messages in conversation 41
      When the owner posts "@devtool can you take this?" in conversation 41
      Then "convoz inbox --peek --sid s1" shows 1 item for conversation 41 with reason "mention" and count 4
      And the item says 1 of the 4 messages mentions "devtool"

    @v1 @cli @I-43 @C-10 @unimplemented
    Scenario: Answers, membership changes and app results stay separate items
      Given the owner posted 2 messages in conversation 41
      When the owner answers an ask of "devtool" there and sends a result through an app of "devtool" there
      Then "convoz inbox --peek --sid s1" shows 3 items for conversation 41: the conversation item, one "ask_resolved" and one "app_result"

    @v1 @cli @I-43 @unimplemented
    Scenario: One message makes one item and the strongest reason wins
      Given "devtool" asked a question in conversation 41
      When the owner answers it with the custom text "@devtool merge it after lunch"
      Then "devtool" gets one "ask_resolved" item for that answer and no mention item for it

  Rule: A claim belongs to one session, and only that session acks it (M1, M3, M8)

    @v1 @cli @I-43 @AC-18 @unimplemented
    Scenario: A new mention goes to exactly one of two waiting sessions
      Given sessions "s1" and "s2" both wait with "convoz inbox --wait 60"
      When the owner posts "@devtool status?" in conversation 41
      Then exactly one of "s1" and "s2" returns the mention item
      And the other is still waiting

    @v1 @cli @M3 @AC-18 @unimplemented
    Scenario: An ack with an old claim token is refused
      Given session "s1" claimed a mention item with a 2-second visibility
      And the item returned to session "s2" after the claim expired
      When session "s1" acks the item with its old claim token
      Then the CLI exits 4 with the code "claim_lost"
      And the item is still held by "s2"

    @v1 @cli @I-43 @AC-18 @unimplemented
    Scenario: An unacked item comes back to another session
      Given session "s1" claimed a mention item with a 2-second visibility
      When "s1" does not ack and "s2" waits with "convoz inbox --wait 10"
      Then "s2" returns the same item within 3 seconds

    @v1 @cli @lossy @M1 @AC-27 @unimplemented
    Scenario: A lost long-poll response loses nothing
      Given a fault proxy drops the response that delivers a mention to session "s1"
      When "s1" polls again
      Then "s1" gets the same item with the same claim token
      And "convoz inbox --peek" shows its delivery count unchanged

    @v1 @cli @M8 @unimplemented
    Scenario: Any call from the claiming session extends its claims
      Given session "s1" claimed 2 items with a 1-minute visibility
      When "s1" posts a message after 50 seconds
      And "s2" polls 30 seconds later
      Then "s2" gets neither of the 2 items

    @v1 @cli @I-12 @I-43 @unimplemented
    Scenario: Acking an answer item marks the ask as acked
      Given the owner answered the ask of "devtool" in conversation 41
      When session "s1" claims and acks the "ask_resolved" item
      Then the owner sees "Seen by @devtool" on the answered ask

  Rule: One bad item never blocks the batch (M2)

    @v1 @cli @M2 @AC-18 @unimplemented
    Scenario: An item delivered 5 times is expired before the next claim
      Given a mention item that was delivered 5 times and never acked
      And 3 other ready items
      When session "s1" runs "convoz claim 10"
      Then it gets the 3 other items and not the expired one
      And "convoz brief" reports "1 item expired unread" with conversation 41

  Rule: Several sessions of one identity share the work sensibly

    @v1 @cli @AC-28 @unimplemented
    Scenario: An item goes to the session that posted last in that conversation
      Given session "s2" posted in conversation 41 after session "s1"
      And both sessions wait with "convoz inbox --wait 60"
      When the owner posts "@devtool and the follow-up?" in conversation 41
      Then "s2" returns the mention item

    @v1 @cli @AC-28 @unimplemented
    Scenario: A session can wait on one conversation only
      Given ready items for conversations 41 and 52
      When session "s1" runs "convoz inbox --conv 41 --wait 5"
      Then it gets only the items of conversation 41
      And the item of conversation 52 is still ready for "s2"

  Rule: Items expire on schedule and never outlive what the agent may see

    @v1 @cli @I-43 @unimplemented
    Scenario: Old items are cleaned up on schedule
      Given an acked item 7 days and 1 hour old and an unacked item 30 days and 1 hour old
      When the nightly maintenance runs
      Then the acked item is gone from "convoz inbox --peek"
      And "convoz brief" lists the unacked one as expired unread
      And "convoz read 41" still shows the message the expired item pointed at

    @v1 @cli @I-19 @AC-6 @C-1 @unimplemented
    Scenario: Removal leaves one notice and then nothing more
      Given "devtool" has 2 ready items for conversation 41
      When the owner removes "devtool" from conversation 41
      Then "convoz inbox --wait 5 --sid s1" returns one "membership" item saying "devtool" was removed from conversation 41
      And no other item for conversation 41 arrives, even when the owner posts there again
      And items for "devtool" in conversation 52 still arrive

    @v1 @cli @I-6 @unimplemented
    Scenario: Delivery checks visibility again
      Given "devtool" has a ready mention item for conversation 41
      When the owner soft-deletes conversation 41
      Then "convoz inbox --wait 2 --sid s1" returns no item for conversation 41

  Rule: Long poll is the transport (no WebSockets, no SSE follow in v1)

    @v1 @cli @lossy @AC-20 @unimplemented
    Scenario: The long poll survives forced connection resets
      Given the link is the lossy profile through the stall proxy
      When session "s1" runs "convoz inbox --wait 60" and the proxy resets the connection 3 times
      Then each of 5 mentions posted during the run is returned to "s1" exactly once
