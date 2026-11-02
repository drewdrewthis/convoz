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

    @v1 @cli @I-11
    Scenario: A complete ask opens
      When "devtool" runs "convoz ask 41 --question 'Merge #415 on its own?' --recommend 'Merge it' --why 'All 11 checks pass' --alt 'Hold it' --alt-why 'Wait for #412' --owners-call taste --owners-call-why 'Both names read fine; it is your voice'"
      Then the owner sees the ask in Now with "Merge it" marked recommended
      And conversation 41 shows the ask card with both options and their reasons

  Rule: An ask must say why it is the owner's call, or the agent decides it itself

    @v1 @cli
    Scenario: An ask without a reason it is the owner's call is refused and tells the agent to decide
      When "devtool" runs "convoz ask 41 --question 'Merge #415 on its own?' --recommend 'Merge it' --why 'All 11 checks pass' --alt 'Hold it' --alt-why 'Wait for #412'"
      Then the command exits 2 and tells "devtool" to decide this itself and to ask only for a one-way door, a taste or values choice, or scope
      And the owner sees no ask in Now

    @v1 @browser
    Scenario: An ask from before this rule shows no owner's call line
      Given an open ask of "devtool" that has no reason it is the owner's call
      When the owner opens Now
      Then the card shows no "Your call" line

  Rule: Every transition follows the state table; anything else is a conflict

    @v1 @browser @I-15
    Scenario: The answer is posted where the ask was asked
      Given an ask of "devtool" posted as a reply in thread 900
      When the owner presses "Okay" on it in Now
      Then thread 900 shows the answer message "Merge it"
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
    Scenario: An ask has a Reply button
      Given an open ask of "devtool" and an answered ask of "devtool" in conversation 41
      When the owner opens the item menu of the ask in the conversation
      Then the menu has no Reply item
      When the owner taps "Reply" on the open ask
      Then the thread of the ask opens and its Reply box has focus
      When the owner taps "Reply" on the ask in Now
      Then the thread opens inside the ask in Now and its reply box has focus
      And the answered ask in the conversation has no "Okay" and no "Reply"

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: An ask in a conversation shows how many replies it has
      Given an open ask of "devtool" in conversation 41 and "docs" replied in its thread
      When the owner opens conversation 41
      Then the ask, with its "Okay" and "Reply", shows "1 reply"

    @v1 @browser
    Scenario: The ask menu opens once
      Given an open ask of "devtool" in conversation 41
      When the owner taps "Item actions" on the ask
      Then one menu opens with "Pin", "Copy link" and "Delete"
      And the ask has no second "Message actions" button
      And the thread under the ask does not draw the ask again

    @v1 @browser @I-24 @C-4
    Scenario: A double tap on Okay answers once
      Given an open ask of "devtool"
      When the owner taps "Okay" twice quickly
      Then conversation 41 shows one answer message
      And the second request returns the first result

    @v1 @api
    Scenario: A plain message does not answer an ask
      Given an open ask of "devtool"
      When the owner posts "thinking about it" in conversation 41
      Then the ask is still "open" in Now

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
      Given an ask of "devtool" that the owner dismissed, and an open ask of "devtool"
      When the owner opens the conversation
      Then the open ask offers "Snooze" and the dismissed ask does not

  Rule: An app on an ask shows on its card

    @v1 @browser
    Scenario: An app on an ask shows on its card in Now and in the conversation
      Given "devtool" asked in conversation 41 with a "Tokens per day" chart app attached
      When the owner opens Now
      Then the card of the ask shows the chart "Tokens per day"
      And conversation 41 shows the same chart on the card of the ask

  # Drew, conv 37 msg 928: "a withdrawn ask still shows open in Drew's UI" (the server restarted in the same minute).
  Rule: A withdrawn ask closes on every open page, even when the stream was cut meanwhile

    @v1 @browser
    Scenario: A withdrawn ask leaves Now and its card shows closed at once
      Given an open ask of "devtool", and the owner has the conversation and Now open in two pages
      When "devtool" withdraws the ask
      Then Now no longer lists it and the card in the conversation shows closed, with no reload

    @v1 @browser
    Scenario: After the stream was cut, an ask withdrawn meanwhile shows closed with no reload
      Given an open ask of "devtool" on the page of its conversation
      And the stream is cut
      When "devtool" withdraws the ask and the page reconnects
      Then the card shows closed with no reload

  # Drew, conv 1 msg 1006: "Snooze ui is janked on mobile. Replying to a feed item should dismiss it and the agent should have to ask it again"
  Rule: Snooze opens as a bottom sheet on a phone and covers no button of the card

    @v1 @browser @phone
    Scenario: Snoozing on a phone opens a sheet that covers no button
      Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
      And the owner opens Now on a phone
      When the owner taps "Snooze" on the card
      Then a sheet with "1 hour", "Tomorrow" and "Cancel" opens at the bottom of the screen
      And the sheet covers no button of the card
      And the sheet is shown in dark and in light
      When the owner taps outside the sheet
      Then the sheet closes
      When the owner taps "Snooze" and then "Cancel"
      Then the sheet closes and the ask is still in Now
      When the owner taps "Snooze" and then "1 hour"
      Then the sheet closes and Now no longer lists the ask

  # Owner said (msg 1117): "the feed items are sometimes like you know they don't really give me the context that I need. And while opening things in a new thread, like responding in a thread is relatively easy, it fails to consider that as a user flow, right? It's like, okay, I've opened it as a thing, and now it's like basically just delegates to a new thread, but then the item still stays there. It doesn't show that I've responded. The conversation kind of doesn't continue in the same way, right?"
  # Owner said (msg 1131): "update this ask so it has all of my QA answered ... that's the way to do it."
  Rule: A reply to an ask is a question: the ask stays open, the agent answers in the thread and updates the same ask

    @v1 @browser
    Scenario: Replying to an ask keeps it open and moves it to You replied
      Given an open ask of "devtool", and the owner has the conversation and Now open in two pages
      When the owner replies to the ask in its thread
      Then Now no longer lists it in the main list but under "You replied · waiting on the agent", with no reload
      And the card in the conversation still offers "Okay" and "Reply"

    # Owner said (conv 179 msg 7988): "Show expandable thread in feed item directly".
    @v1 @browser
    Scenario: An ask in Now with replies opens its thread in place and folds it again
      Given an open ask of "devtool" with the reply "Both fit; the smaller one is safer." from "docs" in its thread
      When the owner opens Now with the mention and reply cards turned on
      Then the ask card offers "Show thread" with 1 reply
      When the owner opens the thread of the card
      Then the card shows the reply "Both fit; the smaller one is safer." and the page is still Now
      When the owner folds the thread of the card
      Then the reply is no longer shown
      And the "Replies to you" card of a conversation whose thread answered the owner opens that thread in place the same way, with the reply's markdown drawn

    # Owner said (conv 179 msg 8087): "They should be part of the same card".
    @v1 @browser
    Scenario: The thread of a feed card sits inside the card
      Given an open ask of "devtool" with the reply "Both fit; the smaller one is safer." from "docs" in its thread
      When the owner opens Now with the mention and reply cards turned on
      Then the "Show thread" button is inside the ask card
      When the owner opens the thread of the card
      Then the reply "Both fit; the smaller one is safer." is inside the ask card
      And every reply button and input of the ask card comes after the last reply of its thread
      When the owner folds the thread of the card
      Then the reply is no longer shown
      And the "Replies to you" card of a conversation whose thread answered the owner holds its thread inside its box the same way, with its Reply and Mark read buttons after the thread

    # Owner said (conv 179 msg 8239): "When I respond or reply or have comments on feed items they just stay there unchanged. It's crap".
    @v1 @browser
    Scenario: A reply typed in the thread of an ask card moves the ask to You replied
      Given an open ask of "devtool" with a reply from "docs" in its thread
      When the owner opens Now and the thread of the card, and sends "Use the smaller one" with Reply here
      Then the ask leaves the main list and "You replied · waiting on the agent" lists it with "Use the smaller one"
      And a toast says the ask moved to You replied
      And the badge no longer counts the ask

    @v1 @browser
    Scenario: A reply typed in the thread of a Replies to you card marks it read and takes it out
      Given "docs" answered the owner in a thread of conversation "Deploy log"
      When the owner opens Now with the mention and reply cards turned on, opens the thread of the card, and sends "Thanks" with Reply here
      Then the card leaves "Replies to you" and a toast says it was marked read
      And after a reload the card is still gone

    @v1 @browser
    Scenario: Okay on a permission ask says where the ask went
      Given an open permission ask of "devtool" in Now
      When the owner taps "Okay"
      Then the ask leaves the main list, "Answered today" lists it, and a toast says it moved to Answered today

    # Owner said (conv 379 msg 6722): "why couldn't I quick reply on that ask?" (an ask inside a thread).
    @v1 @browser
    Scenario: An ask inside a thread has Okay and Reply too
      Given "devtool" asks inside the thread of its message "Step 1 is the chips UI"
      When the owner opens the conversation
      Then the ask card in the thread offers "Okay" and "Reply"
      When the owner presses "Okay"
      Then the ask is answered with "Merge it" and the card shows it in one line

    @v1 @cli
    Scenario: An agent's reply does not close an ask
      Given an open ask of "devtool"
      When "docs" replies in the thread of the ask
      And "devtool" replies in the thread of the ask
      Then the ask is still open

    @v1 @cli
    Scenario: An agent is told to answer in the thread and send the updated ask there
      Given an open ask of "devtool" that the owner then snoozed
      When the owner replies in the thread of the ask
      Then the ask is still open and records the reply and its message
      And the history of the ask has an "owner_replied" row
      And "devtool" reads in its inbox and in its watch: "@owner replied in the thread of your ask: answer there, then update the same ask with `convoz ask --update <id> --answers ...` (do not send a new ask)."

    @v1 @cli
    Scenario: The agent updates the ask in place with the answers
      Given an open ask of "devtool" that the owner replied to
      When "devtool" runs "convoz ask --update" with a new question, new options and a summary of its answers
      Then it is the same ask, still open, with the new question and options, the summary, the version moved and an "updated" row in its history
      And the owner's reply mark is gone and the ask is in the main list of Now, not under "You replied"
      And no new ask was made and "devtool" has the same number of open asks

    @v1 @cli
    Scenario: An update needs the answers, the asker and an open ask
      Given an open ask of "devtool" that the owner replied to
      When "devtool" updates it without answers
      Then the update is refused and names the field "answers"
      When "docs" updates it
      Then the update is refused
      When the owner dismisses the ask and "devtool" updates it
      Then the update is refused as a conflict

    @v1 @cli
    Scenario: The rules tell an agent to pre-answer the owner's obvious questions
      When an agent reads "convoz rules"
      Then the rules say to answer the owner's obvious questions in the ask and name feature flag, reviewer, number of PRs, review bot and QA
      And the rules say to answer questions asked in the ask's thread and update the same ask with "convoz ask --update"

    @v1 @browser
    Scenario: The updated ask shows in Now with the answers, and leaves You replied
      Given an open ask of "devtool" that the owner replied to, and the owner has the conversation and Now open in two pages
      When "devtool" updates the ask with its answers
      Then Now lists the ask in the main list, titled by the new question, with the answers in full
      And the ask is no longer under "You replied"
      And the card in the conversation shows the same

  # Drew, conv 32 msg 650: "ship a standard 'review a draft' mini app with Convoz, so agents don't hand-build one for every message
  # they draft for him. It shows the original message being answered (who, where, text) and the agent's draft in an editable box, with
  # Send and Don't send buttons. It returns {send, text} with the edited text, so the agent posts exactly what Drew approved."
  Rule: Anything sent in the owner's name is a draft ask that the owner reviews; Okay sends it as written

    @v1 @browser
    Scenario: A draft ask is sent as written from inside the conversation
      Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
      When the owner opens conversation 41
      Then the ask is an item titled by the question, whose context starts with the draft
      When the owner presses "Okay"
      Then "devtool" gets the answer send true with the text "Sounds good, Thursday works." in its inbox and its watch

    @v1 @cli
    Scenario: A draft ask needs no owner's-call reason
      When "devtool" runs "convoz ask --draft 'Sounds good, Thursday works.' --original 'Can we meet Thursday?' --original-from 'Alex · Slack DM' 41 'Send this reply to Alex?'"
      Then the command succeeds and the owner sees the ask in Now with the call "Your call · in-your-name: It goes out in your name."
      When "devtool" runs "convoz ask" with the call "in-your-name" and options but no draft
      Then the command exits 2 and says the call is for a draft ask only
      When "devtool" runs "convoz ask --draft" with a recommendation as well
      Then the command exits 2 and says a draft ask takes no options and no owner's call

    @v1 @cli
    Scenario: A long original is cut and a long draft is refused
      When "devtool" runs "convoz ask --draft" with an original of 2500 characters
      Then the owner sees the original cut to 2000 characters and ending with "…"
      When "devtool" runs "convoz ask --draft" with a draft of 4001 characters
      Then the command exits 2 and the owner sees no new ask

  # Drew, conv 349 msg 6199: an ask stops handing the owner a decision. The agent is confident in one action and asks the owner to
  # accept its risk; it lists the ways it rejected and why they were worse. The card must read in about 10 seconds with no outside context.
  Rule: An ask is a permission request: one action, its risk and undo, and the ways the agent rejected

    @v1 @browser
    Scenario: A permission ask reads as a short request on the Now card
      Given "devtool" asked permission to "Merge PR 415 into main" with a risk, an undo and 2 considered ways
      When the owner opens Now
      Then the card is titled by the action, and its context shows, in order, "Risk:", "Undo:", "Considered:" with both ways, and who asked
      And the card shows "Okay", "Reply" and "Snooze"
      And the card shows no Go, no Not this, no Dismiss and no confidence

    @v1 @browser
    Scenario: Okay on a permission card answers Go
      Given "devtool" asked permission to "Merge PR 415 into main"
      When the owner opens conversation 41 and taps "Okay"
      Then the card is one line "Go" with no buttons
      And "devtool" reads the answer "Go" in its inbox

    @v1 @browser
    Scenario: An ask from an old agent still shows as a decision with its recommended answer
      Given "devtool" asked with an old CLI: a question, a recommended option, an alternative and an owner's call
      When the owner opens Now
      Then the API reads it as kind "decision"
      And the card shows the question, "Recommended: Merge it" and "Okay"
      And the card shows no "Risk:" and no "Not this"

    @v1 @browser
    Scenario: An answered permission ask in the conversation is one line, with no risk, undo or considered
      Given the owner said Go to a permission ask of "devtool"
      When the owner opens conversation 41
      Then the card is one line "Go" and shows no risk, no undo, no considered ways and no buttons

  Rule: A burst of lines the conversation says about itself reads the conversation again once, not once per line

    @v1 @browser
    Scenario: Ten system lines in one tick read a conversation at most twice
      Given "devtool" asked in conversation 41 and the owner has the ask card open
      When ten system lines arrive in conversation 41 in one tick
      Then the page reads conversation 41, its messages and its plans at most twice each
      And one resume of the app makes the same reads at most twice each
      And lines that only quote a plan change make it read no messages
