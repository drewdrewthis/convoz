# Contracts for `features/delivery.feature`: who may read the deliveries, and the limits of a deliverable.
# Owner (Drew, conv 179, msg 9734): "maybe a global one with the reminders when due dates p[ass]".

Feature: Deliveries (contracts)
  The owner-only read of every deliverable, and what a plan accepts as one.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is a participant of conversation 41 "Ship search filters"

  Rule: GET /api/deliveries is the owner's alone

    @v1 @api
    Scenario: Only the owner reads the deliveries
      Given "devtool" sends PUT /api/conversations/41/plan with deliver "Search filters live" due "2d"
      When the owner sends GET /api/deliveries
      Then the server answers 200 with one delivery: conversation 41, its title, "devtool", the text, the due time, the state "on_track" and the plan's update time
      And "devtool" gets 401 or 403 for the same GET with its lease
      And a member who is not the owner gets 403

  Rule: A deliverable has a due date ahead, and a plan holds at most 5

    @v1 @api
    Scenario: A due date is a duration, a time or a date ahead, and a plan holds at most 5 deliverables
      When "devtool" sends a plan with deliver "A" due "tomorrow"
      Then the server answers 400 with the field "due"
      And a plan with deliver "A" due "2026-01-01 10:00" (in the past) answers 400 with the field "due"
      And a plan with 5 deliverables due "2d", "18:00", "1d4h", "30m" and "60d" is accepted
      And one more deliverable "F" due "2d" answers 400 with the field "deliver", and the plan keeps its 5
      And a plan with done "A" ships "A" and keeps 4
