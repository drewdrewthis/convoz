# Contracts for `features/inbox.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/inbox.feature.
# Source: design draft 9 §3.8 (inbox, transport), I-19, I-43, AC-6, AC-18, AC-20(e).

Feature: Agent inbox (contracts)
  Protocol, security and invariant rules behind agent inbox.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
    And sessions "s1" and "s2" of "devtool" run on "box-2"

  Rule: Mentions, thread replies and activity make one item per conversation (M4, C-10)

    @v1 @cli @invariant @I-43 @M4
    Scenario: An expired claim merges into the ready item of its conversation
      Given session "s1" claimed the activity item of conversation 41 with a 2-second visibility
      And the owner posts 4 more messages in conversation 41
      When the claim expires without an ack
      Then "convoz inbox --peek --sid s2" shows exactly 1 activity item for conversation 41
      And its count covers the claimed messages and the 4 new ones

    @v1 @api @invariant @I-43 @M4 @AC-18
    Scenario: Two expired claims of one conversation merge into one ready item
      Given session "s1" claimed the conversation item of 41, a new message arrived, and "s1" claimed that item too
      And the owner posted one more message in conversation 41
      When both claims expire without an ack and "s2" polls
      Then GET /api/inbox?peek=1 shows exactly 1 ready item for conversation 41 whose count covers all 3 messages
      And no request failed on the one-ready-item rule

    @v1 @api @I-43 @AC-M11 @unimplemented
    Scenario: A voice item waits at most 120 seconds for its transcript
      Given the transcription engine fails
      When the owner sends a voice note in conversation 41
      Then no session can claim its item before 120 seconds pass on the test clock
      And after 120 seconds the item is delivered with transcript_state "failed"

  Rule: A claim belongs to one session, and only that session acks it (M1, M3, M8)

    @v1 @api @invariant @I-43
    Scenario: Twenty sessions racing never get the same item
      Given 20 sessions of "devtool" and 50 ready items
      When all 20 sessions claim at the same time
      Then every item is returned to at most one session
      And a second claim round returns no item that was already returned

    @v1 @cli @M3
    Scenario: A claim returns a claim token that the ack must carry
      When session "s1" runs "convoz claim 1 --json"
      Then the output holds an item id and a claim token
      And "convoz ack" with that item and token answers ok
      And an ack of that item without a token answers 400

    @v1 @api @invariant @I-43 @M8 @AC-28
    Scenario: While one session holds a conversation, no other session gets its new items
      Given session "s1" holds a live claim on the item of conversation 41
      When the owner posts again in conversation 41 and "s2" polls
      Then "s2" gets no item for conversation 41
      And "s1" gets the new item on its next poll

    @v1 @api @I-43 @M3
    Scenario: An ack after the claim expired is refused even with the right token
      Given session "s1" claimed a mention item with a 30-second visibility and made no other call
      When the test clock moves 31 seconds and "s1" acks with its token
      Then the server answers 409 with the code "claim_lost"
      And the item is ready again

    @v1 @api @I-43 @AC-28
    Scenario: The preferred session has 30 seconds before others may take an item
      Given session "s2" posted last in conversation 41 and is live but not polling
      When the owner posts "@devtool ping" in conversation 41 and "s1" polls at once and again 31 seconds later
      Then the first poll of "s1" returns no item and the second returns the mention

    @v1 @api @I-43 @I-38
    Scenario: Ending a session releases its claims without breaking the one-item rule
      Given session "s1" holds the conversation item of 41 and a newer item of 41 is ready
      When "s1" ends with "convoz session end"
      Then GET /api/inbox?peek=1 as "s2" shows exactly 1 ready item for conversation 41 covering both

  Rule: Long poll is the transport (no WebSockets, no SSE follow in v1)

    @v1 @cli
    Scenario: The CLI keeps waiting across short server holds
      Given no item is ready
      When session "s1" runs "convoz inbox --wait 60" and a mention arrives after 40 seconds
      Then the proxy log shows server holds of at most 25 seconds each
      And the CLI returns the mention after about 40 seconds

    @later @cli
    Scenario: A daemon follows the inbox over SSE
      When a daemon runs "convoz inbox --follow"
      Then items arrive as SSE frames with the item id as the event id
      And a reconnect with Last-Event-ID resumes after the last item
