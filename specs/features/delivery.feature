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

  Rule: Work shows every plan, in the highest section that applies, and stays current without a button
    # Owner (Drew, conv 179): one screen with, in a hierarchy, what needs him, what is blocked, what is in work and what is planned,
    # current without pressing Request update. "Deliverables are ALL plans, not a separate thing." A row opens the plan in its chat.
    # Design (ux-designer): Deliveries is renamed Work (/work; /delivery opens it). One row per chat and agent, in the first section that
    # applies: Needs you (an open ask or a Waiting item) > Blocked or late (blocked, a delivery date passed, the agent logged out or not
    # responding) > In progress (a Now item) > Planned (Next or a deliverable only). Then "Done today", folded. A stale chat is hidden from
    # In progress and Planned behind "N stale chats hidden · Show", but still shows when it needs the owner.

    @v1 @browser
    Scenario: Work puts each plan in the highest section that applies
      Given "devtool" is doing "Filter chips" at step 2 of 5, ready in 2 hours, and delivers "Search filters live" in 3 days
      And "docs" is doing "Docs pass" in conversation 42 and waits on the owner for "Approve the docs copy"
      And "devtool" is doing "Deploy preview" in conversation 43 "Blocked one" and is blocked on "CI is down"
      And "devtool" delivers "Release notes" in 30 minutes in conversation 44 "Late one"
      And "devtool" has only "Write the changelog" next in conversation 45 "Next only"
      And "devtool" is doing "Closed work" in conversation 46 "Closed one", which the owner closed
      And "devtool" waits on the owner for "Pick a name" in conversation 47 "Old ask", which the owner closed
      And "devtool" finished "Old work" in conversation 48 "Wrapped up"
      When 31 minutes pass
      And the owner opens Work from the rail on a computer, or from the bottom bar on a phone
      Then the page reads "Live · Convoz asks agents when a plan is late" at the top
      And the sections read "Needs you · 2", "Blocked or late · 2", "In progress · 1" and "Planned · 1", in that order
      And "Needs you" holds "Docs refresh" with "@docs" and "Approve the docs copy", and "Old ask" with "Pick a name"
      And "Blocked or late" holds "Blocked one" with "Blocked: CI is down" and "Late one" with "Late: Release notes"
      And "In progress" holds "Ship search filters" with "@devtool", "Filter chips", "Step 2 of 5", a due chip and "updated 31 min ago"
      And "Planned" holds "Next only" with "Write the changelog"
      And no row has "Request update"
      And no row comes from "Closed one", and the page says "1 stale chat hidden · Show"
      And on a phone the page does not scroll sideways and each row is two lines
      When the owner taps "Show"
      Then "In progress" holds "Closed one"
      When the owner opens "Done today · 1"
      Then it lists "Old work" by "@devtool"

    @v1 @browser
    Scenario: A Work row opens its chat on that agent's plan, with what it waits on and delivers
      Given "devtool" is doing "Filter chips" in conversation 41, waits on the owner for "Approve the copy" and delivers "Search filters live" in 3 days
      When the owner opens Work and taps the row "Ship search filters"
      Then conversation 41 opens with the details on the plan card of "@devtool"
      And the card shows "Waiting on you: Approve the copy" and "Delivers: Search filters live" with its due date

    @v1 @browser
    Scenario: With no plans Work says how they come, and an old Deliveries link opens Work
      When the owner opens /delivery
      Then the address is /work and the page is "Work"
      And the page says "Nothing in progress. When an agent sets a plan, it shows here."

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
      When the owner taps "See all work"
      Then Work opens
      When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 2h"
      And the owner opens Now
      Then Now shows no "Overdue" group
