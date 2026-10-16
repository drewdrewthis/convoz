# Source: design draft 9 §8 (I-8, I-14), §8.2 (unread math, involvement rule DA-3), §13 replies route.
# Prototype: thread pane with "Reply…", "Also send to conversation" (broadcast), agents answer inside the thread,
# a thread reply stays unread until that thread is opened.
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

    @v1 @browser
    Scenario: Also send to conversation copies a reply to the main list
      When the owner replies in thread 900 with "Also send to conversation" ticked
      Then the reply shows in the thread and in the main list
      And it counts once in any unread total

  Rule: Thread replies count as unread only where the owner is involved (DA-3)

    @v1 @browser @I-14
    Scenario: Replies in a thread the owner is not in never make the conversation bold
      Given the owner has read conversation 41
      When "docs" posts 5 replies in thread 900
      Then conversation 41 is not bold in the rail
      And message 900 shows "5 replies" with the time of the last one

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
