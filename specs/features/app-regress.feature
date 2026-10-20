# Owner said (msg 365): "I'm wondering if you're building a lot of stuff ad hoc instead of thinking in terms of atomic design, reusable components, and feature/modular organization. I'm scared to look at the code base."
# So the UI code is to be reorganised (atoms, features, CSS per feature), and nothing may change on screen while that happens. This is the safety net for it:
# the app is compared with its own reviewed frames, not with the prototype (prototype-parity.feature does that). Each screen is shot in light and in dark,
# on a desktop window (the "chromium" project, 1280 by 720) and on a phone (the "mobile" project, 390 by 844). The server clock and the browser clock are frozen,
# so ages and times are the same on every run; the only grey box is over the search status line, which carries the query's duration. A screen passes when:
#  - every element matched by the stable list in e2e/lib/regress.ts (controls, headings, links, dialogs, menus, rows, images, icons) has the same box as in the
#    stored e2e/visual/regress/<project>/<screen>-<scheme>.boxes.json, to within 0.5 px, and no element appears or goes;
#  - at most 200 pixels differ from the stored <screen>-<scheme>.png.
# The frames are rewritten only by a person, on purpose: REGRESS_WRITE=1 (e2e/visual/regress/README.md). A run without it never writes under visual/regress.

Feature: The app keeps its look while its code is reorganised
  As the owner
  I want every screen to look and measure the same after a refactor
  So that cleaning up the code never changes what I approved

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the server clock and the browser clock are frozen at 2026-10-16 18:00 UTC

  Rule: Every screen matches its own stored frame and element boxes, in light and in dark, on a desktop and on a phone

    @v1 @browser
    Scenario: Now and the Conversations list keep their look
      Given the prototype's agents and conversations
      When the owner opens Now, and then Conversations
      Then each matches its own frame in light and in dark

    @v1 @browser
    Scenario: A conversation, its composer and its thread keep their look
      Given the prototype's agents and conversations, and the thread under night-watch's "Deploy finished" in Ops reports
      When the owner opens "Why did the nightly export get slower?"
      Then it matches its frame, and so does the composer with a draft in it
      And when the owner opens the thread of "Deploy finished at 5:29. I'm watching the error rate." in "Ops reports", it matches its frame

    @v1 @browser
    Scenario: New conversation, search and settings keep their look
      Given the prototype's agents and conversations
      When the owner opens New conversation, the search overlay empty and with "cache" typed, and Settings
      Then each matches its own frame in light and in dark

    @v1 @browser
    Scenario: The rail with stars and a mute keeps its look
      Given the prototype's agents and conversations
      And the owner starred "assistant" and "Ops reports" and muted "Team updates"
      When the owner opens the rail
      Then it matches its frame in light and in dark

    @v1 @browser
    Scenario: Now with asks and the snooze sheet keep their look
      Given two open asks and one snoozed ask
      When the owner opens Now
      Then it matches its frame
      And when the owner opens the Snooze choices of an ask, the sheet matches its frame

    @v1 @browser
    Scenario: Now with a replied ask and an updated ask keeps its look
      Given an open ask the owner replied to, and an open ask updated after the owner's questions
      When the owner opens Now
      Then it matches its frame, with the section "You replied · waiting on the agent" and the updated ask with its answers

    @v1 @browser
    Scenario: Now with a waiting plan item keeps its look
      Given "devtool" waits on the owner for "Approve the staging push"
      When the owner opens Now
      Then it matches its frame in light and in dark

    @v1 @browser
    Scenario: An empty Now and its open folds keep their look
      Given an answered ask, a dismissed ask and a snoozed ask, and nothing else waits
      When the owner opens Now, and then opens the three folds
      Then the all-clear line with the chips matches its frame
      And the open folds match theirs
      And in the conversation the answered ask and the dismissed ask match theirs

    @v1 @browser
    Scenario: Ask cards with a draft, a quick reply and in a conversation keep their look
      Given "devtool" asked a question and asked the owner to review a draft reply
      When the owner opens Now, and then the quick reply of the question
      Then the cards, and the quick reply with its text, match their frames
      And in the conversation the asks, the options menu and the history match theirs

    @v1 @browser
    Scenario: Now with an add to decide and connect requests keeps its look
      Given "devtool" asked to add "release-bot", a machine "box-9" waits with a code, and an agent asks to connect as "dev-ci"
      When the owner opens Now, and then approves the agent
      Then the cards match their frame
      And the joined card matches its frame

    @v1 @browser
    Scenario: Crew keeps its look
      Given every agent is idle
      When the owner opens Crew
      Then it matches its frame in light and in dark

    @v1 @browser
    Scenario: Crew with agent status keeps its look
      Given the agents report the status the prototype shows, and have open asks
      When the owner opens Crew
      Then it matches its frame in light and in dark

    @v1 @browser
    Scenario: The desktop rail and conversation layout keeps its look
      Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
      When the owner opens a conversation in a 1280 by 800 window
      Then the rail beside the conversation matches its frame in light and in dark

    @v1 @browser
    Scenario: Conversation details and their sheets keep their look
      Given the prototype's agents and conversations
      When the owner opens the details of "Why did the nightly export get slower?"
      Then they match their frame, with the plain, the danger and the close buttons
      And the delete sheet and the rename sheet match theirs

    @v1 @browser
    Scenario: An agent profile and its revoke and rename forms keep their look
      Given the prototype's agents, with docs and orchardist live too
      When the owner opens the profile of night-watch
      Then it matches its frame
      And the Handoffs tab, the rename form and the revoke confirmation match theirs

    @v1 @browser
    Scenario: Account, passkeys, privacy, machines and trash keep their look
      Given the prototype's agents and conversations, and "Team updates" in the trash
      When the owner opens Account, Passkeys, Privacy & security, Delete my data, Machines (with the box that runs the agents) and the Trash
      Then each matches its frame, and so does the Trash after the conversation is restored

    @v1 @browser
    Scenario: Settings quiet hours, Advanced and the empty states keep their look
      Given a world with no conversations
      When the owner opens Conversations with nothing in it, and a conversation that does not exist
      Then each matches its frame
      And Settings with Quiet hours on and Advanced match theirs

    @v1 @browser
    Scenario: The composer with a file keeps its look
      Given the prototype's agents and conversations
      When the owner picks a file in the composer of "Why did the nightly export get slower?"
      Then the composer matches its frame, with the remove button on the file

    @v1 @browser
    Scenario: The recovery page and the recovery codes step keep their look
      Given a server with a bootstrap link, and a virtual passkey in the browser
      When the browser opens the recovery page, and then registers the passkey
      Then the recovery page and the codes step match their frames, with the box unticked and ticked

  Rule: The sign-in page and the first onboarding screen match their frames

    @v1 @browser
    Scenario: Sign in and the first onboarding screen keep their look
      Given a browser that is not signed in
      When it opens the sign-in page and then a bootstrap link
      Then each matches its own frame in light and in dark
