# Contracts for `features/conversations.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/conversations.feature.
# Source: design draft 9 §2.3, §8 (I-7, I-9, I-15, I-16, I-17, I-19, I-20, I-47), §8.2 (unread), §14 (soft delete), AC-6, AC-26.

Feature: Conversations (contracts)
  Protocol, security and invariant rules behind conversations.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool", "docs" and "release-bot"

  Rule: The owner starts and names conversations

    @v1 @browser
    Scenario: The owner renames a conversation
      Given conversation 41 "Plan the search filters launch"
      When the owner renames it to "Ship search filters"
      Then the rail and the header show "Ship search filters"
      And later messages never change the title

    @v1 @api @invariant @I-20
    Scenario: A send that races the cleanup keeps the conversation
      Given an empty conversation that is 24 hours old
      When the owner sends "wait" at the moment the cleanup runs
      Then the conversation exists with the message "wait"

  Rule: The list shows the latest activity first, and who is online and working

    @v1 @api
    Scenario: The conversation list orders by latest activity
      Given conversations 41, 52 and 60 were created in that order with "devtool"
      When "devtool" posts in conversation 41
      Then GET /api/conversations lists 41, 60, 52 in that order

    @v1 @api
    Scenario: An agent with a live session shows online
      Given "docs" has no live session and "devtool" has one
      When the owner calls GET /api/identities
      Then "devtool" is online and "docs" is not

    @v1 @api
    Scenario: An agent shows working while it holds an item and stops when it replies
      Given the owner has the event stream open
      When "devtool" claims the item for conversation 41
      Then the stream sends "agent.working" for "devtool" with working true
      When "devtool" posts in conversation 41
      Then the stream sends "agent.working" for "devtool" with working false

  Rule: Agents join only through a human, and see only from their join

    @v1 @api
    Scenario: An agent creates at most 20 conversations a day
      Given "devtool" created 20 conversations today
      When it creates another
      Then the server answers 429

  Rule: Read position is honest (DA-2, DA-4)

    @v1 @api @I-15
    Scenario: My post marks the conversation read only when I was caught up
      Given the owner read conversation 41 up to message 100
      And "devtool" posted messages 101, 102 and 103
      When the owner posts "on my way" through the API without reading them
      Then GET /api/conversations shows 3 unread for conversation 41

    @v1 @api @I-15
    Scenario: My post marks the conversation read when I was caught up
      Given the owner read conversation 41 up to its newest message
      When the owner posts "on my way"
      Then GET /api/conversations shows 0 unread for conversation 41

    @v1 @api @I-15
    Scenario: An agent post keeps an earlier human message unread for that agent
      Given "devtool" read conversation 41 up to message 100
      And the owner posted message 101
      When "devtool" posts message 102
      Then GET /api/conversations as "devtool" shows 1 unread for conversation 41

    @v1 @api @invariant @I-15
    Scenario: A read position never moves backward
      Given the owner read conversation 41 up to message 120
      When an old tab reports a read position of message 90
      Then the owner's read position is still message 120

    # Removed: "An agent without the pickup scope cannot pick up" (pickup was removed). Owner said: "Nothing claims conversations. I need to tag."

    # Removed: "A stale pickup holder cannot act after a release" (pickup was removed). Owner said: "Nothing claims conversations. I need to tag."
