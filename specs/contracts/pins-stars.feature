# Contracts for `features/pins-stars.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/pins-stars.feature.
# Source: design draft 9 §2.3 (pin, star, mute, read state per user), §4.2 (`prefs` and `pins`), I-21, I-22.

Feature: Pins, stars and mute (contracts)
  Protocol, security and invariant rules behind pins, stars and mute.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" exist with "devtool"

  Rule: Pins collect key messages per conversation

    @v1 @api @unimplemented
    Scenario: An agent cannot pin or star
      When "devtool" pins a message in conversation 41
      Then the server answers 403
      And starring conversation 41 as "devtool" also answers 403
