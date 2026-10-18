# Source: design draft 9 §8.1 (ask state machine, DA-5), I-10…I-13, I-15, I-19, I-24, AC-4, AC-13.
# Kept from the draft-6 spec, reworded: an undeclared choice is refused (was "undeclared action id"),
# a double tap answers once (was "double click"), Done → Dismiss.
# Superseded and dropped: "a threaded reply answers the ask" and "an unthreaded later message answers every
# earlier ask". In draft 8 only the answer command moves an ask out of open; a plain message never does.
# Draft 9: no answer from the CLI (C-3); the same answer twice is a no-op, a losing one is a conflict (C-4);
# snooze only on open asks (C-5); the ask history keeps who dismissed it (C-6).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Asks and their state machine
  As the owner
  I want agents to ask me structured questions with a recommendation and alternatives
  So that I can decide in one tap and the agent gets a clear, final answer

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: An ask has a question, a recommendation and at least one alternative, each with a reason

    @v1 @cli @I-11 @I-16
    Scenario: A complete ask opens
      When "devtool" runs "convoz ask 41 --question 'Merge #415 on its own?' --recommend 'Merge it' --why 'All 11 checks pass' --alt 'Hold it' --alt-why 'Wait for #412'"
      Then the owner sees the ask in Now with "Merge it" marked recommended
      And conversation 41 shows the ask card with both options and their reasons

  Rule: Every transition follows the state table; anything else is a conflict

    @v1 @browser @I-15
    Scenario: The answer is posted where the ask was asked
      Given an ask of "devtool" posted as a reply in thread 900
      When the owner answers "Hold it" from Now
      Then thread 900 shows the answer message "Hold it"
      And the main list of conversation 41 does not

    @v1 @cli @I-12
    Scenario: Undismiss clears the agent's ack
      Given "devtool" acked the dismissal of its ask
      When the owner undismisses the ask and then answers "Merge it"
      Then "devtool" gets a new "ask_resolved" item for that ask
      And the owner no longer sees "Seen by @devtool" until "devtool" acks again

  Rule: Asks close when their asker or their message goes away

    @v1 @api @I-19
    Scenario: Removing the asker closes its open and dismissed asks
      Given "devtool" has an open ask and a dismissed ask in conversation 41
      When the owner removes "devtool" from conversation 41
      Then both asks are "closed (removed)"
      And Now no longer shows them

    @v1 @api @I-38
    Scenario: Disabling the asker closes its asks everywhere
      Given "devtool" has open asks in conversations 41 and 52
      When the owner disables "devtool" with a passkey
      Then both asks are "closed (agent_revoked)"

    @v1 @api
    Scenario: Deleting an open ask message closes the ask
      Given an open ask of "devtool"
      When "devtool" deletes the ask message
      Then the ask is "closed (deleted)"
      And "devtool" gets an "ask_resolved" item

    @v1 @api
    Scenario: Deleting an answered ask keeps the decision
      Given an ask of "devtool" answered with "Merge it"
      When the owner deletes the ask message
      Then the message shows as deleted
      And the ask still shows "Answered · Merge it"

  Rule: Answers are explicit and idempotent

    @v1 @browser
    Scenario: A quick reply answers with custom text
      Given an open ask of "devtool"
      When the owner opens Quick reply on the ask and sends "Split it in two"
      Then the ask shows "Replied · Split it in two"
      And "devtool" gets an "ask_resolved" item with the custom text

    @v1 @browser
    Scenario: An ask has a Reply in thread button
      Given an open ask of "devtool" and an answered ask of "devtool" in conversation 41
      When the owner opens the ask menu in the conversation
      Then the ask menu has no Reply item
      When the owner taps "Reply in thread" on the open ask
      Then the thread of the ask opens and its Reply box has focus
      When the owner taps "Reply in thread" on the ask in Now
      Then conversation 41 opens with the thread of the ask and its Reply box has focus
      And the answered ask has no option buttons and keeps "Reply in thread"

    @v1 @browser
    Scenario: The ask menu opens once
      Given an open ask of "devtool" in conversation 41
      When the owner taps "Ask options" on the ask
      Then one menu opens with "Snooze", "Dismiss", "Copy link", "Pin" and "Delete"
      And the ask has no second "Message actions" button
      And the ask at the top of its own thread has no "Reply in thread" button

    @v1 @browser @I-24 @C-4
    Scenario: A double tap on an option answers once
      Given an open ask of "devtool"
      When the owner taps "Merge it" twice quickly
      Then conversation 41 shows one answer message
      And the second request returns the first result

    @v1 @api
    Scenario: A plain message does not answer an ask
      Given an open ask of "devtool"
      When the owner posts "thinking about it" in conversation 41
      Then the ask is still "open" in Now

    @v1 @browser @I-12 @C-6 @AC-29
    Scenario: The ask history shows who dismissed it
      Given an open ask of "devtool"
      When the owner dismisses it, undismisses it and then answers "Merge it"
      Then the ask's history lists "Dismissed by Drew", "Reopened by Drew" and "Answered by Drew · Merge it" with their times
      And "devtool" sees the same history with "convoz read 41"

  Rule: Snooze is a personal overlay that never changes the ask

    @v1 @api @I-13
    Scenario: Answering removes the snooze
      Given an open ask of "devtool" snoozed by the owner until tomorrow
      When the owner answers it
      Then Now no longer lists it under snoozed

    @later @api @I-13
    Scenario: Snooze is per person
      Given member "mia" can answer asks in conversation 41
      And an open ask of "devtool" snoozed by the owner
      Then member "mia" still sees the ask as open in Now

    @v1 @browser @I-13 @C-5
    Scenario: Only an open ask can be snoozed
      Given an ask of "devtool" that the owner dismissed
      When the owner opens the ask's menu
      Then the menu has no Snooze item
