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

  Rule: An agent in a conversation may rename it; a title the owner chose stays the owner's

    # Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
    # The title is untrusted text, the owner's title is never overwritten (no timer), and the budget is 3 renames an hour.
    @v1 @api
    Scenario: A participant agent with the post scope renames a conversation
      Given conversation 41 with "devtool", titled by its first message
      When "devtool" sends PATCH /api/conversations/41 with the title "Build status"
      Then the server answers 200 and conversation 41 is titled "Build status"
      And conversation 41 has the system line '@devtool renamed this to "Build status"'
      And the change event and the audit line name "devtool" as the actor, not the owner

    @v1 @api
    Scenario: An agent without the post scope cannot rename
      Given conversation 41 with "devtool", titled by its first message, and a session of "devtool" on a machine without the post scope
      When that session sends PATCH /api/conversations/41 with the title "Build status"
      Then the server answers 403 and the title is unchanged

    @v1 @api
    Scenario: An agent outside a conversation cannot rename it or learn whether it exists
      Given conversation 41 with "devtool" only
      When "docs" sends PATCH /api/conversations/41 with the title "Not mine"
      And "docs" sends PATCH /api/conversations/9999 with the title "Not there"
      Then both answers are 403 with the same body, and conversation 41 keeps its title

    @v1 @api
    Scenario: An agent can rename the title and nothing else
      Given conversation 41 with "devtool", titled by its first message
      When "devtool" sends PATCH /api/conversations/41 with only a link_url
      Then the server answers 403 and conversation 41 has no link
      When "devtool" sends PATCH /api/conversations/41 with no title
      Then the server answers 400 on the field "title"

    @v1 @api
    Scenario: A title the owner chose answers 409 title_owner_set to an agent, however old it is
      Given conversation 41 "Ship search filters", named by the owner, with "devtool"
      When "devtool" sends PATCH /api/conversations/41 with the title "Something else"
      Then the server answers 409 with the code "title_owner_set" and the title is unchanged
      When the test clock moves 30 days
      And "devtool" sends PATCH /api/conversations/41 with the title "Something else"
      Then the server answers 409 with the code "title_owner_set" again

    @v1 @api
    Scenario: An agent renames an automatic or an agent-set title, and the owner's rename takes the title over
      Given conversation 41 with "devtool", titled by its first message
      When "devtool" renames it to "First name" and then to "Second name"
      Then both answers are 200 and the title is "Second name"
      When the owner renames it to "Owner name"
      And "devtool" sends PATCH /api/conversations/41 with the title "Third name"
      Then the server answers 409 with the code "title_owner_set" and the title is "Owner name"

    @v1 @api
    Scenario: An agent's title is cleaned and bounded
      Given conversation 41 with "devtool", titled by its first message
      When "devtool" renames it to a title that holds a line break, a bell, a right-to-left override and an isolate
      Then the stored title and the quoted title have all four removed
      When "devtool" sends a title of 121 characters
      Then the server answers 400 on the field "title"
      When "devtool" sends a title that is only control and direction characters
      Then the server answers 400 on the field "title"
      When "devtool" sends a title of 120 characters
      Then the server answers 200
      And conversation 41 has exactly two rename lines, one for each answer of 200

    @v1 @api
    Scenario: An agent may rename a conversation 3 times an hour
      Given conversations 41 and 42 with "devtool", titled by their first messages
      When "devtool" renames conversation 41 to "One", "Two" and "Three"
      And "devtool" sends PATCH /api/conversations/41 with the title "Four"
      Then the server answers 429 with a Retry-After and the title is "Three"
      And "devtool" can still rename conversation 42
      When the test clock moves 61 minutes
      Then "devtool" can rename conversation 41 to "Four"

    @v1 @api @invariant @I-20
    Scenario: An empty conversation an agent renamed is still cleaned up after 24 hours
      Given an empty conversation 41 with "devtool" and an empty conversation 42 the owner renamed
      When "devtool" renames conversation 41 to "Build status"
      And the test clock moves 24 hours and 1 minute and the cleanup runs
      Then conversation 41 is gone and conversation 42 exists

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

    @v1 @api @cli @invariant @I-47
    Scenario: Nothing claims a conversation, and an agent that is not tagged gets nothing
      Given "docs" has a live session and is not in conversation 41
      When the owner posts "Is anyone free to take this?" in conversation 41
      Then "docs" has no inbox item
      And "docs" gets 403 on conversation 41
      And POST /api/conversations/41/pickup and POST /api/conversations/41/claim answer 404
      And "convoz pickup 41" is not a command
      # Owner said: "Nothing claims conversations. I need to tag." Agents join only through the owner's @mention or + Add.

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
