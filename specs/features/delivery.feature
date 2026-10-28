# Source: the owner's ask (Drew, conv 179, msg 9734): "my biggest stress is trying to know what everything is working on and when things
# will be delivered. Per conversation plans and status is nice, but maybe a global one with the reminders when due dates p[ass]".
# Design: @langwatch-assistant's proposal (conv 179, msg 9739), and the ux-designer's layout for the Deliveries page (desktop and phone).
# A deliverable is a promise with a date, not a 30-minute step: it stays on the plan until the agent ships it. "Late" means a missed
# delivery date; a plan step past its estimate reads "Behind" (plan.feature).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Deliveries: what each agent will deliver, and when
  As the owner
  I want one page with every promised delivery and its date
  So that I know when things will be delivered, and a missed date is chased without me

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is a participant of conversation 41 "Ship search filters" and "docs" of conversation 42 "Docs refresh"

  Rule: An agent names what it will deliver and by when, and it stays until it ships

    @v1 @cli
    Scenario: An agent sets a deliverable with a due date, and it stays until it ships
      When "devtool" runs "convoz plan 41 --doing 'Filter chips' --eta 30m --deliver 'Search filters live' --due 2d"
      Then the command prints "Deliver: Search filters live · due" and the date 2 days from now
      When "devtool" runs "convoz plan 41 --doing 'Reply chip'"
      Then the owner's deliveries still list "Search filters live" for "devtool" in "Ship search filters", on track
      When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 3d"
      Then the owner's deliveries list "Search filters live" once, due 3 days from now
      When "devtool" runs "convoz plan 41 --done 'Search filters live'"
      Then the owner's deliveries no longer list it, and list it as shipped

  Rule: The owner sees every agent's current plan on one page, the most urgent first, and asks for an update right there
    # Owner (Drew, conv 179, msg 9982): "The deliveries should show all the plans with the ability to request the updates right there."
    # One row per plan (agent and conversation). A plan with only finished items, or in a closed or trashed conversation, is left out.

    @v1 @browser
    Scenario: Deliveries lists every agent's current plan, the most urgent first
      Given "devtool" is doing "Filter chips" at step 2 of 5 and delivers "Search filters live" in 30 minutes and "Reply chip" in 3 days
      And "docs" is doing "Docs pass" in conversation 42 and waits on the owner for "Approve the docs copy"
      And "devtool" is doing "Deploy preview" in conversation 43 "Blocked one" and is blocked on "CI is down"
      And "devtool" has only finished items in conversation 44 "Wrapped up"
      And "devtool" has a plan in conversation 45 "Closed one", which the owner closed, and in conversation 46 "Thrown away", which is in the trash
      When 31 minutes pass
      And "docs" ships "README live"
      And the owner opens Deliveries from the rail on a computer, or from the bottom bar on a phone
      Then the page reads "Shipped today 1 · Late 1" at the top
      And the groups read "Late · 1", "Waiting on you · 1" and "Blocked · 1", in that order
      And the row "Filter chips" shows the glyph "Late", "Late · 1 min" and "@devtool · Late · Ship search filters", and is open
      And open, it shows "Step 2 of 5", "Search filters live", "Reply chip", "Request update" and "Open chat"
      And the row "Docs pass" shows the glyph "Waiting on you" and "@docs · Waiting on you · Docs refresh", and is closed
      And the row "Deploy preview" shows the glyph "Blocked" and "@devtool · Blocked: CI is down", and is open
      And no row comes from "Wrapped up", "Closed one" or "Thrown away"
      And on a phone the page does not scroll sideways
      When the owner opens "Shipped today · 1"
      Then it lists "README live" by "@docs"
      When the owner taps "Open chat" on the row "Filter chips"
      Then conversation 41 opens

    @v1 @browser
    Scenario: Request update on a plan asks its agent in that conversation
      Given "devtool" is doing "Filter chips" in conversation 41, ready in 30 minutes
      When the owner opens Deliveries
      Then the row "Filter chips" is under "No date · 1", reads "updated just now" and is closed
      When the owner opens the row
      Then on a phone "Request update" and "Open chat" are full width, one above the other, and 44 px tall
      When the owner taps "Request update"
      Then the button reads "Requested" and cannot be pressed, and the row says "Requested" with its time and "no update yet"
      And "devtool" has an inbox item for conversation 41 whose message starts "@devtool, please update your plan"
      When "devtool" runs "convoz plan 41 --doing 'Filter chips' --step 3/5"
      Then the row says "Updated" with its time, and "Request update" can be pressed again

    @v1 @browser
    Scenario: A plan with no update for a day shows as at risk
      Given "devtool" delivers "Search filters live" in 3 days
      When the owner opens Deliveries
      Then the row "Search filters live" is under "This week · 1" and shows "@devtool · On track · Ship search filters"
      When 25 hours pass with no plan update from "devtool" and the owner opens Deliveries again
      Then the row "Search filters live" is under "At risk · 1" and shows the glyph "At risk" and "@devtool · At risk · Ship search filters"

    @v1 @browser
    Scenario: With no plans the page says how they come
      When the owner opens Deliveries
      Then the page says "No plans yet. When an agent sets a plan in a chat, it shows here."

  Rule: When a due date passes, the agent is asked first, once per date, and the owner sees it on Now without a push

    @v1 @cli
    Scenario: When a due date passes, the agent is asked once: done, new date, or blocked
      Given "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 1h"
      When 61 minutes pass
      Then "convoz inbox" of "devtool" gives one item with the reason "status_due" for conversation 41
      And its message names "Search filters live" and asks "done, new date, or blocked?"
      And the owner gets no push
      When "devtool" acks it and 3 more hours pass
      Then "devtool" gets no second item
      When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 2h" and 121 minutes pass
      Then "devtool" gets one more "status_due" item that names "Search filters live"

    @v1 @cli
    Scenario: A late step and a late delivery each ask once, with their own text
      Given "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m --deliver 'Search filters live' --due 1h"
      When 31 minutes pass
      Then "devtool" gets one "status_due" item that names "Building invites" and does not ask about the delivery
      When the due date passes while that item is not acked
      Then the same item still reads about the step
      When "devtool" acks it
      Then "devtool" gets one "status_due" item that asks "done, new date, or blocked?" about "Search filters live"
      When "devtool" acks it and 90 minutes pass
      Then no item asks about the delivery again

    @v1 @browser
    Scenario: Now lists late deliverables under Overdue until the agent gives a new date
      Given "devtool" delivers "Search filters live" in 30 minutes
      When 31 minutes pass and the owner opens Now
      Then Now shows "Overdue · 1" with "Search filters live" and "@devtool · was due" its time
      And it does not say "All clear", and the Now badge does not count it
      When the owner taps "See all deliveries"
      Then Deliveries opens
      When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 2h"
      And the owner opens Now
      Then Now shows no "Overdue" group
