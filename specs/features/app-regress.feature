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
    Scenario: Now with a waiting plan item keeps its look
      Given "devtool" waits on the owner for "Approve the staging push"
      When the owner opens Now
      Then it matches its frame in light and in dark

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

  Rule: The sign-in page and the first onboarding screen match their frames

    @v1 @browser
    Scenario: Sign in and the first onboarding screen keep their look
      Given a browser that is not signed in
      When it opens the sign-in page and then a bootstrap link
      Then each matches its own frame in light and in dark
