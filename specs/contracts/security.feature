# Contracts for `features/security.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/security.feature.
# Source: design draft 9 §2 (auth, CSRF, step-up), §3.3 (reveal, regenerate, revoke), §3.4 (tailnet wall),

Feature: Security walls (contracts)
  Protocol, security and invariant rules behind security walls.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Rule: The tailnet is a real wall

  Background:
    Given a fresh Convoz server

    @v1 @api @I-41 @AC-24
    Scenario: An unknown Host is refused before auth
      When a request with Host "evil.example:7788" and a valid device cookie arrives
      Then the server answers 421

    @v1 @api @I-41 @AC-24
    Scenario: Tailscale headers from a non-serve peer change nothing
      When a request without credentials carries "Tailscale-User-Login: drew@example.com"
      Then the server answers 401
      And forged "X-Forwarded-For" values over TCP do not move the per-source rate-limit bucket
      And a request carrying "Tailscale-Funnel-Request" is refused with 403

    @v1 @api @I-41 @AC-24
    Scenario: A credential in a query string is refused and never logged
      When a request asks for "/api/me?key=cvz_m_TESTONLY0000000000000000"
      Then the server answers 400
      And the server log contains no "cvz_" string

    @v1 @api @I-41
    Scenario: The Authorization header is never logged
      When 10 agent requests with fake leases are served
      Then the server log contains no "Authorization" value and no "cvz_s_" string

  Rule: Every route needs the right credential

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-6
    Scenario Outline: API routes answer 401 without credentials
      When a client calls <route> with no credential
      Then the server answers 401

      Examples:
        | route                                  |
        | GET /api/me                            |
        | GET /api/now                           |
        | GET /api/conversations                 |
        | POST /api/conversations/41/messages    |
        | GET /api/stream                        |
        | GET /api/inbox                         |
        | GET /api/brief                         |
        | GET /api/files/f_TESTONLY              |
        | POST /api/machines/1/reveal            |

    @v1 @api @invariant @I-6
    Scenario: Every route enforces the auth, scope and role its contract declares
      Given the OpenAPI contract lists the auth, scope and role of every route
      When every route is called with no credential, with a lease that lacks its scope and with a non-owner role
      Then each call answers 401 or 403 exactly as the contract declares

    @v1 @api
    Scenario Outline: Cookie writes need the exact Origin and the Convoz header
      When the owner's device cookie sends POST /api/auth/step-up/options with <headers>
      Then the server answers 403

      Examples:
        | headers                                            |
        | Origin "https://evil.example"                      |
        | no Origin header                                   |
        | the right Origin but no "X-Convoz: 1" header       |

    @v1 @api @I-25
    Scenario: Unknown request fields are refused
      When the owner sends POST /api/auth/step-up/options with an extra field "admin": true
      Then the server answers 400

    @v1 @api @I-25 @AC-14
    Scenario: A revoked machine key is refused
      Given the owner revoked "box-2"
      When "box-2" mints a session lease
      Then the server answers 401

    @v1 @api @invariant @I-25
    Scenario: No credential is stored in plain text
      Given a passkey device, recovery codes, a bootstrap link, a device code, a machine key and a session lease were issued
      When the data dir of the encryption-off test build is scanned
      Then none of the fake token strings is found
      And the machine key copy cannot be decrypted after it is copied to another machine's record

  Rule: Destructive actions need a fresh single-use passkey step-up

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-26
    Scenario Outline: Step-up is required for destructive actions
      When the owner calls <action> with no step-up
      Then the server answers 403 with the code "step_up_required"

      Examples:
        | action                                  |
        | POST /api/machines/1/reveal             |
        | POST /api/machines/1/regenerate         |
        | POST /api/machines/1/revoke             |
        | PATCH /api/machines/1                   |
        | POST /api/crew/agents                   |
        | POST /api/me/recovery-codes             |

    # Split out of "Step-up is required for destructive actions": purge, export and delete-my-data ship in S12.
    @v1 @api @I-26
    Scenario Outline: Step-up is required for data actions
      When the owner calls <action> with no step-up
      Then the server answers 403 with the code "step_up_required"

      Examples:
        | action                                  |
        | POST /api/messages/88/purge             |
        | POST /api/me/export                     |
        | POST /api/me/delete                     |

    @v1 @api @I-26
    Scenario: A step-up works once and for one action
      Given the owner made a step-up for "machine.reveal" on "box-2"
      When the owner uses it to regenerate "box-2"
      Then the server answers 403
      And a reveal of "box-2" with it answers 200
      And a second reveal with it answers 403

    @v1 @api @I-26
    Scenario: A step-up expires after 5 minutes
      Given the owner made a step-up for "machine.reveal" on "box-2" 5 minutes and 1 second ago
      When the owner reveals the key of "box-2" with it
      Then the server answers 403

    @v1 @api @I-26 @I-39
    Scenario: An agent credential can never step up
      When the "devtool" lease calls POST /api/auth/step-up/options
      Then the server answers 403
      And a reveal of "box-2" with the lease answers 401

  Rule: Reveal is a careful, audited, owner-only action (SEC-1)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-39 @AC-14
    Scenario: A used step-up cannot reveal again
      Given the owner revealed the key of "box-2" with step-up "su_1"
      When the owner reveals again with "su_1"
      Then the server answers 403

    @v1 @api @invariant @I-39 @AC-14
    Scenario: The key never appears outside the reveal response
      Given the owner revealed and then regenerated the key of "box-2"
      When the data dir of the encryption-off test build, the stored events, the audit view and the server log are scanned
      Then the fake key strings appear 0 times outside the encrypted copy

    @v1 @api @I-39 @AC-14
    Scenario: A reveal response is never stored and its event holds no key
      When the owner reveals the key of "box-2" with a passkey
      Then the response has "Cache-Control: no-store"
      And the stored events hold one "machine.key_revealed" event without the key

  Rule: Regenerate, revoke and disable take effect on the next request (SEC-4)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @cli @api @I-38 @AC-14
    Scenario: Regenerating a key stops the old key and its leases at once
      Given a "devtool" session on "box-2" is live
      And a "devtool" session on "laptop-1" is live
      When the owner regenerates the key of "box-2"
      Then the next request with the old key answers 401
      And the "box-2" lease answers 401
      And the "laptop-1" session answers 200

    # Split out of "Regenerating a key stops the old key and its leases at once": long polls and claims come with the inbox in S3.
    @v1 @cli @api @I-38 @AC-14
    Scenario: Regenerating a key ends its long polls and frees its claims
      Given a "devtool" session on "box-2" waits with "convoz inbox --wait 60" and holds 2 claimed items
      And a "devtool" session on "laptop-1" is live
      When the owner regenerates the key of "box-2"
      Then the waiting long poll ends within 1 second
      And the 2 items are ready again for the "laptop-1" session

  Rule: Files are served so that they cannot run (SEC-7)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-44 @AC-25
    Scenario Outline: Only safe images and audio are shown inline
      Given "devtool" uploaded <file>
      When the owner fetches the file
      Then the response has Content-Disposition "<disposition>"
      And it has "X-Content-Type-Options: nosniff" and a "sandbox; default-src 'none'" CSP

      Examples:
        | file                         | disposition |
        | "report.html"                | attachment  |
        | "diagram.svg"                | attachment  |
        | "chart.png"                  | inline      |
        | "note.ogg"                   | inline      |
        | "evil.png" that holds HTML   | attachment  |

    @v1 @api @I-44 @AC-25
    Scenario: A pixel bomb is refused before decode
      When "devtool" uploads a 30000 by 30000 PNG
      Then the server refuses it with "image too large"
      And the server's memory stays under its limit

    @v1 @api @I-31 @I-44
    Scenario: The size cap applies to the bytes streamed
      When "devtool" streams more bytes than the size it declared
      Then the server stops the upload at the cap and answers 413

    @v1 @api @I-31
    Scenario: Uploads have a daily byte quota per identity
      Given "devtool" uploaded 500 MB today
      When it starts another upload
      Then the server answers 429

    @v1 @api @I-32
    Scenario Outline: Avatar SVGs are cleaned and fenced
      When "devtool" sets an avatar SVG that <content>
      Then <result>

      Examples:
        | content                       | result                                                      |
        | holds a script element        | the served avatar has no script element                     |
        | holds a DOCTYPE               | the server answers 400                                      |
        | holds an ENTITY declaration   | the server answers 400                                      |
        | is plain shapes               | the avatar is served with "default-src 'none'; sandbox" and nosniff |

    @v1 @api @invariant @I-27
    Scenario: A blob moved to another file id cannot be read
      Given two uploaded files on disk
      When the test swaps their encrypted blob files
      Then fetching either file answers an error and returns no bytes

  Rule: Markdown cannot run code or leak reads (SEC-8)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @browser @I-45 @AC-25
    Scenario: A remote image never loads
      When "devtool" posts "![](https://remote.example/p.png)"
      Then the owner sees a link to "remote.example"
      And the browser request log has 0 requests to "remote.example"

  Rule: Apps and agents cannot act as the owner (SEC-5, SEC-6)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-17 @AC-26
    Scenario: People an agent lists in a new conversation are pending
      When "devtool" creates a conversation listing "@docs"
      Then "docs" is listed as pending
      And "docs" cannot read the conversation until the owner approves

    @v1 @api @I-47 @AC-26
    Scenario: A conversation not opened for pickup cannot be picked up
      Given machine "box-2" has the pickup scope
      When "devtool" runs "convoz pickup 41" for a conversation nobody opened for pickup
      Then the server answers 403

    @v1 @api @I-40
    Scenario: The audit trail names machine and session
      When "devtool" on "box-2" posts, asks, uploads and acks
      Then each matching audit and message detail names machine "box-2" and the session label
