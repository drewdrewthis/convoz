# Contracts for `features/notifications.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/notifications.feature.
# Source: design draft 9 §10 (with draft 7 §10.1 triggers and §10.2 decision pipeline), I-28, I-35, AC-7.

Feature: Notifications (contracts)
  Protocol, security and invariant rules behind notifications.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the owner's browser has a push subscription to the fake push service
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Each trigger sends one push

    @v1 @api @invariant @I-28
    Scenario: A replayed event never pushes twice
      Given "devtool" asked a question and the owner got one push
      When the server restarts while the push worker is mid-batch
      Then the fake push service has still received one push for that ask

  Rule: The decision pipeline suppresses pushes for a reason (AC-7)

    @v1 @api
    Scenario: Bursts in one conversation coalesce
      When "devtool" posts 3 mentions of "@drew" in conversation 41 within 60 seconds
      Then the fake push service ends with one visible push for that topic reading "3 new"

    @v1 @api
    Scenario: A machine request pushes even in quiet hours
      Given it is inside the owner's quiet hours
      When "convoz login --name box-9" starts
      Then the fake push service receives "box-9 wants to connect" with the body "code KQWD-MZTP"

  Rule: Delivery is private and well-behaved (I-28)

    @v1 @api @I-28 @AC-7
    Scenario Outline: Only allow-listed push hosts are accepted
      When the owner subscribes with the endpoint "<endpoint>"
      Then the server answers <status>

      Examples:
        | endpoint                                       | status |
        | https://fcm.googleapis.com/fcm/send/abc        | 201    |
        | https://fcm.googleapis.com.evil.tld/send/abc   | 400    |
        | https://x@fcm.googleapis.com/fcm/send/abc      | 400    |
        | http://fcm.googleapis.com/fcm/send/abc         | 400    |

    @v1 @api @I-28
    Scenario: The push service sees no ids and no exact sizes
      When "devtool" asks 3 questions
      Then every Topic header the fake service received is 22 characters and holds no ask id
      And every payload size is a multiple of 512 bytes

  Rule: Answering from the notification is later and off by default (I-35)

    @later @api @I-35
    Scenario: An action button label comes from the server's record
      Given the owner turned on answering from notifications
      When "devtool" asks with the recommendation "Merge it"
      Then the push action label is "✓ Merge it" read from the stored ask, not from the agent's request

    @later @api @I-35
    Scenario Outline: An action token works once, on its device, for that ask version
      Given an action token for the owner's phone and ask version 1
      When it is used <how>
      Then the server <result> the action

      Examples:
        | how                               | result  |
        | once from the phone               | accepts |
        | a second time from the phone      | refuses |
        | from the owner's laptop           | refuses |
        | after the ask moved to version 2  | refuses |
        | after the phone was revoked       | refuses |
