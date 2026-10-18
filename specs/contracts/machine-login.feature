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

    # Owner said: "Approvals just go into the feed, right?" The owner's signed-in session is the authority; no step-up, no typed code.
    @v1 @api @I-36 @AC-8
    Scenario: Approval needs the owner's signed-in session and nothing more
      Given a pending machine request "box-2"
      When a machine key, a session lease and a caller with no credential each try to approve it
      Then the server answers 401 every time
      And GET /api/machines does not list "box-2"
      When the owner approves it with no X-Convoz-Step-Up header and no typed code
      Then the server answers 201
      And the typed_code field is not accepted

    @v1 @api @I-36 @AC-8
    Scenario: Approval can name an allow-list and scopes in its body
      Given a pending machine request "box-2" (agents "devtool" and "dev-search" exist)
      When the owner approves it with allow-list "devtool" and "dev-*" and the default scopes
      Then GET /api/machines lists "box-2" with that allow-list and the scopes read, post, ask, status and upload

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

  Rule: An agent that logs in sends its own identity, and the server checks it twice

    @v1 @api @I-3 @I-36
    Scenario: A login request with an identity shows it on the card data and creates nothing yet
      When POST /api/device/code is sent with the identity "code-review", the description "Reviews pull requests" and a plain SVG avatar
      Then the server answers 200
      And GET /api/now lists the machine request with that identity, its display name "code-review" and an avatar_url under /api/identity-requests/
      And GET /api/identities does not list "code-review"
      And the card data holds no cvz_ string

    @v1 @api @I-3
    Scenario: A login request for a handle that exists is refused with handle_taken
      When POST /api/device/code is sent with the identity "devtool"
      Then the server answers 409 with the code "handle_taken"
      And GET /api/now lists no machine request

    @v1 @api @I-3
    Scenario Outline: A login request with a bad identity is refused and makes no request
      When POST /api/device/code is sent with <identity>
      Then the server answers <status> naming <field>
      And GET /api/now lists no machine request

      Examples:
        | identity                                 | status | field         |
        | the handle "admin"                       | 400    | handle        |
        | the handle "9lives"                      | 400    | handle        |
        | the handle "devtoo1" (a look-alike)      | 400    | handle        |
        | a description with a newline             | 400    | description   |
        | a description of 81 characters           | 400    | description   |
        | an avatar with a DOCTYPE                 | 400    | avatar_svg    |
        | a conversation that does not exist       | 400    | conversation  |
        | a conversation the owner is not in       | 400    | conversation  |

    @v1 @api @I-3 @I-36
    Scenario: The approval checks the handle again
      Given a login request for "code-review" is pending
      And the owner then creates the agent "code-review" some other way
      When the owner approves the request
      Then the server answers 409 with the code "handle_taken"
      And GET /api/machines does not list the machine

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @api @I-3 @I-17 @I-36
    Scenario: Approving a login with an identity makes the machine, the agent, its allow-list and its seat in one step
      Given a login request for "code-review" naming conversation 41 is pending
      When the owner approves it with an empty body
      Then the machine allows "code-review" and no create_identity scope
      And "code-review" has its description, its avatar and is marked created by the machine
      And "code-review" is an active participant of conversation 41 and can read the messages before the add
      And the machine can fetch its key and start a session as "code-review"

    @v1 @api @I-36
    Scenario: A declined or expired login request leaves no agent
      Given a login request for "code-review" is pending
      When the owner declines it
      Then GET /api/identities does not list "code-review"
      And the handle is free for another request

    @v1 @api @I-36
    Scenario: Deny all also denies the agent requests of logged-in machines
      Given a login request for "code-review" and an identity request from "box-2" for "dev-ci" are pending
      When the owner denies all
      Then GET /api/now lists no machine request and no identity request
      And the answer counts both

  Rule: Host info never breaks a login request

    @v1 @api
    Scenario: Host info made of markup characters never makes the server fail
      When POST /api/device/code is sent with a host name of 200 characters from < > & " and \
      Then it answers 200 or 400 and never 500
      And when it answers 200 the stored host info holds none of those characters
