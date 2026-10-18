# Contracts for `features/sessions.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/sessions.feature.
# Source: design draft 9 §3.0 (machine · identity · session), §3.3 (session start), I-33, I-37, I-38, I-42, §13.1.

Feature: Agent sessions as one identity (contracts)
  Protocol, security and invariant rules behind agent sessions as one identity.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "dev-*"
    And agent identities "devtool", "dev-search", "docs" and "release-bot" exist

  Rule: A lease is minted only for an identity the machine may use

    @v1 @api @I-37
    Scenario Outline: The allow-list decides which identities a machine may use
      Given machine "laptop-1" is logged in with allow mode "<mode>" and entries "<entries>"
      When "laptop-1" asks for a lease as "<identity>"
      Then the server answers <status>

      Examples:
        | mode | entries      | identity    | status |
        | list | devtool      | devtool     | 201    |
        | list | devtool      | release-bot | 403    |
        | list | dev-*        | dev-search  | 201    |
        | list | dev-*        | docs        | 403    |
        | any  |              | docs        | 201    |

    @v1 @api @I-37
    Scenario: A disabled identity cannot start a session
      Given the owner disabled "dev-search"
      When "box-2" asks for a lease as "dev-search"
      Then the server answers 403

    @v1 @api @I-37
    Scenario: A human identity cannot be a session identity
      When "box-2" asks for a lease as "drew"
      Then the server answers 403

    @v1 @api @I-25
    Scenario: The machine key works only to mint leases
      When "box-2" calls GET /api/inbox with its machine key instead of a lease
      Then the server answers 401
      And POST /api/sessions with the same key answers 201

  Rule: A retry with the same client id gives a working lease and never two (M5)

    @v1 @api @I-37 @M5 @C-8 @AC-27
    Scenario: Re-minting with the same client id ends the old lease
      Given "box-2" holds lease A as "devtool" for client id "claude-7f3a"
      When "box-2" mints again as "devtool" with client id "claude-7f3a"
      Then the server returns lease B that is different from lease A
      And a request with lease B answers 200
      And a request with lease A answers 401

    # Split out of "Re-minting with the same client id ends the old lease": claims arrive with the inbox in S3.
    @v1 @api @I-37 @M5 @C-8 @AC-27
    Scenario: A re-mint moves the old lease's claims to the new lease
      Given "box-2" holds lease A as "devtool" for client id "claude-7f3a" and lease A holds 2 inbox items
      When "box-2" mints again as "devtool" with client id "claude-7f3a"
      Then the inbox items lease A held are held by lease B with the same claim tokens

    @v1 @api @I-37 @M5
    Scenario: An expired session is ended before a new lease is minted
      Given "box-2" held a lease as "devtool" for client id "claude-7f3a" that expired 1 hour ago
      When "box-2" mints again as "devtool" with client id "claude-7f3a"
      Then the server answers 201 with a new lease
      And Crew → Sessions shows one live session for client id "claude-7f3a"

    @v1 @api @invariant @I-37 @M5
    Scenario: Two concurrent re-mints with one client id leave one working lease
      When "box-2" sends two lease requests as "devtool" with client id "claude-7f3a" at the same time
      Then exactly one of the two returned leases answers 200 on GET /api/me
      And Crew → Sessions shows one live session for client id "claude-7f3a"

  Rule: Many sessions may share one identity, within caps

    @v1 @api @I-33
    Scenario: The 21st live session of one identity is refused
      Given 20 live sessions of "devtool" on "box-2"
      When "box-2" asks for one more lease as "devtool" with a new client id
      Then the server answers 429 with the code "session_cap"

    @v1 @api @I-33
    Scenario: The 201st live session on one machine is refused
      Given 200 live sessions on "box-2" across 10 identities
      When "box-2" asks for one more lease
      Then the server answers 429 with the code "session_cap"

    @v1 @api @I-30
    Scenario: Lease mints are budgeted per identity
      Given "box-2" minted 30 leases as "devtool" in the last hour
      When it mints one more as "devtool"
      Then the server answers 429 with a Retry-After header

  Rule: A lease lives 12 hours, renews while used, and ends cleanly

    @v1 @cli @I-37 @M8
    Scenario: Renewing a lease extends the claims of that session
      Given a session of "devtool" holds 3 inbox items with a 5-minute visibility
      When the session renews its lease 4 minutes later
      Then a second session of "devtool" polling 2 minutes after that gets none of the 3 items

    @v1 @cli @api @I-37 @I-38
    Scenario: Removing an identity from the allow-list ends its leases on that machine
      Given live sessions of "dev-search" on "box-2" and on "laptop-1"
      When the owner removes "dev-*" from the allow-list of "box-2" with a passkey
      Then the next request of the "box-2" session answers 401
      And the "laptop-1" session still answers 200

  Rule: A machine may create identities only when the owner allowed it

    @v1 @api
    Scenario: A machine without create_identity gets a request, not an identity
      When "box-2" asks for a lease as "dev-new" with create set
      Then the server answers 202 with an unguessable request ref
      And Crew does not list "dev-new"
      And asking again with the ref answers 202 until the owner decides

    @v1 @api @I-3
    Scenario Outline: A request for a bad or taken handle is refused when it is filed
      When "box-2" asks for a lease as <handle> with create set
      Then the server answers <status> with the code <code>
      And GET /api/now lists no identity request

      Examples:
        | handle                    | status | code            |
        | "devtool" (exists, "box-2" may not act as it) | 409    | handle_taken    |
        | "admin"                   | 400    | invalid_request |
        | "devtoo1" (a look-alike)  | 400    | invalid_request |

    @v1 @api @I-3
    Scenario: A request that waits does not reserve its handle
      Given "box-2" filed a request for "dev-new" and "laptop-1" filed one too
      When the owner approves the request of "laptop-1"
      Then approving the request of "box-2" answers 409 with the code "handle_taken"

    @v1 @api @I-3
    Scenario: The approval checks the look-alike rule again
      Given "box-2" filed a request for "dev-new"
      And another agent then took the display name "dev-new"
      When the owner approves the request
      Then the server answers 400 naming "handle"

    @v1 @api
    Scenario: Only the machine that filed a request can ask about it
      Given "box-2" filed a request for "dev-new"
      When "laptop-1" asks with the ref of that request
      Then the server answers 404, the same as for a ref that never existed
      And the ref is "idr_" and 32 hex characters, different for every request

    @v1 @api
    Scenario: A request expires after 24 hours and the command is told
      Given "box-2" filed a request for "dev-new"
      When the test clock moves forward 24 hours and 1 second
      Then asking with the ref answers 410 with the code "request_expired"
      And Now lists no identity request
      And the handle "dev-new" is still free

    @v1 @api
    Scenario: A machine files at most 5 requests in a day
      Given "box-2" filed 5 requests today
      When it files a sixth
      Then the server answers 429 with a Retry-After header

    @v1 @api @I-26
    Scenario: Only the owner's session can decide an agent request
      Given "box-2" filed a request for "dev-new"
      When a machine key, a session lease and a caller with no credential each try to approve or decline it
      Then the server answers 401 every time
      And the owner approves it with no step-up and the agent exists

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @api @I-32 @I-17
    Scenario: The card data is plain text, the avatar is cleaned and the join goes through the participants path
      Given "box-2" filed a request for "dev-new" with the description "<b>**hi**</b>", a script in its SVG avatar and conversation 41
      Then Now lists the description as the same plain text
      And the avatar is served from /api/identity-requests/ with a sandboxing CSP and holds no script
      When the owner approves it
      Then "dev-new" is an active participant of conversation 41 and can read the messages before the add
      And an agent that asks for a conversation the owner is not in is refused when it files

    @v1 @api @I-17
    Scenario: With the create_identity scope a conversation join is a request the owner decides
      Given "box-2" has the create_identity scope
      When "box-2" creates "dev-ci" naming conversation 41
      Then "dev-ci" exists at once
      And conversation 41 lists "dev-ci" as waiting for approval

    @v1 @api
    Scenario: A machine creates at most 5 identities per day
      Given "box-2" has the create_identity scope and created 5 identities today
      When it creates a sixth
      Then the server answers 429
