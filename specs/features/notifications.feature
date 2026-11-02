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

    @v1 @browser @phone @needs-owner @unimplemented
    Scenario: Push works on an iPhone Home Screen app
      Given the owner added Convoz to the iPhone Home Screen
      When the owner turns push on with a tap
      And "devtool" asks a question
      Then the iPhone shows the notification and the app badge shows 1

  Rule: Turning push on shows each step and confirms with a push

    # The owner, on an iPhone with Convoz on the Home Screen: "I'm not getting native notifications - can we fix that?" and
    # "I added it to the Home Screen already. I didn't get a notification for notifications being turned on".

    @v1 @browser
    Scenario: Turning push on shows each step and ends On
      Given the owner's phone allows notifications
      When the owner turns on "Push on this device" in Settings
      Then Settings says "Asking iPhone for permission…" and then "Signing up this device…"
      And Settings shows this device as "On"

    @v1 @browser
    Scenario: Turning push on sends a confirmation push
      Given the owner's phone allows notifications
      When the owner turns on "Push on this device" in Settings
      Then the fake push service receives one push titled "Notifications are on"
      And the push reads "You'll get messages from your agents here."

    @v1 @browser
    Scenario: A background worker that never starts shows an error
      Given the owner's phone allows notifications
      And the app's background worker never becomes ready
      When the owner turns on "Push on this device" in Settings
      Then Settings shows an error saying the background worker did not start
      And this device is not signed up for push

    @v1 @api
    Scenario: A browser with push only on its background worker can turn push on
      Given a phone browser whose window has no push support but whose background worker has it
      Then Settings treats the phone as able to receive push

  Rule: A banner on first open asks to turn notifications on

    # Owner (Drew, ask 111): "Banner on first open"
    # "A one-tap 'Turn on notifications' banner at the top of the Home Screen app the first time you open it, until you turn it on or
    # dismiss it. iPhone needs your tap, so this is the closest to asking by itself."

    @v1 @browser
    Scenario: The banner shows on first open when push is possible and undecided
      Given the owner's phone can receive push and has not decided on notifications
      When the owner opens Conversations
      Then the banner "Turn on notifications" shows with a "Turn on" button and a "Dismiss" button

    @v1 @browser
    Scenario: Tapping Turn on subscribes the device and the banner leaves
      Given the owner's phone can receive push and has not decided on notifications
      When the owner taps "Turn on" in the banner
      Then the banner goes away
      And the fake push service receives one push titled "Notifications are on"
      And Settings shows this device as "On"

    @v1 @browser
    Scenario: Dismissing the banner keeps it gone after a reload
      Given the owner's phone can receive push and has not decided on notifications
      When the owner dismisses the banner
      And the owner reloads the page
      Then the banner does not show

    @v1 @browser
    Scenario Outline: No banner once notifications are decided
      Given the owner's phone has notifications <permission>
      When the owner opens Conversations
      Then the banner does not show

      Examples:
        | permission |
        | allowed    |
        | blocked    |

    @v1 @browser
    Scenario: No banner when the browser cannot receive push
      Given the owner's browser cannot receive push
      When the owner opens Conversations
      Then the banner does not show

  Rule: A tapped push opens a page of the app

    # Owner (Drew, msg 144): "This is when I clicked on the notification"
    @v1 @browser
    Scenario: Tapping an ask push opens Now, not Conversation not found
      Given "devtool" asks a question and the owner's phone gets a push for it
      When the owner taps the notification
      Then the Now screen opens
      And it does not say "Conversation not found"

    # Owner (Drew, msg 144): "This is when I clicked on the notification"
    @v1 @api
    Scenario: A pushed URL that is not a page of the app opens Now
      Given a notification that carries a URL the app has no page for, or another site
      When the owner taps it
      Then the worker opens "/"
      And a page of the app opens as pushed

  Rule: Answering from the notification is later and off by default (I-35)

    @later @api @I-35
    Scenario: Push action buttons are off by default
      When "devtool" asks a question
      Then the push has no action buttons

  Rule: Chrome on iPhone is told to use Safari

    # Owner (Drew, ask 119): "Chrome"
    @v1 @browser
    Scenario: Settings tells Chrome on iPhone to use Safari
      Given the owner's browser is Chrome on an iPhone
      When the owner opens Settings
      Then "This device" says "Chrome on iPhone has no notifications for web apps. Open Convoz in Safari and add it to the Home Screen from there."

    # Owner (Drew, ask 119): "Chrome"
    @v1 @browser
    Scenario: The banner tells Chrome on iPhone to use Safari and can be dismissed
      Given the owner's browser is Chrome on an iPhone
      When the owner opens Conversations
      Then the banner says "Chrome on iPhone has no notifications for web apps. Open Convoz in Safari and add it to the Home Screen from there." with no "Turn on" button
      And dismissing the banner keeps it gone after a reload
