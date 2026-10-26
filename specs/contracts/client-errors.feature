# Source: owner decision, ask 231 answered at msg 232 (Drew): "Errors to server log". The option text was: "The app posts
# uncaught errors (message, stack, page, build) to the server, which writes them to its own log. No third party, small,
# and I can read it with journalctl."
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir. Fake tokens only.

Feature: Errors in the web app reach the server log (contracts)
  As the owner
  I want the error route to be small, capped and mine alone
  So that a broken page cannot flood the log or let a stranger write to it

  Background:
    Given a fresh Convoz server with owner "drew" signed in

  @v1 @api
  Scenario: Client error reports are capped and need the owner
    When the owner sends POST /api/client-errors with a 900-character message and a 9000-character stack
    Then the server answers 204 and the log line holds at most 500 characters of the message and 4096 of the stack
    And the line is one line: a newline in the message is written as \n
    When the owner sends a report over 16 KB
    Then the server answers 400 and writes no line
    When the owner sends 60 reports in an hour and then one more (the two above count)
    Then the one more is answered 429 with Retry-After
    When an anonymous caller or an agent with a session lease sends a report
    Then the server answers 401 and writes no line
    And the agents-only port answers 404 for the route

  @v1 @browser
  Scenario: A report holds no query string and no token
    Given the owner has the chat list open at an address with a query "?ticket=TESTONLY-secret"
    When a script error that carries a 40-character token in its message happens in the open page
    Then the "client_error" line has the page "/chats", no "TESTONLY-secret" and no 40-character token
    And the page sends at most 10 reports, and the same error twice is one report

  @v1 @api
  Scenario: The web app counts a failed send with no content
    When the owner sends POST /api/client-events with the event "send_failed"
    Then the server answers 204
    When the owner sends an event the server does not know
    Then the server answers 400
    When the owner sends a body over 1 KB
    Then the server answers 400
    When an anonymous caller or an agent with a session lease sends the event
    Then the server answers 401
    And the agents-only port answers 404 for the route

  @v1 @api
  Scenario: An error report carries its class
    When the owner sends POST /api/client-errors with the class "TypeError"
    Then the server answers 204
    And the report is written to the server log as before
