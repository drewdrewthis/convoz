# Contracts for `features/brief-handoff.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/brief-handoff.feature.
# Source: design draft 9 §3.8 (recontextualize), I-6, I-7, I-24, AC-19.

Feature: Brief, handoff, read and search for agents (contracts)
  Protocol, security and invariant rules behind brief, handoff, read and search for agents.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And the brief fixture: "devtool" has unread inbox items, an unacked answer, an open ask, 3 changed conversations, a decision from 2 days ago and 2 handoff notes
    And the fixture has a conversation "Secret merger plan" that "devtool" is not in

  Rule: A handoff note carries context to the next session

    @v1 @api @unimplemented
    Scenario: Another agent cannot read the handoff notes of devtool
      Given an agent session as "docs"
      When it calls GET /api/handoffs for identity "devtool"
      Then the server answers 403
