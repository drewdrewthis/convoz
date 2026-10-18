# Contracts for `features/poor-network.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/poor-network.feature.
# Source: design draft 9 §9 (PWA offline), §12.2 (client budget), §12.3 (poor connections), §12.5 (DERP), AC-10, AC-20.

Feature: Poor connections (contracts)
  Protocol, security and invariant rules behind poor connections.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Nothing sent is lost or doubled (AC-20)

    @v1 @browser @lossy @I-23 @AC-20
    Scenario: A dropped event stream resumes with no gap
      Given the owner's browser follows the event stream on the lossy profile
      When the stream is cut and "devtool" posts 5 messages before it reconnects
      Then the browser reconnects with Last-Event-ID
      And the HAR shows no skipped sequence number and all 5 messages appear

  Rule: The live link degrades gracefully

    @v1 @browser @lossy
    Scenario: Two stream failures in a minute switch to long polling
      Given the event stream fails twice within 60 seconds
      When "devtool" posts "still there?"
      Then the browser shows the message through GET /api/sync with wait 25
      And the browser returns to the event stream once it works again

    @v1 @browser
    Scenario: The stream sends a heartbeat every 15 seconds
      When the owner's browser holds the event stream open for 50 seconds with no events
      Then the browser received at least 3 heartbeat comments

    @v1 @api
    Scenario: Responses over 1 KB are compressed
      When a client that accepts brotli loads a page of 50 typical text messages
      Then the response is brotli-compressed and at most 12 KB on the wire

    @v1 @browser
    Scenario Outline: Only a revoking 401 clears the offline cache
      Given the installed app has cached conversation 41
      When the next request gets <response>
      Then the cache is <outcome>

      Examples:
        | response                        | outcome |
        | a 502                           | kept    |
        | a 401 with "token_invalid"      | kept    |
        | a 401 with "device_revoked"     | cleared |
        | a 401 with "session_expired"    | cleared |

  Rule: The app is fast on a mid-range phone (AC-10)

    @v1 @browser @phone @lossy @AC-10 @unimplemented
    Scenario Outline: The first useful screen appears in budget
      Given a mid-range phone profile with CPU slowed 4 times on the <network> profile
      When the app starts <start>
      Then the rail and Now are useful within <budget>

      Examples:
        | network | start                      | budget  |
        | Fast-3G | warm from IndexedDB        | 300 ms  |
        | lossy   | warm from IndexedDB        | 300 ms  |
        | Fast-3G | cold with an empty cache   | 1.5 s   |
        | lossy   | cold with an empty cache   | 4 s     |

    @v1 @browser @AC-10
    Scenario: The initial download stays small
      When the production build is measured
      Then the initial JavaScript is at most 150 KB and the CSS at most 20 KB with brotli

    @v1 @browser @AC-10
    Scenario: A cold first screen comes in one response
      When the owner opens Now and the conversation list with an empty cache
      Then each document carries the screen's code, its stylesheet and its first reads, and the screen draws from them
      And the browser reports no Content-Security-Policy violation

    @v1 @browser @I-39
    Scenario: The service worker never caches a page with user data
      Given the owner opened Now and the conversation list, and the service worker controls the app
      When both pages open again through the service worker
      Then Cache Storage holds no page with a data block

    @v1 @browser
    Scenario: A page back from the back-forward cache checks the session again
      Given the owner has Now open
      When the session ends and the page comes back from the back-forward cache
      Then the browser opens sign in

    @v1 @browser
    Scenario: My own message shows at once
      When the owner sends "on it" in conversation 41
      Then the bubble shows within 16 ms of the send
