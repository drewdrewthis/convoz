# Contracts for `features/platform.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/platform.feature.
# Source: design draft 9 §5 (commands → events, thin events, sync), §7 (schema), I-4, I-5, I-9, I-23, I-24, I-34, I-48, AC-22.

Feature: Platform rules every module relies on (contracts)
  Protocol, security and invariant rules behind platform rules every module relies on.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: A change is one transaction with its event

    @v1 @api @invariant @I-4
    Scenario: A failed write leaves no event behind
      Given the owner's event cursor is at the newest event
      When the owner posts a message that the server refuses with 400
      Then GET /api/sync from that cursor returns no new event
      And conversation 41 shows no new message

    @v1 @api @invariant @I-4 @unimplemented
    Scenario: A write and its event, inbox item, search entry and audit row appear together
      When the owner posts "@devtool rotate the deploy key" in conversation 41
      Then in the same response sequence the event stream has the message event
      And "devtool" has a mention item
      And search finds "rotate" in conversation 41
      And the audit view lists the post with no lag

    @v1 @api @invariant @I-5 @I-48 @unimplemented
    Scenario Outline: Cross-record rules hold when a client tries to break them
      When a client tries <attempt>
      Then the server answers 400 or 409
      And nothing changes in the conversation

      Examples:
        | attempt                                                         |
        | to reply in conversation 41 to a root that lives in conversation 52 |
        | to answer an ask of conversation 41 with a message in conversation 52 |
        | to attach an app message of conversation 52 to a via_app message in 41 |
        | to start a lease as an identity the machine's allow-list lacks  |

    @v1 @api @invariant @I-9 @unimplemented
    Scenario: Counters match the messages after any sequence of actions
      Given a random sequence of 1000 posts, replies, deletes, asks, answers and removals across 5 conversations
      When the rail and each conversation are loaded
      Then every message count, reply count and open-ask count equals a count of the visible items

  Rule: Events are thin, immutable and replayable

    @v1 @api @I-23 @AC-22 @unimplemented
    Scenario: Events never carry content
      Given seeded strings "body-ZQX1", "title-ZQX2", "question-ZQX3", "option-ZQX4" and "file-ZQX5.png"
      When the owner and "devtool" create a conversation, a 16 KB message, an ask and an upload that use them
      Then no event payload in GET /api/sync is longer than 1 KB
      And no event payload contains any seeded string
      And the hydrated frames on the event stream do show the content

    @v1 @api @invariant @I-23 @AC-22
    Scenario: Stored events cannot be changed
      Given the server runs as the encryption-off test build
      When the test tries to update a stored event row in the data file
      Then the update is refused
      And GET /api/sync returns the original event

    @later @api @I-23
    Scenario: The returned cursor moves past events the caller cannot see
      Given member "mia" is in conversation 41 but not in conversation 52
      And the newest 30 events are in conversation 52
      When "mia" syncs from her last cursor
      Then she gets no event from conversation 52
      And the returned cursor is the highest sequence scanned, past those 30 events

    @v1 @api @I-23
    Scenario: A cursor from another epoch gets a reset
      Given a client holds a cursor from an earlier epoch
      When it syncs with that cursor
      Then the server answers with a "reset" and the client loads a fresh snapshot

    @v1 @browser @I-23
    Scenario: A slow client gets a reset and resyncs
      Given a browser that stops reading the event stream
      When more than 256 frames queue for it
      Then the server sends "reset" with reason "slow" and closes the stream
      And the browser resyncs and shows every message

  Rule: Every command can be retried safely

    @v1 @api @I-24
    Scenario: The same client id returns the first result
      Given the owner posted "ship it" with client id "c-0001-aaaa"
      When the owner posts "ship it" again with client id "c-0001-aaaa"
      Then the server returns the first message's id
      And conversation 41 shows "ship it" once

    @v1 @api @I-24
    Scenario: The same client id with a different body is a conflict
      Given the owner posted "ship it" with client id "c-0002-aaaa"
      When the owner posts "hold it" with client id "c-0002-aaaa"
      Then the server answers 409

  Rule: Upgrades are forward only and safe

    @v1 @cli
    Scenario: The events table is rebuilt in its final shape and keeps every row
      Given a data dir at the previous release's schema with events from sign-up and Crew
      When this build starts and migrates it
      Then every old event keeps its id, payload and time, and its type ends in ".v1"
      And the events table has the final columns, an autoincrement id and no update path

    @v1 @cli
    Scenario: The server is serving within 500 ms of start
      Given a data dir with the 1M-message fixture
      When "convoz serve" starts
      Then GET /healthz answers "ok" within 500 ms

  Rule: The storage engine is fast enough

    @v1 @cli @bench
    Scenario: The storage engine meets the search budget on 1M rows
      Given an encrypted data dir with a synthetic 1M-row full-text table
      When the storage benchmark runs
      Then inserts have p95 at most 10 ms and searches p95 at most 50 ms
