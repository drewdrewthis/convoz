# Source: design draft 9 §8 (I-8, I-14), §8.2 (unread math, involvement rule DA-3), §13 replies route.
# Prototype: thread pane with "Reply…", agents answer inside the thread, a thread reply stays unread until that thread is opened.
# Owner decision 2026-10-18 (design B, mini app): "Replies stay in the thread. The message gets a bold reply chip and a faded peek of the
# last reply. Tap the chip to open the thread." Earlier, verbatim: "'also reply in the conversation' I think this is dumb. I want a
# better ui. Should be clear in the main, and easy to jump into a thread." The "Also send to conversation" box is gone from the web;
# the API still takes broadcast (the CLI and agents use it).
# Every scenario runs end to end in a browser or through the API against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Threads
  As the owner
  I want side discussions in threads that only bother me when I am involved
  So that busy conversations stay readable

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
    And "devtool" posted message 900 "Step 1 is the filter chips UI" in conversation 41

  Rule: A thread hangs off one top-level message

    @v1 @browser
    Scenario: The owner replies in a thread
      When the owner opens the thread of message 900 and replies "Can step 1 ship on its own?"
      Then the thread pane shows the reply
      And message 900 shows "1 reply" in the main list
      And the main list does not show the reply itself

    @v1 @cli
    Scenario: A watch line from a thread names the thread root
      Given "devtool" runs "convoz watch --json"
      When the owner replies inside thread 900
      Then the watch line carries "thread_root_id" 900
      And the watch line for a message in the main list carries no "thread_root_id"

    @v1 @cli
    Scenario: Reply to a message inside a thread goes to its root
      Given "docs" replied "Looks fine to me" in thread 900
      When "devtool" runs "convoz reply" on that reply with "Thanks, shipping it"
      Then the command succeeds and thread 900 shows the new reply
      And the main list does not show it

  Rule: Thread replies count as unread only where the owner is involved (DA-3)

    @v1 @browser @I-14
    Scenario: Replies in a thread the owner is not in never make the conversation bold
      Given the owner has read conversation 41
      When "docs" posts 5 replies in thread 900
      Then conversation 41 is not bold in the rail
      And message 900 shows "5 replies · @docs"

    @v1 @browser @I-14
    Scenario: Replies in a thread the owner replied in count as unread
      Given the owner replied in thread 900 and has read conversation 41
      When "devtool" posts 2 replies in thread 900
      Then conversation 41 is bold with 2 unread

    @v1 @browser @I-14
    Scenario: A mention in a thread makes the owner involved
      Given the owner has read conversation 41
      When "devtool" replies "@drew can you confirm?" in thread 900
      Then conversation 41 is bold with 1 unread

    @v1 @browser @I-14
    Scenario: Opening the conversation does not clear thread replies
      Given the owner replied in thread 900 and "devtool" then posted 2 replies there
      When the owner opens conversation 41 but not the thread
      Then conversation 41 still shows 2 unread
      And opening thread 900 clears them

    @v1 @browser @I-14
    Scenario: A broadcast reply read in its thread is read in the main list
      Given the owner replied in thread 900
      And "devtool" posted a broadcast reply in thread 900
      When the owner reads it in the thread pane
      Then conversation 41 shows no unread for it in the main list

    @v1 @browser @I-14
    Scenario Outline: Messages that never count as unread
      Given the owner has read conversation 41
      When <message> arrives
      Then conversation 41 is not bold

      Examples:
        | message                                            |
        | the owner's own message from another device        |
        | a system line "@docs joined"                       |
        | a message from "devtool" that it deletes at once   |

  Rule: One tap opens a thread on a phone

    # Owner ruling 2026-10-18 (iPhone, Chrome): "Also opening it requires a double click."
    @v1 @browser @phone
    Scenario: One tap on the reply chip opens the thread pane
      Given conversation 41 is open on a phone with a thread on its first message
      When the owner taps the reply chip once
      Then the thread pane is open
      And the reply chip is at least 44 px tall

  Rule: A thread root shows its last reply in the main list

    # Owner decision 2026-10-18, design B: "Replies stay in the thread. The message gets a bold reply chip and a faded peek of the last reply.
    # Tap the chip to open the thread." and "Should be clear in the main, and easy to jump into a thread."
    @v1 @browser
    Scenario: The reply chip shows the count and the last replier
      Given "devtool" and "docs" replied in thread 900, "docs" last
      When the owner opens conversation 41
      Then message 900 has a chip "2 replies · @docs" at least 44 px tall
      And a reply of the owner reads "you" in the chip

    @v1 @browser
    Scenario: The peek shows the last reply
      Given "docs" replied with a long reply in thread 900
      When the owner opens conversation 41
      Then under the chip one faded line shows "docs: " and the reply as plain text, cut with an ellipsis

    @v1 @browser
    Scenario: A new reply updates the chip live
      Given conversation 41 is open and message 900 shows "1 reply · @devtool"
      When "docs" replies in thread 900
      Then without a reload the chip reads "2 replies · @docs" and the peek "docs: Same here."

    @v1 @browser @phone
    Scenario: One tap on the peek opens the thread
      Given conversation 41 is open on a phone and message 900 has a reply
      When the owner taps the peek once
      Then the thread pane is open with the reply

    @v1 @browser
    Scenario: The thread pane has no Also send to conversation box
      Given the owner opened the thread of message 900
      Then the pane has a reply box and no "Also send to conversation" box
      And a reply stays in the thread

    @v1 @browser @I-14
    Scenario: The chip has a dot while the last reply is unread
      Given the owner replied in thread 900 and "devtool" answered
      Then the chip shows a dot
      When the owner reads the thread
      Then the dot is gone, and a newer reply brings it back
