# Source: design draft 9 §4.2 (`now`: asks, pending adds, machine requests), §8.1, §9 (badge, deep links),
# §13 GET /api/now, I-13, I-15, I-17, I-36. Prototype: the ask bar (R quick reply, S snooze, X dismiss, O open app).
# Kept from the draft-6 spec, reworded: Needs-you → Now; Done → Dismiss; snooze hides then returns;
# unsnooze returns at once; the count updates in every open tab.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Now
  As the owner
  I want one screen with everything waiting on me: asks, pending agent adds and machine requests
  So that I can clear my queue from my phone in a few taps

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: Now lists what waits on the owner, most urgent first

    @v1 @browser
    Scenario: Urgent asks come before other asks
      Given "devtool" asked "Merge #415 on its own?" and then "docs" asked an urgent "Roll back box-3?"
      When the owner opens Now
      Then "Roll back box-3?" is listed first
      And each ask shows the agent as "Display Name @handle" and the conversation title

    @v1 @browser
    Scenario: Now shows pending adds and machine requests next to asks
      Given "devtool" requested to add "@release-bot" to conversation 41
      And a machine request "box-9" with the code "PLRT-HXCV" is pending
      When the owner opens Now
      Then Now shows the pending add with Approve and Decline
      And Now shows the machine request card with the code "PLRT-HXCV"

    @v1 @browser @phone
    Scenario: The badge counts open asks that are not snoozed
      Given 3 open asks and 1 of them snoozed
      When the installed app is in the background
      Then the app badge shows 2

  Rule: The owner answers from Now without losing their place

    @v1 @browser @I-15
    Scenario Outline: Answering from Now does not mark the conversation read
      Given conversation 41 has 4 unread messages and an open ask "Merge #415 on its own?"
      When the owner answers from Now with <choice>
      Then the ask shows "<result>"
      And conversation 41 still shows 4 unread in the rail

      Examples:
        | choice                         | result                          |
        | the recommended "Merge it"     | Answered · Merge it             |
        | the alternative "Hold it"      | Answered · Hold it              |
        | the quick reply "Split in two" | Replied · Split in two          |

    @v1 @browser
    Scenario: Dismiss removes an ask from Now
      Given an open ask of "devtool"
      When the owner dismisses it
      Then Now no longer lists it
      And the ask in conversation 41 shows "Dismissed"

    # Per prototype v41 (P:5006-5025): Dismiss and Snooze each show a 10 second toast with Undo; the Dismissed fold has Reopen (P:6772).
    @v1 @browser
    Scenario: Dismiss shows an Undo toast and Undo puts the ask back
      Given an open ask of "devtool"
      When the owner dismisses it
      Then a toast says "Dismissed" with an Undo button for 10 seconds
      When the owner taps Undo
      Then Now lists the ask as open again

    @v1 @browser
    Scenario: The Dismissed fold lists dismissed asks and Reopen puts one back
      Given an open ask of "devtool" that the owner dismissed
      When the owner opens "Dismissed today" in Now
      Then it lists the ask as "Dismissed" with a "Reopen" button
      When the owner taps "Reopen"
      Then Now lists the ask as open again

    @v1 @browser
    Scenario: The ask bar works from the keyboard
      Given an open ask of "devtool" has focus in Now
      When the owner presses "S" and picks "1 hour"
      Then the ask moves to snoozed
      And pressing "X" on the next ask dismisses it

    @v1 @browser
    Scenario: A losing answer shows what won
      Given an open ask of "devtool" is open in two browsers
      When one browser answers "Merge it" and the other then answers "Hold it"
      Then the second browser shows "Answered · Merge it" and that its answer was not used

  Rule: Snooze hides an ask until its time

    @v1 @browser @I-13
    Scenario: A snoozed ask returns at its time
      Given an open ask of "devtool"
      When the owner snoozes it for "1 hour"
      Then Now lists it under snoozed with its wake time
      And after the test clock moves 1 hour Now lists it as open again
      And the owner gets a "snooze_wake" notification

    @v1 @browser @I-13
    Scenario: Snooze shows an Undo toast and Undo puts the ask back
      Given an open ask of "devtool"
      When the owner snoozes it for "1 hour"
      Then a toast says "Snoozed until 1 hour" with the wake time and an Undo button for 10 seconds
      When the owner taps Undo
      Then Now lists the ask as open again

    @v1 @browser @I-13
    Scenario: Unsnooze returns an ask at once
      Given an ask snoozed until tomorrow 09:00
      When the owner unsnoozes it
      Then Now lists it as open

    # Per prototype v41 (P:3925): 1 hour; Tonight = 6:00 PM (18:00) local the same day; Tomorrow = 9:00 AM local.
    # DEFAULT (owner to confirm): the prototype offers Tonight at any hour; a real wake time cannot be in the past, so Tonight is not offered from 6:00 PM.
    @v1 @browser @I-13 @C-9 @AC-29
    Scenario Outline: Snooze presets set the right wake time
      Given the time is 2026-10-16 14:00 in the owner's time zone
      When the owner snoozes an ask with "<preset>"
      Then the wake time is <wake>

      Examples:
        | preset   | wake                |
        | 1 hour   | 2026-10-16 15:00    |
        | Tonight  | 2026-10-16 18:00    |
        | Tomorrow | 2026-10-17 09:00    |

    @v1 @browser
    Scenario: The count updates in every open tab
      Given Now is open in two tabs with 3 open asks
      When the owner dismisses an ask in one tab
      Then both tabs show 2 open asks with no reload

    @v1 @browser @I-13 @C-9 @AC-29
    Scenario: Tonight is not offered from 6:00 PM
      Given the time is 2026-10-16 19:30 in the owner's time zone
      When the owner opens the snooze menu of an open ask
      Then it offers "1 hour" and "Tomorrow" but not "Tonight"

  Rule: Agent adds wait for a human (pending adds)

    @v1 @browser @I-17
    Scenario: Approving a pending add lets the agent in from the request
      Given "devtool" requested to add "@docs" to conversation 52 at message 300
      When the owner approves the add
      Then conversation 52 shows "Approved · @docs added"
      And "docs" reads conversation 52 from message 300 onward and nothing earlier

    @v1 @browser @I-17
    Scenario: Declining a pending add keeps the agent out
      Given "devtool" requested to add "@docs" to conversation 52
      When the owner declines the add
      Then conversation 52 shows "Declined"
      And "docs" cannot read conversation 52

  Rule: Machine requests are approved from Now

    @v1 @browser @I-36
    Scenario: A machine request deep link opens its card
      Given a machine request "box-9" with request id 9 is pending
      When the owner opens "/now/machine/9"
      Then the approve sheet of "box-9" shows its code, the reported host info, the source and the age

    @v1 @browser @I-36
    Scenario: An expired machine request leaves Now
      Given a machine request "box-9" made 10 minutes ago
      When the test clock passes its expiry
      Then Now no longer shows it with no reload
