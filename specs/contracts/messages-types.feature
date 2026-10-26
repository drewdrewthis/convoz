# Contracts for `features/messages-types.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/messages-types.feature.
# Source: design draft 9 §2.3 (permission matrix), §13 (messages route), §13.1 (limits), I-8, I-18, I-23, I-30, I-40, AC-5.

Feature: Messages and their types (contracts)
  Protocol, security and invariant rules behind messages and their types.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: A message has a type, a format and fixed caps

    @v1 @api @I-23 @AC-22
    Scenario: A 16 KB body with a 64 KB app is accepted
      When "devtool" posts a body of 16384 bytes with an app of 65536 bytes
      Then the server answers 201

    @v1 @api
    Scenario Outline: Oversized messages are refused
      When "devtool" posts a message with <problem>
      Then the server answers 400 naming "<field>"

      Examples:
        | problem                  | field       |
        | a body of 16385 bytes    | body        |
        | an app of 65537 bytes    | app         |
        | 11 attachments           | upload_ids  |

    @v1 @api @AC-M1
    Scenario: Every message type has one plain-text form, the same on the server and in the web app
      Given the projection fixtures: one message of each of the 10 variants plus a reply, a broadcast, an edit and an unfurl
      When the server and the web app project each one to its short and long text
      Then both equal the expected strings in the fixtures

    @v1 @api @invariant @AC-M15
    Scenario: System lines hold ids, never text
      Given a conversation titled "ZQX-title" with an agent named "ZQX-name"
      When each of the 9 system line subtypes is caused by its action
      Then each line is written in the same transaction as its action and matches system.v1
      And no stored system line contains either seeded string

    @v1 @browser @AC-M14
    Scenario: The draft-8 message rules still hold
      When the S2 and S6 scenarios for thread rules, unread math, file serving and markdown links run
      Then every one passes unchanged

  Rule: The server decides who wrote a message

    @v1 @api @I-40
    Scenario: An agent cannot post under another name
      When "devtool" posts with an extra body field "author" set to "drew"
      Then the server answers 400 for the unknown field
      And conversation 41 shows no message from "drew"

    @v1 @api
    Scenario: An agent cannot post where it is not a participant
      When "devtool" posts in conversation 52 where it is not a participant
      Then the server answers 403

    @v1 @api @I-25
    Scenario: A machine without the post scope cannot post
      Given machine "laptop-1" has no post scope and runs "docs"
      When "docs" on "laptop-1" posts in a conversation it is in
      Then the server answers 403

  Rule: Edits and deletes follow ownership

    @v1 @api
    Scenario: An agent cannot edit after 24 hours
      Given "devtool" posted a message 25 hours ago
      When it edits the message
      Then the server answers 403

    @v1 @api
    Scenario: Agent edits are limited to 30 per hour
      Given "devtool" made 30 edits in the last hour
      When it makes another edit
      Then the server answers 429

    @v1 @api
    Scenario: An agent cannot delete someone else's message
      Given the owner posted a message in conversation 41
      When "devtool" deletes that message
      Then the server answers 403

    @v1 @api @invariant @I-8
    Scenario: A message never moves to another conversation, thread or author
      Given a message in conversation 41
      When a client sends an edit that sets a new conversation, thread root or author
      Then the server answers 400
      And the message is still in conversation 41 with the same author

    @v1 @api @AC-M13
    Scenario Outline: Some messages cannot be edited
      When a client edits <message> in conversation 41
      Then the server answers 400
      And the message is unchanged

      Examples:
        | message                                 |
        | an ask                                  |
        | an answer to an ask                     |
        | a message sent through an app           |
        | a system line                           |

    @v1 @api @I-49 @AC-M12
    Scenario: A deleted message serves nothing and a purge leaves no copy
      Given "devtool" posted an app message with a file and the body "ZQX-gone", and the owner sent a result through it
      When the owner deletes the app message
      Then GET /api/files for its upload and GET /api/messages/:id/app answer 404
      And after a purge with a passkey, a scan of every table finds the body, app, result and transcript strings 0 times

  Rule: Agents have budgets, checked before any write

    @v1 @api @I-30
    Scenario: An agent over its burst is refused at once
      Given "devtool" is also in conversation 52
      When "devtool" posts 21 messages in 1 second, alternating between conversations 41 and 52
      Then the twenty-first answers 429 with a Retry-After header
      And the two conversations show 20 of them together

    @v1 @api @I-30
    Scenario: A human write is not slowed by agents at their limits
      Given 10 agents post at their burst limit into conversation 41
      When the owner posts "stop for a moment"
      Then the owner's post answers 201 within 100 ms

    @v1 @api @I-30
    Scenario: A machine has a daily message budget across its identities
      Given identities on "box-2" posted 20000 messages today
      When "devtool" on "box-2" posts again
      Then the server answers 429
      And "docs" on "laptop-1" can still post

    @v1 @api
    Scenario: Status updates are rate limited
      When "devtool" sets its status 11 times in 1 second
      Then the eleventh answers 429

  Rule: The server and the web app read the same mentions

    @v1 @api @invariant @I-18
    Scenario: The server and the web app agree on mentions
      Given the shared markdown fixtures and 10000 fuzzed message bodies
      When each body is posted through the API and rendered by the web app
      Then the mentions the server stored equal the mentions the web app highlights for every body

  Rule: Links show a preview to people, the address to agents

    @v1 @api @I-6
    Scenario: An unfurl card is served only to those who can see the message
      Given "devtool" posted "https://github.com/acme/app/pull/415" in conversation 41
      When "docs", who is not in conversation 41, asks GET /api/messages/:id/unfurl
      Then the server answers 403

    @v1 @api
    Scenario Outline: The unfurl worker never fetches a private address
      When a message links to <target>
      Then the unfurl ends "unavailable" and the test listener on that address gets no request

      Examples:
        | target                                     |
        | http://127.0.0.1:7788/                     |
        | http://169.254.169.254/latest/meta-data/   |
        | a host name that resolves to 10.0.0.5      |
        | a public page that redirects to localhost  |
