# Contracts for `features/plan.feature`: protocol and timing checks that pin implementation details. They run end to end like
# every scenario; the user-facing behaviour lives in specs/features/plan.feature.
# Owner (Drew, conv 1, msg 263): "Maybe also the inbox/watch should occassionally ping the agents for a status?"
# Owner (Drew, conv 12, msg 281): "something grabs it and it presents a decision, or it needs an approval, or it gets logged out, or runs
# out of credits. Is there a way you propose to handle that?"

Feature: Plans (contracts)
  The plan route, its limits, the board the web app reads, the nudge timing and the liveness rule.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is a participant of conversation 41 "Ship search filters" and "docs" is not

  Rule: PUT /api/conversations/:id/plan replaces the caller's plan whole

    @v1 @api
    Scenario: The plan route checks who writes and what
      When "devtool" sends PUT /api/conversations/41/plan with doing "Building invites", eta "30m" and next "Reply chip"
      Then the server answers 200 with the plan, its eta 30 minutes after the server clock and its due_at equal to the eta
      And PUT with 6 next items answers 400 with the field "next"
      And PUT with a doing of 201 characters answers 400 with the field "doing"
      And PUT with eta "soon" answers 400 with the field "eta"
      And PUT with step "4/3" answers 400 with the field "step"
      And "docs" gets 403 for the same PUT, as it is not a participant
      And the owner gets 401 for the same PUT, as the route takes only an agent lease
      And GET /api/plans?conversation=41 as the owner lists the plan of "devtool" with the attention "working"

    @v1 @api
    Scenario: A plan with no Doing has no due time and Done keeps 20
      When "devtool" sends 22 plans that each finish one item
      Then the stored plan holds the 20 newest Done items, newest first
      And its due_at is absent

  Rule: The nudge follows the server clock

    @v1 @api
    Scenario: Nudges come 15 minutes after the last update, then once per hour, and stop at 3
      Given "devtool" planned Doing "Building invites" with no eta
      When the server clock moves on and "devtool" claims and acks its status_due item each time
      Then "devtool" gets no status_due item at 14 minutes, one at 16 minutes, none at 46 minutes, one at 1 hour, one at 2 hours and none at 3 hours after the first
      And a new plan starts the count again: none after 14 minutes, one after 16 minutes

    @v1 @api
    Scenario: A plan that is blocked or waits on the owner is not nudged
      Given "devtool" planned Doing "Building invites" and Waiting on you "Approve the deploy"
      When 3 hours pass
      Then "devtool" gets no status_due item
      When "devtool" plans Doing "Building invites" and Blocked "CI is down" and 3 hours pass
      Then "devtool" gets no status_due item

  Rule: An agent with a message waiting 10 minutes and no live watch is not responding

    @v1 @api
    Scenario: The liveness of an agent follows its watch, its acks and its session
      Given the owner sent "Is the build green?" in conversation 41
      When the server clock moves 10 minutes
      Then GET /api/plans?conversation=41 gives "devtool" the liveness "not_responding" and the conversation the attention "not_responding"
      And conversation 41 holds one system line "agent.unresponsive" for "devtool"
      When "devtool" holds a long poll of its inbox
      Then the liveness of "devtool" is "ok"
      When the owner revokes the key of machine "box-2"
      Then the liveness of "devtool" is "logged_out"
