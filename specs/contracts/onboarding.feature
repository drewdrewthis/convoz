# Contracts for `features/onboarding.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/onboarding.feature.
# Source: design draft 9 §2.1 (principals, device session), §3.6 (passkeys, recovery, break-glass), §9 (install, logout),

Feature: Onboarding and sign in (contracts)
  Protocol, security and invariant rules behind onboarding and sign in.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with no owner yet

  Rule: The first passkey comes from a break-glass link made on the server box (AC-2)

    @v1 @api @AC-2 @unimplemented
    Scenario: No HTTP route can make a bootstrap link
      When every route in the API contract is called with the owner's cookie
      Then none of them returns a "cvz_b_" token

    @v1 @api @invariant @I-1 @unimplemented
    Scenario: There is only ever one owner
      Given the owner "drew" exists
      When a second bootstrap link registers a passkey
      Then the passkey belongs to "drew"
      And GET /api/identities lists one owner

  Rule: Onboarding sets up a second way in

    @v1 @api @I-26 @unimplemented
    Scenario: Recovery attempts are limited for everyone
      Given 10 wrong recovery codes were posted in the last hour from different devices
      When a correct code is posted
      Then the server answers 401 with the same body as a wrong code

  Rule: Signing in is a passkey and a strict cookie

    @v1 @browser @unimplemented
    Scenario: Sign in sets a strict device cookie
      Given owner "drew" has a passkey
      When the owner signs in with the passkey
      Then the response sets "__Host-convoz_sid" with Secure, HttpOnly and SameSite=Strict
      And the cookie value is not the passkey id

    @v1 @api @unimplemented
    Scenario: Logout revokes the device and clears site data
      When the owner calls POST /api/auth/logout
      Then the response carries "Clear-Site-Data"
      And the old device cookie answers 401
