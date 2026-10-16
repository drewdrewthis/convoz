# Contracts for `features/composer.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/composer.feature.
# Source: design draft 9 §9 (outbox), §11 (enter_to_send, default_format), §12.2 (send ≤16 ms), §12.3 (uploads),

Feature: Composer (contracts)
  Protocol, security and invariant rules behind composer.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Sending is instant and safe to repeat

    @v1 @browser
    Scenario: A failed send can be retried
      Given the server refuses the next send with 500 five times
      When the owner sends "retry me"
      Then the bubble shows "failed · retry"
      And tapping retry delivers it once

  Rule: Files attach by button or drop and bind once (I-31)

    @v1 @api @I-31
    Scenario: An upload binds to one message only
      Given the owner uploaded "chart.png" and posted it in conversation 41
      When a client posts another message with the same upload id
      Then the server answers 409

    @v1 @api @I-31
    Scenario: An upload cannot be used in another conversation
      Given the owner uploaded "chart.png" for conversation 41
      When a client posts it in conversation 52
      Then the server answers 400

    @v1 @api @I-31
    Scenario: An unfinished upload cannot be posted
      Given an upload of "big.zip" that is half done
      When a client posts a message with it
      Then the server answers 409
