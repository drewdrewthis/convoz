# Source: the owner's plan and status design (mini app "Details panel design", approved; the plan card was chosen in ask 90).
# Owner (Drew, conv 2, msg 100, voice): "Also, I think that becomes a really nice UI for the conversations list. So I can see which
# conversations are working, right? Like, should be doing something. The expectation is then, yeah, okay, this conversation, there's
# one reply, but the agent is actively trying to do something and I should expect another reply soon."
# Owner (Drew, conv 1, msg 260): "Remember we were talking about plans/expectations?"
# Owner (Drew, conv 1, msg 263): "What ever happened to that? there should probably be indicators on the conversation list showing that
# so I know things are active or not. Maybe also the inbox/watch should occassionally ping the agents for a status?"
# Owner (Drew, conv 2, msg 382): "yes, it's mostly approved. but on the sidebar I dn't want the avatar spot, just a little icon next to the
# count that represents something."
# Owner (Drew, conv 12, msg 281): "some times something happens on the agent's actually running thing on their server -- something grabs
# it and it presents a decision, or it needs an approval, or it gets logged out, or runs out of credits. Is there a way you propose to
# handle that?"
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Plans: what each agent is doing, what is next and what waits on the owner
  As the owner
  I want each conversation to say what its agents are doing, when to expect them and what waits on me
  So that I know which conversations are active, and an agent that went quiet is noticed

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are participants of conversation 41 "Ship search filters"

  Rule: An agent keeps one plan per conversation, replaced whole by one command

    @v1 @cli
    Scenario: An agent sets its plan with one command
      When "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m --next 'Reply chip' --next 'Faster first load' --waiting 'Approve the dot card'"
      Then the command prints the plan with "Doing: Building invites", "Next: Reply chip" and "Waiting on you: Approve the dot card"
      And Crew shows "devtool" as "working" with "Building invites"
      When "devtool" runs "convoz plan 41 --doing 'Reply chip' --done 'Building invites'"
      Then the plan of "devtool" in conversation 41 is Doing "Reply chip", no Next, nothing waiting and Done "Building invites"
      And the plan of "docs" in conversation 41 is still empty

    @v1 @cli
    Scenario: A plan keeps its limits
      When "devtool" runs "convoz plan 41" with 6 "--next" items
      Then it exits 2 and says "--next is at most 5 items"
      When "devtool" finishes 5 items one plan at a time
      Then the plan of "devtool" in conversation 41 keeps all 5 Done items, newest first

    @v1 @mcp
    Scenario: An agent sets its plan with the plan tool
      When "devtool" calls the MCP tool "plan" with conversation 41, doing "Building invites" and next "Reply chip"
      Then the tool answers with the plan
      And the plan of "devtool" in conversation 41 is Doing "Building invites" and Next "Reply chip"

    # Owner (Drew), msg 659, quoting an agent: "Yes, in parallel. An agent is fixing #8675's 4 review findings right now, while another
    # works on #8798. The plan tool allows only one 'Now' item, so #8675 shows as next." An agent that works in parallel lists up to 3.
    @v1 @cli
    Scenario: An agent working in parallel shows up to 3 Now items, each with its own estimate
      When "devtool" runs "convoz plan 41 --doing 'Fix #8675 findings' --eta 30m --step 1/4 --doing 'Build #8798' --eta 2h"
      Then the command prints both Now items, the first with "step 1 of 4"
      And the plan of "devtool" in conversation 41 has 2 Now items, each with its own estimate
      And the line under the title reads the first item
      When 31 minutes pass with no update
      Then the plan is late by the first item, and the line shows it with "+1"
      And the nudge to "devtool" names "Fix #8675 findings"

    @v1 @mcp
    Scenario: The plan tool takes up to 3 Now items, each with its own estimate
      When "devtool" calls the MCP tool "plan" with conversation 41 and doing a list of "Fix #8675 findings" ready in 30 minutes and "Build #8798" ready in 2 hours
      Then the plan of "devtool" in conversation 41 has those 2 Now items, each with its own estimate
      When "devtool" calls the MCP tool "plan" with doing as the single text "Build #8798"
      Then the plan of "devtool" in conversation 41 has 1 Now item "Build #8798"

    @v1 @cli
    Scenario: A fourth --doing is refused with a clear message
      When "devtool" runs "convoz plan 41" with 4 "--doing" items
      Then it exits 2 and says "--doing is at most 3 items"
      When "devtool" runs "convoz plan 41 --eta 30m"
      Then it exits 2 and says "--eta needs a --doing before it"

  Rule: One line under the title shows the most urgent state across the agents

    @v1 @browser
    Scenario Outline: The line under the title shows the most urgent state
      Given <devtool> and <docs>
      When the owner opens conversation 41
      Then the line under the title reads "<line>" with a <tone> dot

      Examples:
        | devtool                                                            | docs                                   | line                                    | tone  |
        | "devtool" works on "Building invites" ready in 30 minutes          | "docs" has finished "Write the README"   | Working · Building invites · ready ~HH:MM | green |
        | "devtool" has finished "One-time invites" and plans nothing more   | "docs" has no plan                      | Done · nothing planned                  | grey  |
        | "devtool" was due 30 minutes ago with no update                    | "docs" works on "Docs" ready in 1 hour  | Late · was due HH:MM                    | amber |
        | "devtool" works on "Building invites" and is blocked on "needs Tailscale ACL change" | "docs" was due 30 minutes ago | Blocked: needs Tailscale ACL change | red   |
        | "devtool" waits on the owner for "Approve the dot card"           | "docs" is blocked on "a missing key"    | Waiting on you: Approve the dot card    | amber |

    @v1 @browser
    Scenario: Times show in the owner's time zone with "~" for an estimate
      Given the owner's browser is in the time zone "Pacific/Auckland"
      And "devtool" works on "Building invites" ready in 30 minutes
      When the owner opens conversation 41
      Then the line reads "Working · Building invites · ready ~" and the time of the ready estimate in "Pacific/Auckland"

  Rule: Tapping the line opens the details panel: what waits on the owner, then one card per agent, then the settings

    # Owner (Drew), on the panel design: "approved with comments: panel: hmm, it's a good start. you could probably as the UI/UX expert
    # about this". The UX pass (phase 1) is what is built: Waiting on you with the action in place, Agents with Now, Next and Done folded.
    @v1 @browser
    Scenario: The details panel puts what waits on the owner first, then each agent's plan, then the settings
      Given "devtool" finished "One-time invites", "Reply chip v0", "Invite page", "Rename sheet" and "Search fix"
      And "devtool" planned Doing "Switch on the internet door" at step 2 of 3 ready in 15 minutes, Next "Reply chip" and "Faster first load", Waiting on you "Paste the prompt to dot"
      When the owner opens conversation 41 and taps the line under the title
      Then the panel shows "Waiting on you · 1", then "Agents · 2", then "Conversation", in that order
      And "Paste the prompt to dot" shows "I did it" and "Reply" and no "Open", as it has no link
      And the card of "@devtool" shows "Working", Now "Switch on the internet door" with a step bar at 2 of 3 and "ready ~", and Next "Reply chip" and "Faster first load" numbered
      And its Done items are folded as "Done · 5"
      When the owner taps "Done · 5"
      Then all 5 Done items show under "Today"
      And the card of "@docs" shows "No plan yet" and "Ask for a plan"
      When the owner taps "I did it"
      Then the chat shows the owner's message "@devtool I did it: Paste the prompt to dot"
      And the item shows "You said it is done" until "devtool" updates its plan
      And at 320 pixels wide the panel has no sideways scroll and every button is at least 44 pixels tall

    # Owner (Drew), msg 594: "The asking for a plan button is nice -- however, it' just posts a message asing for a plan, but no
    # instructions. It can probably do  abetter job for that?" An agent answered with its plan as a chat message, so the panel stayed empty.
    @v1 @browser
    Scenario: Ask for a plan tells the agent the command that sets it
      Given "docs" has no plan in conversation 41
      When the owner opens the details of conversation 41 and taps "Ask for a plan" on the card of "@docs"
      Then the chat shows the owner's message to "@docs" with "convoz plan 41 --doing" and "not a chat message"
      And it names the MCP "plan" tool and "convoz plan --help"

    # Owner (Drew), msg 646: "improve the UI on this card". The header keeps the name, the state and the age; Remove is in a menu; Now is
    # one tinted block, with the step as a small bar; Next is quieter; Done is a plain fold row.
    @v1 @browser
    Scenario: The plan card puts Remove in a menu and shows the step as a bar
      Given "devtool" finished "One-time invites" and planned Doing "Switch on the internet door" at step 2 of 3 ready in 15 minutes and Next "Reply chip"
      When the owner opens the details of conversation 41
      Then the card of "@devtool" shows "Working", "updated" and a menu button, and no "Remove" button
      And Now shows "Switch on the internet door" with a step bar at 2 of 3 and "ready ~"
      When the owner opens the menu and taps "Remove"
      Then "@devtool" is removed at once and a toast offers Undo, as before
      And at 320 pixels wide the panel has no sideways scroll and every button is at least 44 pixels tall

    # Owner (Drew), msg 659: each parallel Now item is its own block with its own step bar and estimate.
    @v1 @browser
    Scenario: The card and the line show each parallel Now item with its own estimate
      Given "devtool" planned Doing "Fix #8675 findings" at step 1 of 4 ready in 30 minutes and Doing "Build #8798" ready in 2 hours
      When the owner opens conversation 41
      Then the line under the title reads "Working · Fix #8675 findings" with "+1"
      When the owner taps the line
      Then the card of "@devtool" shows two Now blocks, each with its own "ready ~", and the step bar only on the first

    @v1 @browser
    Scenario: The panel says when an agent is late or blocked
      Given "devtool" planned Doing "Building invites" ready in 30 minutes, and 31 minutes passed with no update
      And "docs" planned Doing "Docs" and is blocked on "needs Tailscale ACL change"
      When the owner opens conversation 41 and taps the line under the title
      Then the card of "@devtool" shows "Late", "Was due" and "Ask for an update"
      And the card of "@docs" shows "Blocked" and "Blocked: needs Tailscale ACL change"

  Rule: Each row of the Conversations list shows a small status icon next to its count

    # Owner (Drew, conv 2, msg 382): "yes, it's mostly approved. but on the sidebar I dn't want the avatar spot, just a little icon next to
    # the count that represents something."
    @v1 @browser @I-21
    Scenario: Each conversation row shows a status icon next to its count and the list never reorders
      Given conversations "Working one", "Waiting one", "Blocked one" and "Quiet one" with "devtool"
      And "devtool" works on "Building invites" in "Working one", waits on the owner in "Waiting one" and is blocked in "Blocked one"
      And "devtool" posted in "Working one", so it has an unread count
      When the owner opens the Conversations list
      Then "Working one" shows a green icon named "Working", right of its title, next to its count and as tall as it
      And "Waiting one" shows an amber icon named "Waiting on you"
      And "Blocked one" shows a red icon named "Blocked"
      And "Quiet one" shows no icon
      And no row has an avatar
      And the rows keep their order

  Rule: Updates come live; only something new that waits on the owner pushes

    # Owner (Drew), msg 632: "not sure what this little text is? is that the plan? or status update? it can probably be clearer/better UI".
    # The plan update is one muted row: a plan icon, "@handle updated its plan", "Now: ..." cut to one line and, when something waits, a
    # "Waiting on you · n" pill. Tapping the row opens Done, Now, Next and Waiting as short labelled lines.
    @v1 @browser
    Scenario: A plan update in the chat is one quiet row that expands
      Given "devtool" works on "One-time invites" and the owner has conversation 41 open
      When "devtool" runs "convoz plan 41 --done 'One-time invites' --doing 'Switch on the internet door' --waiting 'Approve the dot card'"
      Then the chat shows one row "@devtool updated its plan" with "Now: Switch on the internet door" and the pill "Waiting on you · 1"
      And the row is collapsed and shows no "Done:" line
      When the owner taps the row
      Then it shows the labelled lines "Done" "One-time invites", "Now" "Switch on the internet door" and "Waiting" "Approve the dot card"
      When the owner taps the pill "Waiting on you · 1"
      Then the details panel opens

    @v1 @browser
    Scenario: The line and the panel update live, and a quiet line marks a finished item
      Given the owner has conversation 41 open and "devtool" works on "One-time invites"
      When "devtool" runs "convoz plan 41 --done 'One-time invites' --doing 'Switch on the internet door' --eta 20m"
      Then the line under the title reads "Working · Switch on the internet door" without a reload
      And the chat shows the quiet row "@devtool updated its plan" with "Now: Switch on the internet door"
      When "devtool" only moves its ready time to 40 minutes
      Then the line shows the new time and no new quiet line appears

    @v1 @api
    Scenario Outline: Only something new that waits on the owner pushes
      Given the owner's browser has a push subscription to the fake push service
      And "devtool" works on "Building invites" ready in 30 minutes
      When <change>
      Then <pushes>

      Examples:
        | change                                                    | pushes                                                         |
        | "devtool" adds "Approve the dot card" to Waiting on you   | the fake push service receives one push with the reason "plan_waiting" |
        | "devtool" finishes "Building invites"                     | the fake push service receives nothing                         |
        | "devtool" moves its ready time to 1 hour                  | the fake push service receives nothing                         |

  Rule: An agent that goes quiet is nudged, and the owner sees it without a push

    @v1 @cli
    Scenario: A late agent is nudged once to update its plan, and the owner is not pushed
      Given "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m"
      When 31 minutes pass with no plan or status update from "devtool"
      Then the line of conversation 41 is "Late"
      And "convoz inbox" of "devtool" gives one item with the reason "status_due" for conversation 41 that asks it to update its plan
      And the owner gets no push
      When "devtool" acks it and 10 more minutes pass
      Then "devtool" gets no second nudge
      When 2 more hours pass
      Then "devtool" gets one more "status_due" item
      When "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m"
      Then the line of conversation 41 is "Working" again

    @v1 @cli
    Scenario: A working agent with no update for 2 hours is nudged
      Given "devtool" runs "convoz plan 41 --doing 'Building invites'"
      When 2 hours and 1 minute pass with no update from "devtool"
      Then the line of conversation 41 reads "Building invites · no update for 2 h"
      And "convoz inbox" of "devtool" gives one item with the reason "status_due" for conversation 41

    @v1 @browser
    Scenario: An agent that does not pick up a message shows as not responding
      Given "devtool" has a live session but does not run "convoz watch"
      And the owner has conversation 41 open
      When the owner sends "Is the build green?" and 10 minutes pass
      Then the line under the title reads "Not responding · last seen" in amber
      And the chat shows the quiet line "@devtool is not responding" once
      And the Conversations list shows an amber icon named "Not responding" for conversation 41
      And the owner gets no push for it
      When "devtool" starts "convoz watch"
      Then the line no longer says "Not responding"

    @v1 @browser
    Scenario: An agent whose machine key was revoked shows as logged out
      Given the owner sent "Is the build green?" in conversation 41
      When the owner revokes the key of machine "box-2" and 10 minutes pass
      Then the line under the title of conversation 41 reads "Logged out" in amber
