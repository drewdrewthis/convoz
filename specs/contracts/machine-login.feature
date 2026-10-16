# Contracts for `features/machine-login.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/machine-login.feature.
# Source: design draft 9 §3.3 (login flow), §3.5, I-33, I-36, I-42, AC-8, AC-15.

Feature: Machine login with a device flow (contracts)
  Protocol, security and invariant rules behind machine login with a device flow.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And agent identities "devtool", "docs" and "release-bot" exist

  Rule: A machine asks for access with a short code, and the owner approves it

    @v1 @api @I-36 @AC-8
    Scenario: The token poll waits while the request is pending
      Given "convoz login --name box-2" is waiting for approval
      When the machine polls POST /api/device/token after 5 seconds
      Then the answer is "authorization_pending"
      And GET /api/machines does not list "box-2"

    @v1 @api @I-26 @I-36 @AC-8
    Scenario: Approval without a single-use step-up is refused
      Given a pending machine request "box-2"
      When the owner approves it with no X-Convoz-Step-Up header
      Then the server answers 403
      And GET /api/machines does not list "box-2"

  Rule: The key reaches the CLI safely and can be fetched again until it is used (M6)

    @v1 @api @I-36 @M6 @C-8 @AC-8
    Scenario: The first request made with the key marks it delivered
      Given the machine "box-2" fetched its key
      When the machine mints a session lease with that key
      Then a later token poll with the same device code answers "expired_token"

    @v1 @api @I-36 @M6 @AC-8
    Scenario: An approved key cannot be fetched after the request expires
      Given the owner approved the machine request "box-2"
      And the machine never fetched the key
      When the test clock moves 10 minutes and 1 second past the approval
      Then a token poll with the device code answers "expired_token"

  Rule: Device-flow limits stop floods and name clashes

    @v1 @api @I-33 @I-36
    Scenario: A fourth pending request is refused
      Given 3 machine requests are pending
      When a fourth machine starts "convoz login --name box-4"
      Then the server answers 429 with the code "too_many_pending"
      And the CLI says to deny the waiting requests in Convoz
      And Now still shows 3 machine requests

    @v1 @api @I-36
    Scenario: One source is limited to 10 requests per hour
      Given one source started 10 device-flow requests in the last hour
      When it starts an eleventh
      Then the server answers 429 with a Retry-After header

    @v1 @api @I-33
    Scenario: At most 10 machines are active
      Given 10 active machines
      When the owner approves an eleventh machine
      Then the server answers 409 with the code "machine_cap"

    @v1 @api @I-33 @I-36
    Scenario: A request cannot take an active machine's name
      Given an active machine "box-2"
      When the owner approves a new request named "box-2"
      Then the server answers 409 with the code "machine_name_taken"
      And the key of the active "box-2" still works
