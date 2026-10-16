# Contracts for `features/voice.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/voice.feature.
# Source: design draft 9 §12.3 (resumable uploads, "voice notes start uploading while recording"), §6.2 (blobs),

Feature: Voice notes (contracts)
  Protocol, security and invariant rules behind voice notes.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the browser has a fake microphone that plays a fixture recording
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Audio is stored and served safely

    @v1 @api @I-44
    Scenario: Audio is served inline with safe headers
      Given the owner sent a voice note
      When a client fetches its file
      Then it is served inline with "nosniff" and the sandbox CSP

    @v1 @cli @invariant @I-27
    Scenario: No plain audio touches the disk while uploading
      Given the server runs with a data dir the test can scan
      When the owner records and sends a voice note with a known audio fixture
      Then a scan of the data dir during and after the upload finds no run of the fixture's bytes
