# Contracts for `features/rail.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/rail.feature.
# Source: design draft 9 I-14 (unread math), I-21 (rail order), §8.2, §12.1 (BenchmarkRail_FloorZero1M), AC-13.

Feature: Rail (contracts)
  Protocol, security and invariant rules behind rail.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"

  Rule: Order is the owner's, never the activity's (I-21)

    @v1 @api @I-21
    Scenario: A conversation the owner never touched needs no preferences
      When the owner loads the rail
      Then conversations 41, 52 and 60 come back with no star, no rank and no mute set
