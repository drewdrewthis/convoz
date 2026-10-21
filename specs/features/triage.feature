# Source: owner msgs 784, 1123 and 1217, migrations 0038 and 0040. A triage agent reads every conversation and thread without being added,
# posts in them as itself, and adds or removes agents in any chat, itself included. It is not an inbox: the agent gets no item, mention or
# "Seen by" from a conversation it is not in. It cannot rename, answer an ask or remove a person. Any agent can ask to join a chat.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: A triage agent
  As the owner
  I want one agent to read every conversation, post in them and bring agents in and out of them
  So that it can tell me what waits on me and keep the right agents in each chat, and I can cut it off in one tap

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "triage" and "devtool"
    And conversation 41 "Ship search filters" has "drew" and "devtool", and "triage" is not in it
    And "triage" runs a session on "box-2"

  Rule: The owner makes an agent a triage agent in its profile and sees the badge in Crew

    # Owner said (msg 784): "I think I also want an option to tag or give an agent privileges to be able to monitor and review all conversations and threads without being added. Not the inbox, but, yeah. Seems fine. Messy for security I guess, but not sure I care?"
    # Owner said (msg 1123): "Yes, all conversations" (answering the card: "Give me read access to all your Convoz conversations so I can triage what waits on you?")
    # Owner said (msg 1217): "When you call it a triage agent, that kind of changes things, right? I do like that. Triage agents, yeah, they can read all of it. They can message."
    @v1 @browser
    Scenario: The owner makes an agent a triage agent in the agent profile
      When the owner opens the profile of "triage"
      Then the profile has a switch "Triage agent" that is off
      And its help says the agent reads every conversation and thread, posts in any of them, can add or remove agents in any chat itself included, can't answer the owner's asks, and that any process that can sign in as "@triage" on "box-2" gets this
      When the owner turns the switch on and does the passkey check
      Then the switch is on
      And the profile shows a "Triage" badge next to the name of "triage"
      And the Crew row of "triage" shows a "Triage" badge
      And conversation 41 has no new message

    # Owner said (msg 1217): "maybe triage agents get like a special badge or something that visually identifies them"
    @v1 @browser
    Scenario: A triage agent wears a badge wherever its name shows
      Given the owner made "triage" a triage agent
      And "triage" added itself to conversation 41 and posted "Nothing waits on you here" in it
      When the owner opens conversation 41
      Then the message from "triage" shows a "Triage" badge next to its name
      And the same message from "devtool" would show no badge
      When the owner opens the details of conversation 41
      Then the agents list shows a "Triage" badge next to "@triage" and none next to "@devtool"
      When the owner types "@" in the message box
      Then the agent picker shows a "Triage" badge next to "triage"

  Rule: A triage agent reads everything, posts as itself and is never an inbox recipient

    @v1 @cli
    Scenario: A triage agent reads a conversation it is not in
      Given the owner made "triage" a triage agent
      And "drew" wrote "Which release is the search filter in?" in conversation 41 and "devtool" replied in its thread
      When "triage" runs "convoz read 41"
      Then it sees "Which release is the search filter in?"
      And "convoz read 41 --thread" shows the reply of "devtool"
      And "convoz search release" finds the message

    @v1 @cli
    Scenario: A triage agent posts in a conversation it is not in, as itself
      Given the owner made "triage" a triage agent
      When "triage" runs "convoz post --fyi 41 'Nothing waits on you here'"
      Then conversation 41 shows the message from "triage"
      And "triage" is still not a participant of conversation 41

    @v1 @cli
    Scenario: A triage agent gets no inbox item from a conversation it is not in
      Given the owner made "triage" a triage agent
      When "drew" posts "Which release is the search filter in?" in conversation 41
      And "devtool" posts "@triage have a look" in conversation 41
      Then "convoz inbox --peek" as "triage" shows no item
      And "triage" is still not a participant of conversation 41
      And the owner's message shows no "Seen by" line for "triage"

    @v1 @cli
    Scenario: Turning it off ends the reading on the next command
      Given the owner made "triage" a triage agent
      And "triage" read conversation 41
      When the owner turns it off
      Then "convoz read 41" as "triage" is refused

  Rule: convoz waiting lists what waits on the owner

    @v1 @cli
    Scenario: convoz waiting lists an open ask, an unanswered message and a waiting plan item
      Given the owner made "triage" a triage agent
      And "devtool" asked "Merge #415 on its own?" in conversation 41
      And "devtool" has a plan in conversation 41 that waits on "Approve the dot card"
      And "drew" wrote "Which release is the search filter in?" in conversation 41 and nobody answered for 10 minutes
      When "triage" runs "convoz waiting --json"
      Then it lists the ask "Merge #415 on its own?" with its asker and age
      And it lists the unanswered message of "drew" in conversation 41
      And it lists the plan item "Approve the dot card"
      And it lists the unread count of "drew" for conversation 41

  Rule: A triage agent adds and removes agents in any chat, without approval

    # Owner said (msg 1217): "I feel like triage agents can also add and remove agents to chats. So if it needs to, it can add itself to a chat. If it's clear that an agent is in a chat that it doesn't need to be in anymore, it can remove it."
    @v1 @cli
    Scenario: A triage agent adds an agent to a conversation it is not in
      Given the owner made "triage" a triage agent
      And "docs" is an agent on "box-2" that is not in conversation 41
      When "triage" runs "convoz add 41 @docs"
      Then the CLI prints "@docs active"
      And conversation 41 says "@triage added @docs"
      And "docs" reads conversation 41
      And the owner has no pending add in Now
      And "triage" is still not a participant of conversation 41

    @v1 @cli
    Scenario: A triage agent removes an agent from a conversation it is not in
      Given the owner made "triage" a triage agent
      And "devtool" is in conversation 41
      When "triage" runs "convoz remove 41 @devtool"
      Then conversation 41 says "@triage removed @devtool"
      And "devtool" gets one notice that it was removed
      And "devtool" can no longer read conversation 41
      And "triage" is still not a participant of conversation 41

    @v1 @cli
    Scenario: A triage agent adds itself to a conversation
      Given the owner made "triage" a triage agent
      When "triage" runs "convoz join 41"
      Then the CLI prints "active"
      And conversation 41 says "@triage joined"
      And "triage" is a participant of conversation 41
      And the owner has no pending add in Now

    # Owner (msg 1219): what a triage agent does without approval must show in the chat, naming the agent.
    @v1 @browser
    Scenario: The chat names the triage agent that added or removed an agent
      Given the owner made "triage" a triage agent
      And "triage" added "docs" to conversation 41 and removed "devtool" from it
      And the owner added "devtool" back
      When the owner opens conversation 41
      Then the chat shows the lines "@triage added @docs", "@triage removed @devtool" and "Added @devtool"

  Rule: Any other agent asks to join, and the owner decides in Now

    # Owner said (msg 1217): "We can drop this request to join. No, agents should be able to request to join for themselves. That's fine. No 24-hour thing."
    @v1 @cli
    Scenario: An agent asks to join a conversation and asking again changes nothing
      Given "docs" is an agent on "box-2" that is not in conversation 41
      When "docs" runs "convoz join 41"
      And "docs" runs "convoz join 41" again
      Then both print "pending"
      And the owner sees one pending add for "docs" in Now, asked by "docs"
      And "docs" cannot read conversation 41 yet

    @v1 @cli
    Scenario: The owner approves a join request and the agent hears it
      Given "docs" asked to join conversation 41
      When the owner approves the request of "docs"
      Then conversation 41 says "Approved · @docs added"
      And "docs" gets a notice that it joined
      And "docs" reads conversation 41

    @v1 @cli
    Scenario: The owner denies a join request and the agent hears it
      Given "docs" asked to join conversation 41
      When the owner denies the request of "docs"
      Then conversation 41 says "Declined · @docs not added"
      And "docs" gets a notice that it was not added
      And "docs" cannot read conversation 41

    @v1 @browser
    Scenario: The owner sees a join request in Now and approves it
      Given "docs" asked to join conversation 41
      When the owner opens Now
      Then Now shows a card "@docs wants to join" with the title "Ship search filters" and the buttons "Approve" and "Deny"
      When the owner taps "Approve"
      Then the card goes away and "docs" is a participant of conversation 41

    @v1 @browser
    Scenario: The owner denies a join request in Now
      Given "docs" asked to join conversation 41
      When the owner opens Now and taps "Deny" on the card "@docs wants to join"
      Then the card goes away and "docs" is not a participant of conversation 41

  # Source: conv 72 (msgs 2220, 2222, 2226, 2228), asked by Drew through "dot". A story to plan, not built yet: every scenario is @later.
  # Gap found on 2026-10-21: POST /api/conversations/:id/read moves the caller's own cursor (c.p.Identity()), so an agent marks its
  # own read state, never the owner's, and a triage agent not in the chat gets a quiet success. No owner-targeted read marker exists.
  # Open choices (not decided): a "last briefing" checkpoint, and opaque public ids for conversations next to the numbers.
  Rule: The owner asks the triage agent what is new since the last briefing

    @later @cli
    Scenario: A triage agent finds every conversation, joined or not
      Given the owner made "triage" a triage agent
      When "triage" lists the conversations with "convoz conversations"
      Then it sees conversation 41 "Ship search filters" with its link, marked as not joined
      And it finds the same messages with "convoz search" that the owner finds in the app

    @later @cli
    Scenario: A briefing tells settled and superseded work apart from open work
      Given the owner made "triage" a triage agent
      And "drew" asked a question in conversation 41 and "devtool" answered it in a thread
      And "devtool" has an open ask in conversation 41 and a later message that makes an older ask out of date
      When "triage" runs "convoz waiting"
      Then the question shows as answered in a thread, with a link to the reply
      And the older ask shows as superseded, with a link to the later message
      And the open ask shows as waiting on the owner
      And nothing was marked read, answered or dismissed

    @later @cli
    Scenario: The triage agent marks only settled material read for the owner, when the owner allowed it
      Given the owner made "triage" a triage agent and allowed it to mark settled material read
      And conversation 41 has a settled thread and an open ask
      When "triage" marks the owner read up to the last message of the settled thread
      Then the owner's unread count for conversation 41 drops by that thread only
      And the open ask still waits in Now
      And the owner's audit log names "triage", the conversation, and the old and new read position
      And the owner can undo it
