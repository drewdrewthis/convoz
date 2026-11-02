# Contracts for `features/threads.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/threads.feature.
# Source: design draft 9 §8 (I-8, I-14), §8.2 (unread math, involvement rule DA-3), §13 replies route.

Feature: Threads (contracts)
  Protocol, security and invariant rules behind threads.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
    And "devtool" posted message 900 "Step 1 is the filter chips UI" in conversation 41

  Rule: A thread hangs off one top-level message

    @v1 @cli
    Scenario: An agent answers inside the thread
      When "devtool" runs "convoz reply 900 'Yes, it works without the API'"
      Then the owner sees the reply in thread 900 and not in the main list

    @v1 @api @invariant @I-8
    Scenario Outline: Thread structure rules
      When a client posts a reply to <root>
      Then the server answers 400

      Examples:
        | root                                      |
        | a reply that is already inside thread 900 |
        | a message in conversation 52              |
        | a system line in conversation 41          |

  # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
  Rule: A thread root carries its reply count and the reader's new replies

    @v1 @api
    Scenario: The message list carries the reply count and the new replies of the reader
      Given the owner replied in thread 900, then "devtool" and "docs" answered
      And "docs" replied in thread 901, a message of "devtool" the owner is not in
      When the owner reads the messages of conversation 41
      Then message 900 has reply_count 3 and unread_replies 2
      And message 901 has reply_count 1 and no unread_replies
      When the owner reads thread 900
      Then message 900 has reply_count 3 and no unread_replies

  Rule: Thread replies count as unread only where the owner is involved (DA-3)

    @v1 @browser @I-14
    Scenario: The unread count caps at 99+
      Given the owner has read conversation 41
      When "devtool" posts 150 messages and the owner posts through the API after every 15
      Then the rail shows "99+" for conversation 41
