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

    @v1 @cli @unimplemented
    Scenario: An agent answers inside the thread
      When "devtool" runs "convoz reply 900 'Yes, it works without the API'"
      Then the owner sees the reply in thread 900 and not in the main list

    @v1 @api @invariant @I-8 @unimplemented
    Scenario Outline: Thread structure rules
      When a client posts a reply to <root>
      Then the server answers 400

      Examples:
        | root                                      |
        | a reply that is already inside thread 900 |
        | a message in conversation 52              |
        | a system line in conversation 41          |

  Rule: Thread replies count as unread only where the owner is involved (DA-3)

    @v1 @browser @I-14 @unimplemented
    Scenario: The unread count caps at 99+
      Given the owner has read conversation 41
      When "devtool" posts 150 messages and the owner posts through the API after every 15 to keep the loop breaker off
      Then the rail shows "99+" for conversation 41
