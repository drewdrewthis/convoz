# Source: design draft 9 §2 (auth, CSRF, step-up), §3.3 (reveal, regenerate, revoke), §3.4 (tailnet wall),
# SEC-1…SEC-8, I-6, I-25, I-26, I-27, I-31, I-32, I-38, I-39, I-41, I-44, I-45, I-46, I-47, AC-14, AC-24, AC-25, AC-26.
# Kept from the draft-6 spec, updated: every API route answers 401 without credentials (new route list),
# a foreign Origin is refused, an unlisted Host is refused (now 421), off the tailnet there is no connection,
# a revoked credential is refused (now a machine key), a rich message cannot reach the network (now in apps-host).
# Dropped as superseded: "the page itself answers 401" (the PWA shell is public; the API is not),
# "login with the owner token" (passkeys), "only the owner adds agents and the token is shown once" (no agent keys).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir. Fake tokens only.

Feature: Security walls
  As the owner
  I want the tailnet wall, credentials and untrusted content handled so that one mistake cannot leak or forge anything
  So that I can let many agents in without fear

  Rule: The tailnet is a real wall

  Background:
    Given a fresh Convoz server

    @v1 @api @I-41 @AC-24
    Scenario: The server listens only on its socket or loopback
      When the server has started
      Then the only listening addresses of the server process are its Unix socket or 127.0.0.1

    @v1 @cli @I-41 @AC-24
    Scenario: The server refuses to start when funnel is on
      Given a fake tailscale command that reports funnel on for the server port
      When "convoz serve" starts
      Then it exits non-zero with a message that funnel must be off

    @v1 @browser @needs-owner
    Scenario: A device off the tailnet cannot connect
      When a phone with Tailscale off opens the server address
      Then the connection fails before any page loads

  Rule: Reveal is a careful, audited, owner-only action (SEC-1)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @browser @api @I-39 @AC-14 @C-2 @unimplemented
    Scenario: A valid reveal shows the key once and leaves a trail
      When the owner reveals the key of "box-2" with a passkey
      Then the key is shown once with a copy button and the hint "Paste into convoz login --stdin on the machine, never into an agent prompt."
      And the owner's audit view lists one "key revealed · box-2"
      And every other device of the owner gets the push "Key revealed · box-2"

    @v1 @browser @I-39 @unimplemented
    Scenario: The service worker never caches a reveal
      Given the installed app revealed the key of "box-2"
      When the browser goes offline and the reveal page is opened again
      Then no key is shown and the Cache Storage holds no machine response

  Rule: Regenerate, revoke and disable take effect on the next request (SEC-4)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @api @I-38
    Scenario: Revoking one machine leaves the others working
      When the owner revokes "box-2"
      Then every command of the "box-2" sessions exits 3
      And the "laptop-1" sessions keep working

    @v1 @api @I-38 @I-47
    Scenario: Revoking a machine releases its pickups
      Given a "devtool" session on "box-2" picked up conversation 60
      When the owner revokes "box-2"
      Then conversation 60 shows as open for pickup again

    @v1 @api @I-38
    Scenario: Disabling an identity ends its sessions on every machine
      Given "devtool" sessions on "box-2" and "laptop-1"
      When the owner disables "devtool" with a passkey
      Then the next command of both sessions exits 3
      And other identities on "box-2" still work

  Rule: Markdown cannot run code or leak reads (SEC-8)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @browser @I-45 @AC-25
    Scenario Outline: Dangerous link schemes render as text
      When "devtool" posts a link to <target>
      Then the owner sees it as plain text, not a link

      Examples:
        | target                          |
        | "javascript:alert(1)"           |
        | "java&#115;cript:alert(1)"      |
        | "java\tscript:alert(1)"         |
        | "data:text/html,<b>x</b>"       |

    @v1 @browser @I-45
    Scenario: An external link shows its real host
      When "devtool" posts "[docs](https://evil.example/login)"
      Then the owner sees the host "evil.example" next to "docs"
      And the link has rel "noopener noreferrer"

    @v1 @browser @I-45
    Scenario: An image from an own upload renders inline
      Given "devtool" uploaded "chart.png"
      When it posts markdown that shows that upload as an image
      Then the owner sees the image in the conversation

  Rule: Apps and agents cannot act as the owner (SEC-5, SEC-6)

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And machine "laptop-1" is logged in with allow-list "devtool"

    @v1 @browser @I-46 @AC-25 @unimplemented
    Scenario: An app cannot send without the owner's tap
      Given a Tier-2 app message from "devtool" whose script posts a result on load
      When the owner opens the conversation and taps nothing
      Then no message is sent
      And a confirm sheet drawn by the host shows the proposed result

    @v1 @browser @cli @I-46 @AC-25 @unimplemented
    Scenario: A message sent through an app is attributed
      Given a Tier-2 app message from "devtool"
      When the owner confirms its result on the host sheet
      Then the conversation shows the message with "via app by @devtool"
      And "convoz read 41" shows the same attribution

    @v1 @cli @I-47 @AC-26
    Scenario: A pickup gives no history before the pickup
      Given machine "box-2" has the pickup scope
      And the owner opened conversation 60 with 12 messages for pickup
      When "devtool" picks it up
      Then "convoz read 60" shows no message older than the pickup
