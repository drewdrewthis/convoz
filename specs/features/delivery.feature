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

  Rule: The owner sees every deliverable on one page: what to act on first, then by day

    @v1 @browser
    Scenario: Deliveries shows what is late first, then what waits on the owner, then each day
      Given "devtool" delivers "Search filters live" in 30 minutes and "Reply chip" in 3 days
      And "docs" delivers "Docs refresh live" in 2 days and waits on the owner for "Approve the docs copy"
      When 31 minutes pass
      And "docs" ships "README live"
      And the owner opens Deliveries from the rail on a computer, or from the bottom bar on a phone
      Then the page reads "Shipped today 1 · Late 1" at the top
      And the groups read "Late · 1", "Waiting on you · 1" and "This week · 1", in that order
      And the row "Search filters live" shows the glyph "Late", "Late · 1 min" and "@devtool · Late · was due" its time
      And the row "Docs refresh live" shows the glyph "Waiting on you" and "@docs · Waiting on you"
      And the row "Reply chip" shows "@devtool · On track"
      And on a phone the page does not scroll sideways
      When the owner opens "Shipped today · 1"
      Then it lists "README live" by "@docs"
      When the owner taps the row "Search filters live"
      Then conversation 41 opens

    @v1 @browser
    Scenario: A deliverable whose plan is blocked or a day old shows as at risk
      Given "devtool" delivers "Search filters live" in 3 days
      And "docs" delivers "Docs refresh live" in 3 days and is blocked on "CI is down"
      When the owner opens Deliveries
      Then the row "Docs refresh live" shows the glyph "At risk" and "@docs · At risk · Blocked: CI is down"
      And the row "Search filters live" shows "@devtool · On track"
      When 25 hours pass with no plan update from "devtool" and the owner opens Deliveries again
      Then the row "Search filters live" shows the glyph "At risk" and "no plan update since"
      And it stays in its day group

    @v1 @browser
    Scenario: With no deliverables the page says how they come
      When the owner opens Deliveries
      Then the page says "No deliveries yet. When an agent commits to a date, it shows here."

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
