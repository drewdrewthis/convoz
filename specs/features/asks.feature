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
    Scenario: The ask card shows why it is the owner's call
      Given "devtool" asked in conversation 41 as a "taste" call because "Both names read fine; it is your voice"
      And "devtool" asked inside thread 900 as a "one-way" call because "A published name cannot be taken back"
      When the owner opens Now, conversation 41 and thread 900
      Then each card shows "Your call · taste: Both names read fine; it is your voice" or "Your call · one-way: A published name cannot be taken back" under its question

    @v1 @browser
    Scenario: An ask from before this rule shows no owner's call line
      Given an open ask of "devtool" that has no reason it is the owner's call
      When the owner opens Now
      Then the card shows no "Your call" line

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

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: The Reply in thread button of an ask shows the replies
      Given an open ask of "devtool" in conversation 41 and "docs" replied in its thread
      When the owner opens conversation 41
      Then "Reply in thread" on the ask shows "1 reply"

    @v1 @browser
    Scenario: The ask menu opens once
      Given an open ask of "devtool" in conversation 41
      When the owner taps "Ask options" on the ask
      Then one menu opens with "Snooze", "Dismiss", "Copy link", "Pin" and "Delete"
      And the ask has no second "Message actions" button
      And the thread under the ask does not draw the ask again

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

    # Owner, msg 1802: "I just tried to dismiss this ... in the thread, and nothing happened in the UI". A reply in the thread moves the
    # ask's version, so the card may still hold the old one.
    @v1 @browser
    Scenario: Dismiss on a card with an old version still dismisses
      Given an open ask of "devtool" in conversation 41, open on screen
      And the owner replied in its thread, so the card holds an old version
      When the owner taps "Dismiss" on the card
      Then the ask is dismissed

    # Owner (Drew, msg 716): "this history button seems kind of useless? A better ui would just be the quick buttons"
    # In the conversation the card shows Quick reply, Snooze and Dismiss like Now's (no Open); History is an item in its ⋯ menu.
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
      And the card in the conversation shows "You replied · waiting on @devtool" and still offers its options

    @v1 @cli
    Scenario: An agent's reply does not close an ask
      Given an open ask of "devtool"
      When "docs" replies in the thread of the ask
      And "devtool" replies in the thread of the ask
      Then the ask is still open

    @v1 @cli
    Scenario: An agent is told to answer in the thread and update the same ask
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
      Then Now lists the ask in the main list with "Your questions, answered" and the answers in full: with no "More" to tap on a wide screen, behind "More" on a phone
      And the ask is no longer under "You replied"
      And the card in the conversation shows the same, and its history has the update

  # Drew, conv 179 msg 4342 (the Q&A on the feed item): the question read gray under a white answer, "v2 · changed: answers" was jargon,
  # Q and A ran on in one paragraph, raw links wrapped mid-word and the long answer pushed the options off the screen.
  # Spec /tmp/convoz-ux/qa-feeditem.md: the card gets a Q/A section (conv 1 msg 2362), read in full at a glance (conv 1 msg 2064).
  Rule: An updated ask shows the owner's questions and the agent's answers as their own section under the question

    @v1 @browser
    Scenario: An updated ask shows each question and its answer in a section under a bright question
      Given an open ask of "devtool" that the owner replied to with "It was deployed?"
      When "devtool" updates the ask with the answers "Q: It was deployed? A: Yes. The block was lifted."
      Then the card in Now and the card in the conversation show the question in the text color, not the muted one
      And under it, 8 px or more below and with an accent edge on its left, a section "Your questions, answered"
      And the section shows "It was deployed?" muted and "Yes. The block was lifted." in the text color, as two rows with no "Q:" and no "A:"

    @v1 @browser
    Scenario: Answers with no Q and A marks show in full, and an ask never updated shows no section
      Given an open ask of "devtool" updated with answers that carry no "Q:" and no "A:"
      And an open ask of "devtool" that was never updated
      When the owner opens Now
      Then the updated card shows the whole text as one answer, the same text as the agent sent
      And the card never updated has no section "Your questions, answered" and its question keeps its muted color

    @v1 @browser
    Scenario: The version of an update is in History, not on the card
      Given an open ask of "devtool" that the owner replied to and "devtool" updated with its answers
      When the owner opens Now and the conversation
      Then neither card shows "v2" or "changed:"
      And the History of the card in the conversation shows "Updated by Devtool @devtool · v2, changed answers"

    @v1 @browser
    Scenario: A link in an answer is a short link to the full address
      Given an open ask of "devtool" updated with an answer that names a run, a PR and a page by their full addresses
      When the owner opens Now
      Then the answer shows the links "run 39923502587", "PR 1382" and "example.com", each to its full address and on one line
      And no full address shows as text

    @v1 @browser @phone
    Scenario: On a phone a long answer folds so the first option stays on the first screen of the card
      Given an open ask of "devtool" updated with an answer of 900 characters
      When the owner opens Now on a phone (390 x 844)
      Then the answer is folded to 3 lines and the first option is inside the screen when the top of the card is at the top of the screen
      When the owner taps "More"
      Then the full answer shows
      When the owner taps "Less"
      Then the answer folds to 3 lines again

  # Drew, conv 32 msg 650: "ship a standard 'review a draft' mini app with Convoz, so agents don't hand-build one for every message
  # they draft for him. It shows the original message being answered (who, where, text) and the agent's draft in an editable box, with
  # Send and Don't send buttons. It returns {send, text} with the edited text, so the agent posts exactly what Drew approved."
  Rule: Anything sent in the owner's name is a draft ask that the owner reviews and may edit

    @v1 @browser
    Scenario: An agent asks the owner to review a draft and gets back the edited text
      Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
      When the owner opens Now
      Then the card shows the question, the original quoted with its from-line and the draft in an editable box
      And the card shows no "Edited" marker
      When the owner changes the draft to "Sounds good, Thursday at 10 works."
      Then the card shows an "Edited" marker
      When the owner taps "Send"
      Then "devtool" gets the answer send true with the text "Sounds good, Thursday at 10 works." in its inbox and its watch
      And conversation 41 shows "Send: Sounds good, Thursday at 10 works."

    @v1 @browser
    Scenario: Don't send returns send false and no text
      Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
      When the owner opens Now and taps "Don't send"
      Then "devtool" gets the answer send false and no text in its inbox and its watch
      And conversation 41 shows "Don't send"

    @v1 @browser
    Scenario: A draft ask is reviewed inside the conversation too
      Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
      When the owner opens conversation 41, changes the draft to "Sounds good, Thursday at 10 works." and taps "Send"
      Then "devtool" gets the answer send true with the text "Sounds good, Thursday at 10 works." in its inbox and its watch

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
