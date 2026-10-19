# Source: owner decision, ask 231 answered at msg 232 (Drew): "Errors to server log". The option text was: "The app posts
# uncaught errors (message, stack, page, build) to the server, which writes them to its own log. No third party, small,
# and I can read it with journalctl."
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir. Fake tokens only.

Feature: Errors in the web app reach the server log
  As the owner
  I want a crash in the web app to show up in the server's own log
  So that I can find and fix it with journalctl, with no third party watching

  Background:
    Given a fresh Convoz server with owner "drew" signed in in a browser

  @v1 @browser
  Scenario: An uncaught error in the web app reaches the server log
    Given the owner has the chat list open
    When a script error that nothing catches happens in the open page
    Then the server log has one "client_error" line with the error's message, a stack, the page "/chats", the build and the browser
    And the line does not hold the part of the address after the question mark

  @v1 @browser
  Scenario: A crash shows a reload message instead of a blank page
    Given the owner has the chat list open
    When the page crashes while it draws
    Then the page says "Something went wrong." with a "Reload" button
    And the server log has a "client_error" line for the crash
    And the owner presses "Reload" and the chat list is back

  @v1 @browser
  Scenario: An error in the service worker reaches the server log
    Given the owner has the chat list open and the app's service worker is running
    When a script error that nothing catches happens in the service worker
    Then the server log has one "client_error" line with the error's message and the page "/sw.js"
