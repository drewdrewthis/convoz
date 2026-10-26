# Contracts for `features/now.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/now.feature.
# Source: design draft 9 §4.2 (`now`: asks, pending adds, machine requests), §8.1, §9 (badge, deep links),

Feature: Now (contracts)
  Protocol, security and invariant rules behind now.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: Agent adds wait for a human (pending adds)

    @v1 @api @I-17
    Scenario: A human cannot be the target of a pending add
      When "devtool" requests to add the owner to conversation 52
      Then the server answers 400

  # Owner, conv 179 msg 6018 (UX review): the server counts mentions, the client does not scan
  Rule: The server counts what Now sorts by

    @v1 @api
    Scenario: The conversation list counts the unread messages that @mention the caller
      Given the owner wrote "Status?" in conversation 41
      And "devtool" posted "@drew look" and then "Build 812 is green" in conversation 41
      Then the conversation list row of conversation 41 has unread_mentions 1
      When the owner marks conversation 41 read
      Then the conversation list row of conversation 41 has unread_mentions 0
      When "docs" replies "@drew see the log" in the thread of "Status?"
      Then the conversation list row of conversation 41 has unread_mentions 1

    @v1 @api
    Scenario: The conversation list says when agents replied to the owner
      Given the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered "The lint step"
      And in conversation 42 only "devtool" and "docs" posted
      Then the conversation list row of conversation 41 has replies_to_you true
      And the conversation list row of conversation 42 has no replies_to_you

    @v1 @api
    Scenario: Now counts conversations with an unread mention in its badge
      Given "devtool" has an open ask in conversation 41
      And "docs" posted "@drew look" in conversation 42
      And "docs" posted "@drew muted look" in conversation 43, which the owner muted
      When the owner reads GET /api/now
      Then mentions is 1 and badge is 2
