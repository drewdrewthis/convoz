# Contracts for `features/now.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/now.feature.
# Source: design draft 9 §4.2 (`now`: asks, pending adds, machine requests), §8.1, §9 (badge, deep links),

Feature: Now (contracts)
  Protocol, security and invariant rules behind now.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: Agent adds wait for a human (pending adds)

    @v1 @api @I-17
    Scenario: A human cannot be the target of a pending add
      When "devtool" requests to add the owner to conversation 52
      Then the server answers 400
