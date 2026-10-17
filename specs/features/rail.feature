# Source: design draft 9 I-14 (unread math), I-21 (rail order), §8.2, §12.1 (BenchmarkRail_FloorZero1M), AC-13.
# Prototype: groups Starred, Conversations and a collapsed "Older · N" (not starred, not fresh, no live agent),
# row preview "You: …" / "@agent: …" / "No messages yet", drag to reorder, "Reorder {title}. Alt plus arrow keys move it.",
# back and forward (Cmd+[ / Cmd+]), Cmd+K search.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Rail
  As the owner
  I want a stable list of my conversations that I order myself
  So that things stay where I put them and unread work stands out

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"

  Rule: Order is the owner's, never the activity's (I-21)

    @v1 @browser @I-21 @unimplemented
    Scenario: A new conversation goes to the top
      Then the Conversations group lists 60, 52, 41 in that order

    @v1 @browser @I-21 @AC-13 @unimplemented
    Scenario: Activity never reorders the rail
      When "devtool" posts in conversation 41
      Then the Conversations group still lists 60, 52, 41
      And conversation 41 is bold with its new preview

    @v1 @browser @I-21 @unimplemented
    Scenario: Dragging a conversation puts it between its neighbours
      When the owner drags conversation 41 between 60 and 52
      Then the Conversations group lists 60, 41, 52
      And a second browser shows the same order after a reload

    @v1 @browser @I-21 @unimplemented
    Scenario: The keyboard can reorder the rail
      Given conversation 41 has focus in reorder mode
      When the owner presses Alt+ArrowUp twice
      Then conversation 41 is first in the Conversations group

    @v1 @browser @I-21 @unimplemented
    Scenario: Many drags between the same two rows keep a stable order
      When the owner drags a conversation between the same two neighbours 80 times
      Then the rail order after each drag matches the order the owner made
      And the order is the same after a reload

  Rule: Older conversations fold away

    # Draft 9 (C-9): Older = not starred and no activity for 14 days. It is a view; the order stays the owner's.
    @v1 @browser @I-21 @C-9 @unimplemented
    Scenario: Quiet conversations fold into Older
      Given conversation 41 is not starred and its last activity was 15 days ago
      When the owner opens the rail
      Then 41 sits in the collapsed group "Older · 1"
      And expanding "Older · 1" shows it

    @v1 @browser @I-21 @C-9 @unimplemented
    Scenario Outline: Only quiet, unstarred conversations fold into Older
      Given conversation 52 <starred> and its last activity was <days> days ago
      When the owner opens the rail
      Then conversation 52 is in the <group> group

      Examples:
        | starred         | days | group         |
        | is not starred  | 13   | Conversations |
        | is starred      | 40   | Starred       |

  Rule: Rows tell what is new (I-14)

    @v1 @browser @I-14 @unimplemented
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

    @v1 @browser @unimplemented
    Scenario: Back and forward move between visited conversations
      Given the owner opened 41, then 52, then 60
      When the owner presses Cmd+[ twice and then Cmd+]
      Then conversation 52 is open

    @v1 @browser @unimplemented
    Scenario: Cmd+K opens search from anywhere
      When the owner presses Cmd+K in conversation 41
      Then the search box has focus

    @v1 @browser @unimplemented
    Scenario: The question mark opens the shortcut list
      When the owner presses "?"
      Then the "Keyboard shortcuts" dialog lists every key
      And Escape closes it and returns focus where it was
