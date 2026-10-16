# Source: design draft 9 §10 (with draft 7 §10.1 triggers and §10.2 decision pipeline), I-28, I-35, AC-7.
# The push service is a fake Web Push endpoint on an allow-listed test host that records what it receives.
# Real-device checks (iOS Home Screen push, Android badge) are @needs-owner.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Notifications
  As the owner
  I want a push for what needs me, and silence for what does not
  So that my phone is useful and not noisy

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the owner's browser has a push subscription to the fake push service
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Each trigger sends one push

    @v1 @api @I-28 @C-2 @AC-7
    Scenario Outline: Triggers that push the owner
      When <event>
      Then the fake push service receives one push with the reason "<reason>"

      Examples:
        | event                                                          | reason          |
        | "devtool" asks a question in conversation 41                   | ask             |
        | "devtool" asks an urgent question in conversation 41           | ask_urgent      |
        | "devtool" posts "@drew please look" in conversation 41         | mention         |
        | "devtool" replies in a thread the owner replied in             | thread_reply    |
        | "devtool" requests to add "@docs" to conversation 41           | agent_add       |
        | a snoozed ask reaches its wake time                            | snooze_wake     |
        | conversation 41 pauses after 20 agent messages                 | paused          |
        | "convoz login --name box-9" starts                             | machine_request |
        | the owner reveals the key of "box-2" from another device       | security        |

  Rule: The decision pipeline suppresses pushes for a reason (AC-7)

    @v1 @api @AC-7
    Scenario Outline: Suppression reasons
      Given <condition>
      When "devtool" asks a question in conversation 41
      Then no push is received
      And the owner's notification log shows the reason "<reason>"

      Examples:
        | condition                                                             | reason      |
        | the owner turned the "asks" setting to "none"                          | setting_off |
        | the owner muted conversation 41                                        | muted       |
        | it is inside the owner's quiet hours                                   | quiet_hours |
        | the owner's only device has conversation 41 open and focused           | active_here |

    @v1 @api @AC-7
    Scenario Outline: An urgent ask in quiet hours follows the bypass setting
      Given it is inside the owner's quiet hours and "urgent bypass" is <bypass>
      When "devtool" asks an urgent question
      Then <outcome>

      Examples:
        | bypass | outcome                                                       |
        | on     | the fake push service receives one push                       |
        | off    | no push is received and the log shows "quiet_hours"           |

    @v1 @api @I-28
    Scenario: A notification is not sent for what the owner can no longer see
      Given "devtool" asked a question in conversation 41
      When the owner deletes conversation 41 before the push is sent
      Then no push is received and the log shows "not_visible"

    @v1 @browser
    Scenario: Security pushes cannot be turned off
      When the owner opens the notification settings
      Then the security reason shows as always on with no switch

  Rule: Delivery is private and well-behaved (I-28)

    @v1 @api @AC-7
    Scenario: A gone subscription is disabled
      Given the push service says the owner's subscription is gone
      When "devtool" asks a question
      Then the subscription is listed as disabled in Settings
      And the next ask sends nothing to it

    @v1 @api
    Scenario Outline: The preview setting decides what the lock screen shows
      Given the preview setting is "<previews>"
      When "devtool" posts "@drew the deploy failed" in conversation 41
      Then the decrypted push reads title "<title>" and body "<body>"

      Examples:
        | previews | title                      | body                       |
        | full     | Dev Tool @devtool          | the deploy failed          |
        | sender   | Dev Tool @devtool          | New message                |
        | none     | Convoz                     | New activity               |

    @v1 @browser @phone @needs-owner
    Scenario: Push works on an iPhone Home Screen app
      Given the owner added Convoz to the iPhone Home Screen
      When the owner turns push on with a tap
      And "devtool" asks a question
      Then the iPhone shows the notification and the app badge shows 1

  Rule: Answering from the notification is later and off by default (I-35)

    @later @api @I-35
    Scenario: Push action buttons are off by default
      When "devtool" asks a question
      Then the push has no action buttons
