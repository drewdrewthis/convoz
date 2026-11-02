# Source: the owner, 2026-10-17, on the phone UI: "What the fuck is this app. Why doesn't it have 1:1 pixel perfect match with the prototype?"
# The prototype is v41 (Iris, light and dark). Each scenario opens one phone screen at 390 by 800 with the prototype's sample data and
# compares it with the prototype frame: at most 2% of the pixels may differ.
# What the app does not have yet, because it has no backend, is covered by a grey box on both images, so it never counts:
# Search, Show details, Star, Mute, Attach and Voice, the Answered chip, agent status (the Working summary, three status
# lines, two ask chips on Crew), the avatar images of agents, "picked this up", Invite agent, the muted look of a conversation, the
# count on the Now tab and every time. No screen hides more than 10% of its pixels (Crew 20%); the spec checks that from masks.json.
# The two starred conversations are read, not starred. The conversation shown is the only prototype thread with no ask, file or preview. The thread shown is the one under night-watch's "Deploy finished" in Ops reports (3 replies). DEFAULT (owner to confirm): the Account menu takes the place of the Search button in the top bar.
# The shot, the grey boxes and the reference frames are in e2e/visual; e2e/tools/capture-prototype.mjs makes the frames.

Feature: The phone screens match the prototype
  As the owner
  I want every phone screen to look like the prototype
  So that what I approved is what I get

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey on a phone
    And the prototype's agents and conversations

  # Four of these screens wait on issue 139 (the reference frames are not yet updated to the shipped design); their tests are test.fixme until then.
  Rule: Every phone screen matches the prototype in light and in dark

    @later @browser @phone
    Scenario: On a phone Now matches the prototype
      Given nothing waits for the owner
      When the owner opens Now on a phone
      Then it matches the prototype in light and in dark

    # The owner ruled (msg 39) "the app is the UI spec", and asked that an ask say whether the call is one-way (msg 252: the "Your call · ..." line on
    # each ask card). So this screen is compared with a reviewed frame of the app, e2e/visual/app/now-asks-<scheme>.png, not the prototype's.
    @later @browser @phone
    Scenario: On a phone Now with asks matches the prototype
      Given "night-watch" asked an urgent "Close the incident?" and "devtool" asked "Push the 8642 fix to staging?"
      And one ask is snoozed
      When the owner opens Now on a phone
      Then it matches the prototype in light and in dark

    @v1 @browser @phone
    Scenario: On a phone the Conversations list matches the prototype
      When the owner opens Conversations on a phone
      Then it matches the prototype in light and in dark

    @later @browser @phone
    Scenario: On a phone a conversation matches the prototype
      When the owner opens "Why did the nightly export get slower?" on a phone
      Then it matches the prototype in light and in dark

    @later @browser @phone
    Scenario: On a phone a thread matches the prototype
      When the owner opens the thread of "Deploy finished at 5:29. I'm watching the error rate." in "Ops reports" on a phone
      Then it matches the prototype in light and in dark

    @v1 @browser @phone
    Scenario: On a phone New conversation matches the prototype
      When the owner opens New conversation on a phone
      Then it matches the prototype in light and in dark

    # The owner ruled (msg 39) "the app is the UI spec", and moved Machines to a row at the top of Crew (msg 351: "you need to scroll to see machines --
    # that's a bit weird"). So this screen is compared with a reviewed frame of the app, e2e/visual/app/crew-<scheme>.png, not the prototype's.
    @v1 @browser @phone
    Scenario: On a phone Crew matches the prototype
      Given every agent is idle
      When the owner opens Crew on a phone
      Then it matches the prototype in light and in dark

  Rule: The rail and Crew show the owner's stars, mute and the agents' status like the prototype

    @v1 @browser @phone
    Scenario: On a phone the rail matches the prototype
      Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
      When the owner opens the rail on a phone
      Then it matches the prototype in light and in dark

    # The owner ruled (msg 39) "the app is the UI spec", and moved Machines to a row at the top of Crew (msg 351: "you need to scroll to see machines --
    # that's a bit weird"). So this screen is compared with a reviewed frame of the app, e2e/visual/app/crew-status-<scheme>.png, not the prototype's.
    @v1 @browser @phone
    Scenario: On a phone Crew with agent status matches the prototype
      Given the agents report the status the prototype shows
      When the owner opens Crew on a phone
      Then it matches the prototype in light and in dark
