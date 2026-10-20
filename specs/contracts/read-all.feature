# Contracts for `features/read-all.feature`: who may do what with the read-all right (migration 0038, owner msgs 784 and 1123).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: An agent that reads all conversations (contracts)
  Protocol and security rules behind the read-all right: the one write it allows, the writes it never allows, and who may give it.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "triage" and "devtool"
    And conversation 41 "Ship search filters" has "drew" and "devtool", and "triage" is not in it

  Rule: The right opens reads and one write, nothing else

    @v1 @api
    Scenario: Without the right an agent is refused a conversation it is not in
      When "triage" reads conversation 41, lists conversations and posts in conversation 41
      Then every call is refused with 403 and the list is empty

    @v1 @api
    Scenario: With the right an agent reads every part of a conversation it is not in
      Given the owner turned on reading everything for "triage"
      When "triage" lists conversations, gets conversation 41, its messages, a thread, a message's edits and an ask of it
      And "triage" searches for a word of conversation 41
      Then every call answers 200 and the list holds conversation 41
      And a conversation in the trash is refused with 403

    @v1 @api
    Scenario: With the right an agent changes nothing in a conversation it is not in
      Given the owner turned on reading everything for "triage"
      And "devtool" asked an open ask in conversation 41
      When "triage" renames conversation 41, adds "docs" to it, starts an upload in it, writes a plan in it, says it is typing in it and answers or withdraws the ask
      And "triage" edits a message of "devtool" in it
      Then every call is refused with 403

    @v1 @api
    Scenario: The right is looked up on every request
      Given the owner turned on reading everything for "triage"
      And "triage" read conversation 41 with its session
      When the owner turns it off
      Then the same session reading conversation 41 is refused with 403 on its next request

    @v1 @api
    Scenario: An agent session cannot open the event stream, with the right or without
      Given the owner turned on reading everything for "triage"
      When "triage" opens the event stream
      Then it is refused with 403

  Rule: Only the owner, with a fresh passkey check, gives the right

    @v1 @api
    Scenario: Giving the right needs the owner and a passkey check
      When "triage" tries to give itself the right with its session
      And a caller with no credential tries it
      And the owner tries it with no passkey check
      Then the answers are 401, 401 and 403 "step_up_required"
      And "triage" still cannot read conversation 41

    @v1 @api
    Scenario: The right is for an agent that is there
      When the owner gives the right to the owner's own identity and to an identity that does not exist
      Then both are refused with 404

    @v1 @api
    Scenario: Giving and taking the right is on the Crew list and in the audit trail
      When the owner turns the right on and off for "triage"
      Then the Crew list marks "triage" while it is on and the audit trail holds both changes

    @v1 @api
    Scenario: Only an agent with the right may ask what waits on the owner
      When "triage" asks for what waits without the right
      And the owner asks with a device session
      Then the answers are 403 and 401
