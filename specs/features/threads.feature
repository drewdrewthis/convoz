# Source: design draft 9 §8 (I-8, I-14), §8.2 (unread math, involvement rule DA-3), §13 replies route.
# Prototype: thread pane with "Reply…", agents answer inside the thread, a thread reply stays unread until that thread is opened.
# Owner decision 2026-10-18 (design B, mini app; its chip, peek and drawer gave way to the inline thread of 2026-10-22, below): "Replies stay in the thread. The message gets a bold reply chip and a faded peek of the
# last reply. Tap the chip to open the thread." Earlier, verbatim: "'also reply in the conversation' I think this is dumb. I want a
# better ui. Should be clear in the main, and easy to jump into a thread." The "Also send to conversation" box is gone from the web;
# the API still takes broadcast (the CLI and agents use it).
# Owner decision 2026-10-22 (conv 112 msg 2893, https://github.com/drewdrewthis/convoz/issues/61), verbatim: "if there's a reply/thread,
# it should still be visible in the main conversation. If it's the latest message, the thread is fully expanded (maybe smaller text). The
# reply icon/placement can be better. If it's not the latest message, the reply can be collapsed: show at least three lines when
# collapsed, but you should be able to expand the whole thread in the conversation view. Then you can upgrade it to a full conversation.
# The thread in the drawer doesn't make sense." The thread drawer is gone: a thread is drawn under its root, and a reply is written in a
# small box there. A thread shown in full is read; a folded one stays unread until it is unfolded. "Upgrade to a conversation" waits on
# the server (https://github.com/drewdrewthis/convoz/issues/32).
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
      When the owner opens the reply box of message 900 and replies "Can step 1 ship on its own?"
      Then the reply shows in the thread under message 900
      And the main list has no message of its own for the reply

    @v1 @browser
    Scenario: Following a reply link to the conversation that is already open opens the thread
      Given conversation 41 is open
      When the owner follows the link "/chats/41#reply=900" without reloading
      Then the thread under message 900 is unfolded with its reply box open and focused

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
      And the thread under message 900 shows the 5 replies

    # Owner, 2026-10-19 (msg 266, on the row "Convoz feedback with Cl... 5"): "This is confusing, right -- I guess this means that there are
    # 5 unviewed items hidden in threads somewhere?" Msg 267: "that's what I was saying we needed to update -- so I could more easily see
    # hidden threads, and jump back in. Basically a conversation is the main thread, but then there are sub-threads right, so I should
    # actually see all the threads on the lists." The conversation badge counts the main chat only; thread replies count on the thread's row.
    @v1 @browser @I-14
    Scenario: Replies in a thread the owner replied in count as unread
      Given the owner replied in thread 900 and has read conversation 41
      When "devtool" posts 2 replies in thread 900
      Then the row of thread 900 shows 2 unread and conversation 41 is not bold and shows no count

    # Owner, 2026-10-19 (msg 266, on the row "Convoz feedback with Cl... 5"): "This is confusing, right -- I guess this means that there are
    # 5 unviewed items hidden in threads somewhere?" Msg 267: "that's what I was saying we needed to update -- so I could more easily see
    # hidden threads, and jump back in. Basically a conversation is the main thread, but then there are sub-threads right, so I should
    # actually see all the threads on the lists." The conversation badge counts the main chat only; thread replies count on the thread's row.
    @v1 @browser @I-14
    Scenario: A mention in a thread makes the owner involved
      Given the owner has read conversation 41
      When "devtool" replies "@drew can you confirm?" in thread 900
      Then the row of thread 900 shows 1 unread and conversation 41 is not bold and shows no count

    # Owner, 2026-10-19 (msg 266, on the row "Convoz feedback with Cl... 5"): "This is confusing, right -- I guess this means that there are
    # 5 unviewed items hidden in threads somewhere?" Msg 267: "that's what I was saying we needed to update -- so I could more easily see
    # hidden threads, and jump back in. Basically a conversation is the main thread, but then there are sub-threads right, so I should
    # actually see all the threads on the lists." The conversation badge counts the main chat only; thread replies count on the thread's row.
    @v1 @browser @I-14
    Scenario: Opening the conversation does not clear the replies of a folded thread
      Given the owner replied in thread 900 and "devtool" then posted 2 replies there
      And a newer message 901 has a thread, so thread 900 is folded
      When the owner opens conversation 41 but does not unfold thread 900
      Then the row of thread 900 still shows 2 unread and conversation 41 shows no count
      And unfolding thread 900 clears them

    @v1 @browser @I-14
    Scenario: A broadcast reply read in its thread is read in the main list
      Given the owner replied in thread 900
      And "devtool" posted a broadcast reply in thread 900
      When the owner reads it in the thread under message 900
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

  Rule: A thread shows in the conversation under its root

    # Owner, conv 112 msg 2893: "If it's the latest message, the thread is fully expanded (maybe smaller text) ... If it's not the latest
    # message, the reply can be collapsed: show at least three lines when collapsed, but you should be able to expand the whole thread".
    @v1 @browser
    Scenario: The latest thread shows every reply and an older one folds to its first three
      Given thread 900 has 5 replies and a newer message 901 has a thread with 4 replies
      When the owner opens conversation 41
      Then the thread under message 901 shows all 4 replies in smaller text than the main list, indented under its root
      And the thread under message 900 shows its first 3 replies, one line each, and "Show all 5 replies"
      When the owner taps "Show all 5 replies"
      Then the thread under message 900 shows all 5 replies in place
      And "Show fewer replies" folds it again

    @v1 @browser
    Scenario: A new reply shows live in its thread
      Given conversation 41 is open and thread 900 has 1 reply
      When "docs" replies "Same here." in thread 900
      Then without a reload the thread under message 900 shows "Same here."

    @v1 @browser
    Scenario: The reply box has no Also send to conversation box
      Given the owner opened the reply box of message 900
      Then the box has no "Also send to conversation" box
      And a reply stays in the thread

    @v1 @browser
    Scenario: Cancel reply closes the box and the thread stays
      Given the owner replied in the thread under message 900
      When the owner taps "Cancel reply"
      Then the reply box is gone and the thread still shows the reply

    @v1 @browser @I-14
    Scenario: A folded thread shows its new replies until it is unfolded
      Given the owner replied in thread 900 and "devtool" answered, and a newer message 901 has a thread
      Then the thread under message 900 offers "Show all 2 replies · 1 new"
      When the owner unfolds it
      Then the new count is gone, and a reply that comes while the conversation is closed brings it back on the folded thread

    # Owner: "The reply icon/placement can be better."
    @v1 @browser
    Scenario: On a desktop a reply arrow shows on a hovered message and opens its reply box
      Given conversation 41 is open on a desktop and message 900 has no replies
      When the owner hovers message 900 and taps its "Reply in thread" arrow
      Then a reply box opens under message 900 and has the focus

  Rule: A thread is one tap away on a phone

    # Owner ruling 2026-10-18 (iPhone, Chrome): "Also opening it requires a double click."
    @v1 @browser @phone
    Scenario: One tap on Reply under a thread opens its reply box
      Given conversation 41 is open on a phone with a thread on its first message
      When the owner taps "Reply" under the thread once
      Then the reply box is open
      And "Reply" is at least 44 px tall
      And the replies show no "Message actions" button while message 900 keeps its own

    # Owner, conv 9 msg 2708: on his phone he could not open the thread of msg 2691 to reply in it.
    @v1 @browser @phone
    Scenario: On a phone a long press on a message opens Reply in thread
      Given conversation 41 is open on a phone and message 900 has no replies
      When the owner long presses the text of message 900
      And taps "Reply in thread"
      Then the reply box is open under message 900
      When the owner taps the reply box, types a reply and taps "Send reply"
      Then the thread shows the reply

    @v1 @browser @phone
    Scenario: On a phone the message actions button shows and a tap on it opens Reply in thread
      Given conversation 41 is open on a phone and message 900 has no replies
      Then the "Message actions" button of message 900 shows without a hover
      When the owner taps it and taps "Reply in thread"
      Then the reply box is open under message 900

  # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
  Rule: Every Reply in thread shows how many replies the thread has and how many are new

    @v1 @browser
    Scenario: A folded thread and the message menu show the replies and the new ones
      Given the owner replied in thread 900, then "devtool" and "docs" answered, and a newer message 901 has a thread
      When the owner opens conversation 41
      Then the thread under message 900 offers "Show all 3 replies · 2 new"
      When the owner opens the message actions of message 900
      Then "Reply in thread" shows "3 replies · 2 new"

    @v1 @browser
    Scenario: Unfolding the thread clears the new count
      Given the owner replied in thread 900, then "devtool" and "docs" answered, and a newer message 901 has a thread
      And the owner has conversation 41 open
      When the owner unfolds thread 900
      Then "Reply in thread" shows "3 replies" with no "new"

    @v1 @browser
    Scenario: A message with no replies shows no count
      When the owner opens conversation 41 and the message actions of message 900
      Then "Reply in thread" shows no count

    @v1 @browser
    Scenario: A new reply brings the new count live
      Given the owner replied in thread 900, then "devtool" answered, the owner read the thread, and a newer message 901 has a thread
      When "docs" replies in thread 900
      Then without a reload the folded thread under message 900 offers "Show all 3 replies · 1 new"

  Rule: The Conversations list shows every thread under its conversation

    # Owner, 2026-10-19 (msg 266, on the row "Convoz feedback with Cl... 5"): "This is confusing, right -- I guess this means that there are
    # 5 unviewed items hidden in threads somewhere?" Msg 267: "that's what I was saying we needed to update -- so I could more easily see
    # hidden threads, and jump back in. Basically a conversation is the main thread, but then there are sub-threads right, so I should
    # actually see all the threads on the lists. \"older\" works well --- we can use that for the threads as well".
    @v1 @browser @I-14
    Scenario: Each conversation lists its threads under it, and a thread opens from its row
      Given "devtool" and "docs" replied in thread 900 of conversation 41
      When the owner opens the Conversations list
      Then conversation 41 lists thread 900 under it as an indented row with its root text
      When the owner taps the row of thread 900
      Then the conversation opens with the thread under message 900 unfolded and its reply box open

    @v1 @browser @I-14
    Scenario: Thread replies count on the thread's row, not the conversation's
      Given the owner replied in thread 900 and has read conversation 41
      And the owner opened the Conversations list
      When "devtool" posts 2 replies in thread 900
      Then without a reload the row of thread 900 shows "Unread: 2" and conversation 41 shows no count
      When the owner opens thread 900
      Then the row of thread 900 shows no count

    @v1 @browser @I-21
    Scenario: Threads with no reply since yesterday fold into Older under their conversation
      Given thread 900 has a recent reply and thread 901 has no reply since yesterday
      When the owner opens the Conversations list
      Then conversation 41 lists thread 900 and the toggle "Older · 1" under it
      And expanding "Older · 1" shows thread 901

    @v1 @browser @I-14
    Scenario: A long thread preview stays inside the row and keeps its unread count in view
      Given a thread with a very long root text has 3 unread replies
      When the owner opens the Conversations list at 320, 390 and 1280 px wide
      Then every thread row ends inside its list and its unread count is in view
      And the long preview ends with an ellipsis and the page does not scroll sideways

    # Owner (Drew, msg 685): "ui fail on long links in threads"
    # The owner's screenshot: a long Slack link in the owner's own bubble ran past the left edge of the thread pane, and the message's ⋯ button covered the bubble's time.
    @v1 @browser
    Scenario: A long link in a thread stays inside its bubble
      Given the owner and "devtool" posted a message that is one very long link, in the thread and in the conversation
      When the owner opens the conversation and the reply box of the thread at 1280 and 390 px wide
      Then every long link ends inside the bubble, the bubble ends inside the thread, and the page does not scroll sideways

    # Owner (Drew, msg 685 screenshot): the ⋯ button covered the time ("5:" cut)
    @v1 @browser
    Scenario: The message actions button does not cover the time
      Given the owner replied in thread 900, and the owner and "devtool" each posted in the conversation
      When the owner looks at the messages at 1280 and 390 px wide
      Then no message's actions button sits over its time, in the conversation and in the thread
