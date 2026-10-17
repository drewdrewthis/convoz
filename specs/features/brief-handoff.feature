# Source: design draft 9 §3.8 (recontextualize), I-6, I-7, I-24, AC-19.
# Draft 9 folds in: M7 (fixed budget per section, handoff and asks first; conversations show the top 10
# plus "and K more" and page; the brief has no side effects and lists conversations unread for the
# identity, so cut conversations come back until the agent reads them; default 12 KB; handoffs ≤4096 bytes),
# M2 (the brief reports expired items). Cut: no parked section, no seen marker.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Brief, handoff, read and search for agents
  As an agent session
  I want one short brief of who I am and what changed, plus notes from my earlier sessions
  So that a fresh Claude session can pick up the work without the owner explaining it again

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And the brief fixture: "devtool" has unread inbox items, an unacked answer, an open ask, 3 conversations with unread messages, a decision from 2 days ago and 2 handoff notes
    And the fixture has a conversation "Secret merger plan" that "devtool" is not in

  Rule: The brief tells a new session everything it may see, in a fixed budget (M7)

    @v1 @cli @I-6 @AC-19 @M7
    Scenario: A fresh session gets the whole brief within 12 KB
      When a new session runs "convoz brief --as devtool"
      Then the output is at most 12288 bytes
      And it shows the identity, this session and machine "box-2"
      And it shows the last handoff note, the unacked answer, the open ask, unread inbox counts by reason, the 3 conversations with unread messages and the recent decision
      And the text "Secret merger plan" appears 0 times

    @v1 @cli @M7
    Scenario: The handoff and the asks come first and keep their budget
      Given "devtool" has 60 conversations with unread messages
      When a new session runs "convoz brief --as devtool"
      Then the last handoff note and every unacked answer and open ask are in the output
      And they come before the conversation section

    @v1 @cli @M7 @AC-19
    Scenario: Long sections show the top items and a count of the rest
      Given "devtool" has 60 conversations with unread messages
      When a new session runs "convoz brief --as devtool"
      Then the conversation section lists the top 10 and ends with "and 50 more"

    @v1 @cli @M7 @AC-19
    Scenario: Conversations cut from a brief stay listed until the agent reads them
      Given "devtool" has 60 conversations with unread messages
      And session "s1" ran "convoz brief" and saw the top 10
      When session "s2" runs "convoz brief --page 2"
      Then the conversation section lists the next 10
      And a new "convoz brief" still lists the first 10
      And after "convoz read" of one of them, the next brief no longer lists it

    @v1 @cli @AC-19
    Scenario: Overlapping sessions get the same brief
      Given session "s1" of "devtool" is still live
      When session "s2" starts and both run "convoz brief"
      Then both briefs list the same conversations with unread messages

    @v1 @cli @M7
    Scenario: A brief changes nothing
      When a session runs "convoz brief" twice
      Then both outputs are the same
      And "convoz inbox --peek" shows every item still ready

    @v1 @cli @M2
    Scenario: The brief reports items that expired unread
      Given 2 items of "devtool" for conversation 41 expired unread on 2026-10-01
      When a new session runs "convoz brief"
      Then the brief says "2 items expired unread since 2026-10-01" and names conversation 41

    @v1 @cli
    Scenario: A larger brief is capped at 64 KB
      When a session runs "convoz brief --max-bytes 200000"
      Then the output is at most 65536 bytes

    @v1 @mcp @AC-19
    Scenario: The MCP brief tool returns the same brief
      When the MCP tool "brief" is called in "convoz mcp --as devtool"
      Then the result has the same sections as "convoz brief"

  Rule: A handoff note carries context to the next session

    @v1 @cli
    Scenario: A handoff note is stored with the session and machine
      When session "s1" runs "convoz handoff 'Halfway through #412; tests 3 and 7 still flaky'"
      Then the next "convoz brief" of "devtool" shows that note as the last handoff
      And the owner sees the note in Crew → devtool → Handoffs with the session label and "box-2"

    @v1 @cli @M7
    Scenario: A handoff note over 4 KB is refused
      When a session stores a handoff note of 4097 bytes
      Then the CLI exits 2 with a message naming the 4096-byte cap

    @v1 @cli @M7
    Scenario: The last handoff note always fits the brief whole
      Given the last handoff note of "devtool" is 4096 bytes of text in three languages
      And "devtool" has 60 conversations with unread messages
      When a new session runs "convoz brief"
      Then the note appears whole in the output

    @v1 @cli
    Scenario: The 50 newest handoff notes are kept
      Given "devtool" stored 50 handoff notes
      When it stores one more
      Then "convoz handoff --list" shows 50 notes and the oldest is gone

    @v1 @cli @I-24
    Scenario: A retried handoff makes one note
      Given a fault proxy drops the response of the first "convoz handoff" request
      When the CLI retries with the same client id
      Then "convoz handoff --list" shows the note once

  Rule: An agent reads and searches only what it can see

    @v1 @cli @I-7
    Scenario: An agent added later does not read earlier messages
      Given conversation 41 had 20 messages before the owner added "devtool" with history "since now"
      When "devtool" runs "convoz read 41"
      Then it sees only the messages from its add onward

    @v1 @cli @I-6
    Scenario: Agent search returns only conversations it can see, newest first
      Given "Secret merger plan" and conversation 41 both contain the word "merger"
      When "devtool" runs "convoz search merger"
      Then every result is from conversation 41
      And results are ordered newest first
