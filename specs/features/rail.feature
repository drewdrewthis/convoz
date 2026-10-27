# Source: design draft 9 I-14 (unread math), I-21 (rail order), §8.2, §12.1 (BenchmarkRail_FloorZero1M), AC-13.
# Prototype: groups Starred, Conversations and a collapsed "Older · N" (not starred, the owner not last, and 48 hours quiet or marked stale),
# row preview "You: …" / "@agent: …" / "No messages yet", drag to reorder, "Reorder {title}. Alt plus arrow keys move it.",
# back and forward (Cmd+[ / Cmd+]), Cmd+K search, Cmd+\ folds the sidebar.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Rail
  As the owner
  I want a stable list of my conversations that I order myself
  So that things stay where I put them and unread work stands out

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"

  Rule: Order is the owner's; a new message puts its conversation on top (I-21)

    @v1 @browser @I-21
    Scenario: A new conversation goes to the top
      Then the Conversations group lists 60, 52, 41 in that order

    # Drew, 2026-10-26 (conv 311 msg 5768): a new conversation or a new message goes on top; the rest keep the order he set.
    @v1 @browser @I-21 @AC-13
    Scenario: A new message puts its conversation on top and the owner's order of the rest stays
      Given the owner dragged conversation 60 below 52, so the Conversations group lists 52, 60, 41
      When "devtool" posts in conversation 41
      Then the Conversations group lists 41, 52, 60 without a reload
      And conversation 41 is bold with its new preview
      And a reload shows 41, 52, 60

    @v1 @browser @I-21
    Scenario: Dragging a conversation puts it between its neighbours
      When the owner drags conversation 41 between 60 and 52
      Then the Conversations group lists 60, 41, 52
      And a second browser shows the same order after a reload

    @v1 @browser @I-21
    Scenario: The keyboard can reorder the rail
      Given conversation 41 has focus in reorder mode
      When the owner presses Alt+ArrowUp twice
      Then conversation 41 is first in the Conversations group

    @v1 @browser @I-21
    Scenario: Many drags between the same two rows keep a stable order
      When the owner drags a conversation between the same two neighbours 80 times
      Then the rail order after each drag matches the order the owner made
      And the order is the same after a reload

  Rule: Older conversations fold away

    # Drew, 2026-10-22 (msg 2678, #42): Older = not starred, the owner did not write the last message, and either no message for 48 hours
    # (it was "no message since yesterday", prototype v41 P:6089-6091) or an agent in it marked it stale. "If it's my message it can't go
    # stale, but if it's an agent's maybe it's no longer relevant." Only the conversations list goes Older; Now and the feed never do. It is
    # a view; the order stays the owner's. The rail has no action to mark one stale or to bring one back (his voice call can mark one: voice-call.feature).
    @v1 @browser @I-21 @C-9
    Scenario: Conversations with no message for 48 hours fold into Older
      Given conversation 41 is not starred and its last message was 2 days ago
      When the owner opens the rail
      Then 41 sits in the collapsed group "Older · 1"
      And expanding "Older · 1" shows it

    @v1 @browser @I-21 @C-9
    Scenario Outline: Only unstarred conversations with no message for 48 hours fold into Older
      Given conversation 52 <starred> and its last message was <when>
      When the owner opens the rail
      Then conversation 52 is in the <group> group

      Examples:
        | starred         | when        | group         |
        | is not starred  | today       | Conversations |
        | is not starred  | 1 day ago   | Conversations |
        | is starred      | 40 days ago | Starred       |

    @v1 @browser @cli @I-21
    Scenario: An agent marks a conversation stale and the next message brings it back
      Given the owner has the rail open and conversation 41 had a message today
      When "devtool" marks conversation 41 stale with the reason "Shipped"
      Then 41 moves into the collapsed group "Older · 1" without a reload
      When "devtool" posts in conversation 41
      Then 41 is back in the Conversations group

    @v1 @browser @cli @I-21
    Scenario: A conversation where the owner wrote last never goes Older
      Given the owner wrote the last message in conversation 41, 3 days ago
      When the owner opens the rail
      Then conversation 41 is in the Conversations group
      When "devtool" marks conversation 41 stale
      Then the CLI says the owner spoke last and conversation 41 stays in the Conversations group

  Rule: Rows tell what is new (I-14)

    @v1 @browser @I-14
    Scenario Outline: The row preview names the last writer
      Given the last message in conversation 52 is <last>
      When the owner opens the rail
      Then the row of 52 reads "<preview>"

      Examples:
        | last                                | preview                          |
        | "Deploy finished" from the owner    | You: Deploy finished             |
        | "All checks green" from "devtool"   | devtool: All checks green        |
        | nothing                             | No messages yet                  |

    @v1 @browser @I-14
    Scenario: Unread conversations are bold with a count
      Given the owner has read every conversation
      When "devtool" posts 3 messages in conversation 52
      Then conversation 52 is bold with "3"
      And opening conversation 52 clears the bold and the count

  Rule: The rail is quick to move around

    @v1 @browser
    Scenario: Back and forward move between visited conversations
      Given the owner opened 41, then 52, then 60
      When the owner presses Cmd+[ twice and then Cmd+]
      Then conversation 52 is open

    @v1 @browser
    Scenario: Cmd+K opens search from anywhere
      When the owner presses Cmd+K in conversation 41
      Then the search box has focus

    # Owner, msg 1791: "I also really want that feature we discussed to be able to collapse the sidebar".
    @v1 @browser
    Scenario: The owner folds the sidebar and it stays folded
      Given the owner has conversation 41 open on a wide screen
      When the owner clicks "Hide sidebar"
      Then the rail is a thin strip with only "Show sidebar" and the conversation takes the room
      When the owner reloads the page
      Then the rail is still folded
      When the owner presses Cmd+\
      Then the rail shows the conversations again

    # Owner, conv 179 msg 9346: "I also want to be able to resize the sidebar. I want the width remembered also on refresh".
    @v1 @browser
    Scenario: The owner resizes the sidebar and the width is remembered
      Given the owner has conversation 41 open on a wide screen
      Then the handle does not cover the end of a row: its star works at the default width
      When the owner drags the "Resize sidebar" handle 80 px to the right
      Then the sidebar is 80 px wider and the conversation moves with it
      When the owner reloads the page
      Then the sidebar has the same width
      When the owner presses the Left arrow on the handle
      Then the sidebar is narrower
      When the owner double-clicks the handle
      Then the sidebar has its first width again
      Then the handle is gone when the sidebar is folded or shows Now
      And on a narrow screen there is no sidebar to resize

    @v1 @browser
    Scenario: The question mark opens the shortcut list
      When the owner presses "?"
      Then the "Keyboard shortcuts" dialog lists every key
      And Escape closes it and returns focus where it was

  # Owner, conv 179 (msgs 4291 to 4334), UX plan §1: Now is a view of the left rail, not a page that replaces the conversation.
  Rule: On a wide screen Now is a view of the rail

    @v1 @browser
    Scenario: Now opens in the rail beside the open conversation
      Given "devtool" asks "Merge #415 on its own?" in conversation 52
      And the owner has conversation 41 open on a 1280 px wide screen
      When the owner clicks "Now" in the rail
      Then the rail lists the ask "Merge #415 on its own?" and no Conversations group
      And the rail is about 360 px wide and the conversation moves with it
      And conversation 41 is still open in the page

    @v1 @browser
    Scenario: Picking a Now item opens its conversation beside the Now list
      Given "devtool" asks "Merge #415 on its own?" in conversation 52 and "Roll back box-3?" in conversation 60
      And the owner has conversation 41 open with Now in the rail
      When the owner picks "Open conversation" on the ask "Roll back box-3?" in the rail
      Then conversation 60 is open in the page
      And the rail still lists both asks
      And the item of conversation 60 is marked as current and the item of conversation 52 is not

    @v1 @browser
    Scenario: Conversations, Escape and Now again each take the rail back to the conversations
      Given "devtool" asks "Merge #415 on its own?" in conversation 52
      And the owner has conversation 41 open with Now in the rail
      When the owner clicks "Conversations" at the top of the rail
      Then the rail lists the Conversations group and is 240 px wide
      When the owner presses Cmd+. and then Escape with the focus in the rail
      Then the rail lists the Conversations group and is 240 px wide
      When the owner clicks "Now" twice
      Then the rail lists the Conversations group and is 240 px wide
      And conversation 41 stayed open the whole time

    @v1 @browser
    Scenario: The rail stays in Now after a reload
      Given "devtool" asks "Merge #415 on its own?" in conversation 52
      And the owner has conversation 41 open with Now in the rail
      When the owner reloads the page
      Then the rail still lists the ask "Merge #415 on its own?" and is about 360 px wide
