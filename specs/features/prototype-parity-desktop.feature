# Source: the owner, 2026-10-17 ("1:1 pixel perfect match with the prototype"), applied to the two parts of the prototype's desktop layout that WP9 draws:
# the rail (the sidebar, 240 by 742) and the Crew dock (380 by 726). Each scenario opens the app in a 1280 by 800 window and compares that one
# element with the same element of the v41 prototype (Iris): at most 2% of the pixels may differ. What the app does not have yet is covered by a
# grey box on both images, as in prototype-parity.feature; no element hides more than 10% of its pixels (Crew dock 20%).
# The reference frames are made by e2e/tools/capture-prototype.mjs.

Feature: The desktop rail and Crew match the prototype
  As the owner
  I want the desktop rail and Crew to look like the prototype
  So that what I approved is what I get

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the prototype's agents and conversations

  Rule: Each desktop part matches the prototype in light and in dark

    @v1 @browser
    Scenario: On a desktop the rail matches the prototype
      Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
      And six conversations had no activity for 20 days
      When the owner opens the rail on a desktop
      Then it matches the prototype in light and in dark

    @v1 @browser
    Scenario: On a desktop Crew matches the prototype
      Given the agents report the status the prototype shows
      When the owner opens Crew on a desktop
      Then it matches the prototype in light and in dark
