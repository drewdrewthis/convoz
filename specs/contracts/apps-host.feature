# Contracts for `features/apps-host.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/apps-host.feature.
# Source: design draft 9 §4.1 (app-kit, Tier-2 sandbox runtime), SEC-5, I-46, §12.3 (app previews not auto-loaded),

Feature: Apps inside messages (contracts)
  Protocol, security and invariant rules behind apps inside messages.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Tier-1 apps are our own components fed with data

    @v1 @api @I-50 @AC-M3
    Scenario: An app with unknown keys is refused
      When "devtool" posts a Tier-1 chart app with an extra key "onload"
      Then the server answers 400 with the code "app_invalid" and the path "/props/onload"
      And no message, event, search entry or inbox item was written

    @v1 @api @cli @browser @I-50 @AC-M2
    Scenario: Server, CLI and web app agree on every app fixture
      Given the app fixtures in schemas/examples, valid and invalid
      When each is checked by POST /api/apps/validate, "convoz app validate" and the web app validator
      Then all three accept every valid fixture
      And all three reject every invalid fixture with its expected code and path

    @v1 @api @I-50 @AC-M4
    Scenario Outline: App size limits are exact
      When "devtool" sends <item>
      Then the server <result>

      Examples:
        | item                                          | result                                      |
        | an app of exactly 65536 bytes                 | accepts it                                  |
        | an app of 65537 bytes                         | answers 400 with the code "app_too_large"   |
        | a Tier-2 bundle upload of 524288 bytes        | accepts it                                  |
        | a Tier-2 bundle upload of 524289 bytes        | refuses it at upload                        |
        | frame data of 32769 bytes                     | answers 400 with the code "app_too_large"   |

    @v1 @api @I-50 @AC-M5
    Scenario Outline: Apps that act cannot sit on an ask
      When "devtool" posts an ask with <app>
      Then the server answers 400 with the code "app_type_not_allowed_on_ask"

      Examples:
        | app                    |
        | a picker               |
        | a form                 |
        | a checklist in select mode |

    @v1 @api @I-50
    Scenario: An app over 4 KB is a stub in the message page
      Given "devtool" posted a chart app whose props are 20 KB
      When the owner loads the messages page of conversation 41
      Then the app appears as a stub with type, version, title, fallback and size
      And GET /api/messages/:id/app returns the full app

  Rule: Tier-2 apps run sandboxed and cannot reach anything

    @v1 @browser @I-46
    Scenario: A Tier-2 app cannot reach the network
      Given "devtool" posted a Tier-2 app whose script calls fetch("https://example.com")
      When the owner opens it
      Then it renders
      And the browser network log has no request to "example.com"

    @v1 @browser @I-46
    Scenario: A Tier-2 frame runs with scripts only
      Given "devtool" posted a Tier-2 app
      When the owner opens it
      Then its frame has sandbox "allow-scripts" and an empty allow list
      And the frame cannot read the parent page or its cookies

    @v1 @browser @I-46
    Scenario: A message from another frame's port is ignored
      Given two Tier-2 apps are open in conversation 41
      When the first app posts a message that claims to come from the second
      Then the host ignores it and shows no confirm sheet

  Rule: An app result reaches the conversation only by the owner's tap (SEC-5)

    @v1 @api @invariant @I-46 @I-48 @AC-M6
    Scenario Outline: A via_app message must come from a person and point at that agent's app
      When <sender> sends a via_app message that points at <target>
      Then the request is refused
      And the refusal holds even when the test build skips the app checks and writes the row directly

      Examples:
        | sender               | target                                  |
        | the "devtool" lease  | the picker app of "devtool"             |
        | the owner            | a plain text message of "devtool"       |
        | the owner            | the app of "docs" while naming "devtool" |

    @v1 @api @I-50
    Scenario: A result must match its app
      Given the picker app of "devtool" offers "builtin", "vitest" and "jest"
      When the owner sends a via_app result that selects "mocha"
      Then the server answers 400 with the code "app_result_invalid"

    @v1 @browser @I-46 @AC-M7
    Scenario Outline: A hostile frame sends nothing and reaches nothing
      Given a Tier-2 test app whose script <does>
      When the owner opens it and taps nothing
      Then no message is sent
      And the browser request log has no request outside the server's origin

      Examples:
        | does                                                    |
        | calls window.parent.postMessage with a result           |
        | posts a result on its port without a tap                |
        | calls fetch to an outside address                       |
        | writes to localStorage                                  |
        | sets its location to an outside address                 |

    @v1 @api @I-46 @AC-M8
    Scenario Outline: The frame route serves only the right bundle to the right caller
      When <caller> asks for the frame of a Tier-2 app <how>
      Then the server answers <status>

      Examples:
        | caller                    | how                                       | status |
        | the owner's browser       | with the right hash, as an iframe         | 200 with the exact frame CSP |
        | the owner's browser       | with a wrong hash                         | 404    |
        | the "devtool" lease       | with the right hash                       | 403    |
        | the owner's browser       | without "Sec-Fetch-Dest: iframe"          | 400    |
        | the owner's browser       | for a deleted message                     | 404    |

    @v1 @api @I-46
    Scenario: A Tier-2 app on an ask opens, in the conversation and in its thread
      Given "devtool" asked "Ship it?" with a Tier-2 app
      When the owner's browser asks for the frame of the ask
      Then the server answers 200 with the bundle
      And the ask card in the ask's thread carries the app

    @v1 @browser @I-46 @unimplemented
    Scenario: A frame document is cached by its hash
      Given the owner opened a Tier-2 app once
      When the browser goes offline and the owner opens it again
      Then the frame loads from the service worker cache
