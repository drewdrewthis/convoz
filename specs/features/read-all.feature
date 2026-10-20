# Source: owner msgs 784 and 1123, migration 0038. One agent can read every conversation and thread without being added, to triage
# what waits on the owner. It is not an inbox: the agent gets no item, mention or "Seen by" from a conversation it is not in. It posts as
# itself and cannot change the conversation or answer an ask.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: An agent that reads all conversations
  As the owner
  I want to let one agent read every conversation and thread without adding it to them
  So that it can tell me what waits on me, and I can cut it off in one tap

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "triage" and "devtool"
    And conversation 41 "Ship search filters" has "drew" and "devtool", and "triage" is not in it
    And "triage" runs a session on "box-2"

  Rule: The owner gives the right in the agent's profile and sees it in Crew

    # Owner said (msg 784): "I think I also want an option to tag or give an agent privileges to be able to monitor and review all conversations and threads without being added. Not the inbox, but, yeah. Seems fine. Messy for security I guess, but not sure I care?"
    # Owner said (msg 1123): "Yes, all conversations" (answering the card: "Give me read access to all your Convoz conversations so I can triage what waits on you?")
    @v1 @browser
    Scenario: The owner turns on reading everything in the agent profile
      When the owner opens the profile of "triage"
      Then the profile has a switch "Can read all conversations" that is off
      And its help says the agent reads every conversation and thread, can post in them as itself, can't answer the owner's asks, and that any process that can sign in as "@triage" on "box-2" gets this
      When the owner turns the switch on and does the passkey check
      Then the switch is on
      And the Crew row of "triage" shows "Reads all"
      And conversation 41 has no new message

  Rule: A granted agent reads everything, posts as itself and is never an inbox recipient

    @v1 @cli
    Scenario: A granted agent reads a conversation it is not in
      Given the owner turned on reading everything for "triage"
      And "drew" wrote "Which release is the search filter in?" in conversation 41 and "devtool" replied in its thread
      When "triage" runs "convoz read 41"
      Then it sees "Which release is the search filter in?"
      And "convoz read 41 --thread" shows the reply of "devtool"
      And "convoz search release" finds the message

    @v1 @cli
    Scenario: A granted agent posts in a conversation it is not in, as itself
      Given the owner turned on reading everything for "triage"
      When "triage" runs "convoz post --fyi 41 'Nothing waits on you here'"
      Then conversation 41 shows the message from "triage"
      And "triage" is still not a participant of conversation 41

    @v1 @cli
    Scenario: A granted agent gets no inbox item from a conversation it is not in
      Given the owner turned on reading everything for "triage"
      When "drew" posts "Which release is the search filter in?" in conversation 41
      And "devtool" posts "@triage have a look" in conversation 41
      Then "convoz inbox --peek" as "triage" shows no item
      And "triage" is still not a participant of conversation 41
      And the owner's message shows no "Seen by" line for "triage"

    @v1 @cli
    Scenario: Turning it off ends the reading on the next command
      Given the owner turned on reading everything for "triage"
      And "triage" read conversation 41
      When the owner turns it off
      Then "convoz read 41" as "triage" is refused

  Rule: convoz waiting lists what waits on the owner

    @v1 @cli
    Scenario: convoz waiting lists an open ask, an unanswered message and a waiting plan item
      Given the owner turned on reading everything for "triage"
      And "devtool" asked "Merge #415 on its own?" in conversation 41
      And "devtool" has a plan in conversation 41 that waits on "Approve the dot card"
      And "drew" wrote "Which release is the search filter in?" in conversation 41 and nobody answered for 10 minutes
      When "triage" runs "convoz waiting --json"
      Then it lists the ask "Merge #415 on its own?" with its asker and age
      And it lists the unanswered message of "drew" in conversation 41
      And it lists the plan item "Approve the dot card"
      And it lists the unread count of "drew" for conversation 41
