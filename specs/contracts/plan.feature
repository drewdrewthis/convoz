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

  Rule: An agent that keeps working is asked to keep its plan fresh, so the owner never has to ask
    # Owner (Drew, conv 179, msg 10021): "I feel like I shouldn't have to ask for updates all the time..."
    # Active is 3 posts in the conversation within the last hour, all after the plan's last update; with no plan, the 30 minutes run
    # from the first of those posts, so a few quick answers right after joining ask nothing. One plan ask at a time, and
    # these asks rest an hour after any plan ask in that conversation (a day for a quiet delivery).

    @v1 @api
    Scenario: An agent that keeps posting with a plan 30 minutes old is asked once an hour
      Given "devtool" planned Doing "Building invites"
      When 10 minutes pass and "devtool" posts 3 messages in conversation 41
      Then "devtool" gets no status_due item
      When 21 more minutes pass and "devtool" posts once more
      Then "devtool" gets one status_due item for conversation 41 that says its plan has had no update for 31 min
      When "devtool" acks it and posts 3 more messages
      Then "devtool" gets no status_due item
      When an hour passes and "devtool" posts 3 more messages
      Then "devtool" gets one status_due item

    # Conv 346 and 405: a plan marked --done and a --waiting plan got "no update for 71 min". A plan with nothing in Now, one that waits
    # on the owner and one that is blocked have nothing behind: they wait on someone else, or are finished.
    @v1 @api
    Scenario: A plan that is done, waits on the owner or is blocked is not asked for an update while the agent keeps posting
      Given "devtool" planned Done "Board feed", then in turn Doing "Building invites" with Waiting on you "Approve the deploy", and Doing "Building invites" with Blocked "CI is down"
      When 31 minutes pass after each plan and "devtool" posts 3 messages
      Then "devtool" gets no status_due item

    @v1 @api
    Scenario: An agent with no plan is asked once it has worked in the conversation for 30 minutes
      When "devtool" posts 3 messages in conversation 41, where it has no plan
      Then "devtool" gets no status_due item
      When 31 minutes pass and "devtool" posts once more
      Then "devtool" gets one status_due item that says "You have no plan in conversation 41."

    @v1 @api
    Scenario: A plan with a delivery and no update for a day is asked about once a day
      Given "devtool" planned to deliver "Search filters live" in 5 days, with nothing in Now
      When 23 hours pass
      Then "devtool" gets no status_due item
      When 2 more hours pass
      Then "devtool" gets one status_due item that says "has had no update for 25 h"
      When 2 more hours pass
      Then "devtool" gets no status_due item
      When 23 more hours pass
      Then "devtool" gets one status_due item

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
