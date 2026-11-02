# Source: the feed item design (Convoz conv 179 and conv 486, Drew msg 11663): "a plan is an ordered list of items; one is now, the rest pending",
# and msg 11684: "I don't need caps, don't be defensive prematurely." Slice 1: items, the agent's commands and the owner's actions.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Feed items: one step of an agent's work, from start to done
  As the owner
  I want each step an agent works on, or needs me for, to be one item with one state
  So that I see what is going on and answer in one tap

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are participants of conversation 41 "Ship search filters"

  Rule: An agent moves its steps one call at a time; the first is now and the rest wait

    @v1 @cli
    Scenario: The next step starts by itself when the one now is done
      When "devtool" runs "convoz item start 41 chips 'Reply chip'" and then "convoz item start 41 load 'Faster first load'"
      Then "Reply chip" is started and "Faster first load" is pending
      When "devtool" runs "convoz item done 41 chips 'Shipped'"
      Then "Reply chip" is done and "Faster first load" is started
      And "docs" has its own first step started in conversation 41
