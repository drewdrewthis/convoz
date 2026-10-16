# Source: design draft 9 §2.1 (principals, device session), §3.6 (passkeys, recovery, break-glass), §9 (install, logout),
# I-1, I-26, AC-2. Passkeys are virtual WebAuthn authenticators in Playwright; the real-phone run is @needs-owner.
# Kept from the draft-6 spec, updated: "login sets a strict session cookie" (now after a passkey, not an owner token).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir. Fake tokens only.

Feature: Onboarding and sign in
  As the owner
  I want to set up Convoz with passkeys and a safe way back in
  So that only I can get in, and I can never lock myself out

  Background:
    Given a fresh Convoz server with no owner yet

  Rule: The first passkey comes from a break-glass link made on the server box (AC-2)

    @v1 @cli @browser @I-1 @AC-2
    Scenario: A bootstrap link registers the first passkey and makes the owner
      When "convoz admin bootstrap-link" runs on the server box
      Then it prints a link of the form "https://convoz.<tailnet>.ts.net/bootstrap#cvz_b_…"
      And opening the link registers a virtual passkey for owner "drew"
      And the app shows Now

    @v1 @api @AC-2
    Scenario: A bootstrap link works once
      Given a bootstrap link was used to register a passkey
      When the link is opened again
      Then the page says the link was already used and registers nothing

    @v1 @api @AC-2
    Scenario: A bootstrap link expires after 10 minutes
      Given a bootstrap link made 10 minutes and 1 second ago
      When the link is opened
      Then the page says the link expired and registers nothing

  Rule: Onboarding sets up a second way in

    @v1 @browser @I-26
    Scenario: Onboarding asks for a second passkey and shows recovery codes once
      Given the owner registered the first passkey
      When onboarding continues
      Then it asks for a passkey on another device or a hardware key
      And it shows 10 recovery codes once with a copy button
      And the codes are not shown again anywhere in the app

    @v1 @browser @I-26
    Scenario: A recovery code lets the owner add a new passkey only
      Given the owner lost every passkey
      When the owner enters a recovery code
      Then the app offers only "Add a passkey"
      And every other device gets the push "Recovery code used" and an offer to sign out all other devices

    @v1 @api @I-26
    Scenario: A recovery code works once
      Given the owner used a recovery code
      When the same code is entered again
      Then the app says the code is not valid

    @v1 @api @I-26
    Scenario: A passkey added by recovery cannot do destructive things for 24 hours
      Given the owner added a passkey through a recovery code 2 hours ago
      When the owner tries to reveal a machine key with that passkey
      Then the app refuses and says the passkey is too new for this action
      And the same action works with that passkey after the test clock passes 24 hours

    @v1 @browser @I-26
    Scenario: The owner cannot remove the last passkey
      Given the owner has one active passkey
      When the owner tries to remove it
      Then the app refuses and says another passkey must be added first

  Rule: Signing in is a passkey and a strict cookie

    @v1 @browser
    Scenario: A device session slides for 30 days and ends at 90
      Given the owner signed in 29 days ago and used the app yesterday
      When the test clock reaches day 91 with daily use
      Then the app asks the owner to sign in again

    @v1 @browser
    Scenario: Logout clears the device
      Given the installed app cached conversations
      When the owner logs out
      Then the app shows sign in
      And no cached conversation is left on the device

  Rule: Installing the app

    @v1 @browser @phone
    Scenario: iPhone users get an Add to Home Screen guide
      Given an iPhone browser that is not in standalone mode
      When the owner opens Settings → Notifications
      Then a guide card explains "Share → Add to Home Screen" before push can be turned on

    @v1 @browser
    Scenario: An update waits for the owner's tap
      Given a new build is deployed while the app is open
      Then the app shows "Update ready · Reload"
      And the new version runs only after the owner taps Reload

    @v1 @browser @phone @needs-owner
    Scenario: The owner sets up Convoz on a real phone
      Given a bootstrap link made on the server box
      When the owner opens it on the phone over Tailscale and registers the phone's passkey
      Then the phone shows Now and the owner can add the laptop as a second passkey
