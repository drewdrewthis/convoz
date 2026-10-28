# The owner's dev copy of the screens (Drew, Convoz 179 msg 10977): "a dev version of the screens at /dev on the prod server, using
# the real API and the owner's session", updated without a restart. Contracts: specs/contracts/dev-web.feature.

Feature: The owner's dev copy of the screens
  The owner opens a dev build of the app next to the real one, on the same server, with the same data and the same sign-in.

  Background:
    Given a fresh Convoz server
    And the owner is signed in

  @v1 @browser
  Scenario: The owner opens the dev copy and always knows it is the dev copy
    Given a dev build of the app is in place
    When the owner opens /dev/
    Then the Now screen shows with the owner's own data
    And a DEV badge shows on every screen of the dev copy
    And the real app at / shows no DEV badge

  @v1 @browser
  Scenario: Links and moves inside the dev copy stay in the dev copy
    Given the owner is on the dev copy
    When the owner opens a conversation, the crew, and signs in again from the dev copy
    Then every page they land on is under /dev/

  @v1 @browser
  Scenario: A new dev build shows at the next load, with no restart
    Given the owner has the dev copy open
    When a new dev build is put in place
    And the owner loads the page again
    Then the new build shows
    And the server did not restart

  @v1 @browser
  Scenario: Nobody else can tell the dev copy exists
    Given an agent and a visitor who is not signed in
    When either asks for the dev copy
    Then they see the same not-found page as for a page that does not exist
