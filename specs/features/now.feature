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

    # Owner, msg 275: "also, this page is almost really nice. I'd say center everything, and drop the nothing needs you to where the list would be underneith"
    @v1 @browser
    Scenario: With nothing waiting, the feed centres the wordmark, the all-clear line under it, and the folds
      Given conversation 41 has an answered ask and a dismissed ask, and nothing else waits
      When the owner opens Now
      Then the wordmark, "All clear. Nothing needs you." and the fold chips are centred in the page column, in that order from the top
      And the page does not scroll sideways

    # Owner, conv 1, msg 535: "hmm, it says nothing needs me, but there are a lot of unseen responses.. i'm wondering if there's a better way for that to be handled"
    # Msg 562: "hmm, probably you can come up with a good ui/ux for that that really makes the absorbtion of info quick an easy"
    @v1 @browser
    Scenario: With no decisions but unread conversations, Now lists them instead of saying all clear
      Given no decision waits and "devtool" posted 5 messages in conversation 41 that the owner has not read
      When the owner opens Now
      Then Now says "No decisions waiting" and not "All clear. Nothing needs you."
      And the wordmark is not shown, so the cards sit near the top
      And a summary line says "5 unread in 1 conversation"
      And conversation 41 has one card with its title, an unread count of 5 and a short age
      And the card shows only the 3 newest unread lines, newest first, each with its author

    # Owner, conv 1, msg 535 (see above)
    @v1 @browser
    Scenario: Marking all read from Now clears the list and shows all clear
      Given no decision waits and "devtool" posted 2 messages in conversation 41 that the owner has not read
      When the owner opens Now and taps "Mark all read"
      Then the Unread list is gone and Now says "All clear. Nothing needs you."

    # Owner, conv 1, msg 535 (see above): muted conversations are not listed
    @v1 @browser
    Scenario: A muted conversation is not listed under Unread
      Given no decision waits and "devtool" posted 2 messages in a muted conversation 41 that the owner has not read
      When the owner opens Now
      Then Now says "All clear. Nothing needs you." and has no Unread list

    # Owner, conv 1, msg 535 (see above)
    @v1 @browser
    Scenario: Opening an unread row lands at the first unread message
      Given no decision waits and "devtool" posted "First news", "Second news" and "Third news" in conversation 41 that the owner has not read
      When the owner opens Now and taps the conversation 41 row under Unread
      Then conversation 41 opens with the "New messages" line above "First news"

    # Conv 16, msg 321: "the \"Now\" should always reflect if there's something in the feed if anything is there"
    @v1 @browser
    Scenario: The Now item shows how many items wait in the feed and updates live
      Given 2 open asks, 1 snoozed ask and 1 answered ask
      When the owner opens Now
      Then the Now item in the rail and the Now tab on a phone show 2
      When the agent answers nothing and the owner answers one ask
      Then the Now item shows 1
      When the owner answers the last ask
      Then the Now item shows no count

    # Conv 17, msg 323: "after approving a new bot, I should have a quick way to message it right after"
    @v1 @browser
    Scenario: After approving a new agent the card offers a message to it
      Given an agent asked to connect as "dev-ci" from the machine "box-2"
      When the owner opens Now and taps Approve
      Then the card reads "@dev-ci joined" with a "Message @dev-ci" button
      When the owner taps "Message @dev-ci"
      Then a new conversation opens with @dev-ci tagged and the cursor in the composer

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

    # Owner, feed ask 237: "I can't reopen the items in the feed. I should be able to. Also, I should always be able to quick reply/snooze/etc"
    @v1 @browser
    Scenario: Every item in the feed opens its conversation when tapped
      Given conversation 41 has a snoozed ask, an answered ask and a dismissed ask
      When the owner opens each fold in Now and taps the ask in it
      Then conversation 41 opens with that ask in view

    @v1 @browser
    Scenario: Reopen puts a dismissed ask back on a phone
      Given an open ask of "devtool" that the owner dismissed
      When the owner opens "Dismissed today" in Now and taps "Reopen"
      Then Now lists the ask as open again with its quick bar
      When the owner dismisses it and reopens it from the ask options in conversation 41
      Then the ask in conversation 41 shows its quick bar

    @v1 @browser
    Scenario Outline: An open ask always shows its quick bar
      Given an open ask of "devtool" <before>
      When the owner looks at the ask <where>
      Then the ask shows its quick bar with <buttons>

      Examples:
        | before                   | where                            | buttons                         |
        | in Now                   | in Now                           | Quick reply, Snooze, Dismiss    |
        | in conversation 41       | in conversation 41               | Quick reply, Snooze, Dismiss    |
        | in conversation 41       | with its reply box open          | Quick reply, Snooze, Dismiss    |
        | that was dismissed       | in Now after "Reopen"            | Quick reply, Snooze, Dismiss    |
        | that was snoozed         | in Now after "Unsnooze"          | Quick reply, Snooze, Dismiss    |
        | in Now                   | in Now after a reload            | Quick reply, Snooze, Dismiss    |
        | in conversation 41       | in conversation 41 after a reload| Quick reply, Snooze, Dismiss    |

    # Owner, feed ask 240: "It doesn't reopen, but I should be able to click and still reply in thread or jump to convo. I should be able to follow up"
    @v1 @browser
    Scenario: An answered ask in the feed lets the owner follow up in its thread or jump to its conversation
      Given an answered ask, a dismissed ask and a snoozed ask of "devtool"
      When the owner opens the folds in Now
      Then each row offers "Reply in thread" and "Jump to conversation"
      When the owner taps "Reply in thread" on the answered row
      Then the thread of the ask opens and its Reply box has focus
      When the owner taps "Jump to conversation" on the answered row
      Then conversation 41 opens with the ask in view and the ask is still answered

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: Reply in thread on an ask and on a fold row shows the replies
      Given an open ask of "devtool" in Now that "docs" replied to twice in its thread, and an answered ask with one reply
      When the owner opens Now
      Then "Reply in thread" on the open ask shows "2 replies"
      When the owner opens the folds in Now
      Then "Reply in thread" on the answered row shows "1 reply"
      And an ask with no reply shows "Reply in thread" with no count

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

  # Owner said (msg 1117): "the feed items are sometimes like you know they don't really give me the context that I need. And while opening things in a new thread, like responding in a thread is relatively easy, it fails to consider that as a user flow, right? It's like, okay, I've opened it as a thing, and now it's like basically just delegates to a new thread, but then the item still stays there. It doesn't show that I've responded. The conversation kind of doesn't continue in the same way, right?"
  # Owner said (msg 1131): "update this ask so it has all of my QA answered ... that's the way to do it."
  # An ask waits under You replied only while the owner's reply is the last word in its thread: once the agent (or anyone else) posts
  # after it, the ask is back in the main list and its card no longer says "You replied · waiting on @agent". One reply counts for one ask.
  Rule: Asks where the owner's reply is the last word wait under You replied, and the thread opens inside the app

    @v1 @browser
    Scenario: Asks the owner replied to wait in their own section
      Given an open ask of "devtool" that the owner replied to with a long reply, and an open ask of "docs" that the owner did not reply to
      When the owner opens Now
      Then Now lists the ask of "docs" in the main list
      And under "You replied · waiting on the agent" it lists the ask of "devtool" with its question, "@devtool", the first 100 characters of the reply and its age
      And the ask of "devtool" is not in the main list and does not count in the badge
      When the owner taps the row
      Then the thread of the ask opens

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: A You replied row shows the replies and the new ones, and the new clear when the thread is opened
      Given an open ask of "devtool" that the owner replied to, "devtool" replied in its thread, and the owner replied again
      When the owner opens Now
      Then the row under "You replied · waiting on the agent" shows "3 replies · 1 new"
      When the owner opens the thread from the row and goes back to Now
      Then the row shows "3 replies" with no "new"

    @v1 @browser
    Scenario: Reply in thread opens the thread without a page load, and the ask moves on return
      Given an open ask of "devtool" in Now
      When the owner taps "Reply in thread" on the ask in Now
      Then the thread opens and its Reply box has focus, and the page was not loaded again
      When the owner sends "Which runner?" in the thread and goes back to Now
      Then the ask is under "You replied · waiting on the agent" at once, without waiting for a poll

    @v1 @browser
    Scenario: An unread conversation in Now has a Reply action that focuses the composer
      Given "devtool" posted a message in conversation 41 that the owner has not read
      When the owner opens Now and taps "Reply" on the unread card
      Then conversation 41 opens inside the app and its composer has focus

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

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @browser @I-17
    Scenario: Approving a pending add lets the agent in from the request
      Given "devtool" requested to add "@docs" to conversation 52 at message 300
      When the owner approves the add
      Then conversation 52 shows "Approved · @docs added"
      And "docs" reads conversation 52 with the earlier messages and the ones after the request

    @v1 @browser @I-17
    Scenario: Declining a pending add keeps the agent out
      Given "devtool" requested to add "@docs" to conversation 52
      When the owner declines the add
      Then conversation 52 shows "Declined"
      And "docs" cannot read conversation 52

  Rule: Machine requests are approved from Now

    # Owner said: "Approvals just go into the feed, right?" One tap, no passkey, no sheet.
    @v1 @browser @I-36
    Scenario: Now shows an agent's connect request as one card with Approve and Decline
      Given an agent asked to connect as "dev-ci" from the machine "box-2" with the description "Runs CI"
      When the owner opens Now
      Then one card reads "box-2 wants to connect as @dev-ci" with "Runs CI" under "From the agent"
      And the card has Approve and Decline
      And Deny all removes it

    @v1 @browser @I-36
    Scenario: A machine request deep link brings its card into view
      Given a machine request "box-9" with request id 9 is pending
      When the owner opens "/now/machine/9"
      Then the card of "box-9" is in view with its code, the reported host info and the source, and Approve and Decline

    @v1 @browser @I-36
    Scenario: An expired machine request leaves Now
      Given a machine request "box-9" made 10 minutes ago
      When the test clock passes its expiry
      Then Now no longer shows it with no reload
