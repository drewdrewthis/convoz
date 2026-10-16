# Contracts for `features/console-mobile.feature` (S-U0, Refs #16): the routes, JSON and files the phone console relies on.
# They run end to end like every scenario. The user-facing behaviour lives in specs/features/console-mobile.feature.

Feature: Console on a phone (contracts)
  Public icon files, the recovery-codes count, the this-device mark and the recovery session.

  Background:
    Given a fresh Convoz server

  Rule: Icons and the manifest are public

    @v1 @api
    Scenario: The console serves a favicon, an apple touch icon and a manifest without a sign-in
      When a client with no cookie asks for /favicon.ico, /apple-touch-icon.png and /manifest.webmanifest
      Then each answers 200 with an image type for the icons and a manifest type for the manifest
      And the manifest is named "Convoz", starts at "/", is standalone and lists an icon

    @v1 @api
    Scenario: Every console page links its icons, manifest and theme colour
      When a client with no cookie asks for /signin, /recover and /bootstrap
      Then each page links an icon, an apple touch icon and the manifest
      And each page has a theme-color and a viewport that covers the safe areas

  Rule: Recovery codes can be counted and re-made

    @v1 @api @I-26
    Scenario: The recovery codes count answers how many codes are left
      Given the owner has 10 recovery codes
      When GET /api/me/recovery-codes is asked, after one code was used and after new codes were made
      Then it answers {"remaining": 10}, then {"remaining": 9}, then {"remaining": 10}
      And a client with no cookie gets 401

    @v1 @api @I-26
    Scenario: Making new recovery codes records an event as well as the audit line
      Given the owner made new recovery codes with a passkey check
      When the stored events and the audit view are read
      Then both hold "recovery.regenerated" once
      And neither holds a code

  Rule: The passkeys list tells which passkey this device used

    @v1 @api
    Scenario: The passkeys list marks the passkey this device signed in with
      Given the owner has two passkeys and two devices, each signed in with a different one
      When each device asks for GET /api/me/passkeys
      Then exactly one passkey has "this_device": true, the one that device signed in with
      And each passkey carries "registered_via" and "last_used_at"

  Rule: A recovery code ends in a full session

    @v1 @api @I-26
    Scenario: A passkey added with a recovery code starts a full device session
      Given the owner used a recovery code on a new device
      When the new device registers a passkey
      Then the answer sets a full device cookie and the device can list passkeys
      And GET /api/me tells the codes left and the time the 24-hour hold ends
