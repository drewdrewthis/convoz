# Contracts for `features/triage.feature`: who may do what with the triage right (migrations 0038 and 0040, owner msgs 784, 1123 and 1217),
# and the join request any agent can make. Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: A triage agent (contracts)
  Protocol and security rules behind the triage right: the writes it allows, the writes it never allows, who may give it, and the join request.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "triage", "devtool" and "docs"
    And conversation 41 "Ship search filters" has "drew" and "devtool", and "triage" and "docs" are not in it

  Rule: The right opens reads, posting and adding or removing agents, nothing else

    @v1 @api
    Scenario: Without the right an agent is refused a conversation it is not in
      When "triage" reads conversation 41, lists conversations and posts in conversation 41
      Then every call is refused with 403 and the list is empty

    @v1 @api
    Scenario: With the right an agent reads every part of a conversation it is not in
      Given the owner made "triage" a triage agent
      When "triage" lists conversations, gets conversation 41, its messages, a thread, a message's edits and an ask of it
      And "triage" searches for a word of conversation 41
      Then every call answers 200 and the list holds conversation 41
      And a conversation in the trash is refused with 403

    @v1 @api
    Scenario: With the right an agent still cannot change the conversation itself
      Given the owner made "triage" a triage agent
      And "devtool" asked an open ask in conversation 41
      When "triage" renames conversation 41, starts an upload in it, writes a plan in it, says it is typing in it and answers or withdraws the ask
      And "triage" edits a message of "devtool" in it
      Then every call is refused with 403

    @v1 @api
    Scenario: The right is looked up on every request
      Given the owner made "triage" a triage agent
      And "triage" read conversation 41 with its session
      When the owner turns it off
      Then the same session reading conversation 41 is refused with 403 on its next request

    @v1 @api
    Scenario: An agent session cannot open the event stream, with the right or without
      Given the owner made "triage" a triage agent
      When "triage" opens the event stream
      Then it is refused with 403

  Rule: A triage agent adds and removes agents in any conversation

    @v1 @api
    Scenario: A triage agent adds an agent at once, itself included, and removes one
      Given the owner made "triage" a triage agent
      When "triage" adds "docs" to conversation 41 and adds "docs" again
      And "triage" adds itself to conversation 41
      And "triage" removes "docs" from conversation 41
      Then the answers are 201 "active", 200 "active", 201 "active" and 200
      And the conversation holds the lines "@triage added @docs", "@triage joined" and "@triage removed @docs" in that order
      And no add is pending for the owner

    @v1 @api
    Scenario: Only a triage agent's add and removal name it, the owner's keep their plain lines
      Given the owner made "triage" a triage agent
      When "triage" adds "docs" to conversation 41 and removes "devtool" from it
      And the owner adds "devtool" back and removes "docs"
      Then the conversation holds the lines "@triage added @docs", "@triage removed @devtool", "Added @devtool" and "@docs was removed" in that order

    @v1 @api
    Scenario: A triage agent never removes the owner or a person
      Given the owner made "triage" a triage agent
      When "triage" removes "drew" from conversation 41
      Then it is refused with 400 and "drew" is still in conversation 41

    @v1 @api
    Scenario: An agent without the right cannot add in or remove from a conversation it is not in
      When "docs" adds "triage" to conversation 41 and removes "devtool" from it
      Then both are refused with 403 and "devtool" is still in conversation 41

    @v1 @api
    Scenario: An agent in a conversation without the right still only asks to add, and never removes
      When "devtool" adds "docs" to conversation 41 and removes "docs" from it
      Then the add answers 201 "pending" and the remove is refused with 403

    @v1 @api
    Scenario: The right is looked up for adding and removing too
      Given the owner made "triage" a triage agent
      And the owner turned it off
      When "triage" adds "docs" to conversation 41 and removes "devtool" from it
      Then both are refused with 403

    @v1 @api
    Scenario: The owner undoes what a triage agent did
      Given the owner made "triage" a triage agent
      And "triage" added "docs" to conversation 41 and removed "devtool" from it
      When the owner removes "docs" from conversation 41 and adds "devtool" back
      Then "docs" is not in conversation 41 and "devtool" is

  Rule: Any agent asks to join for itself

    @v1 @api
    Scenario: A join request is a pending add of the agent itself
      When "docs" asks to join conversation 41 twice
      Then the answers are 201 "pending" and 200 "pending" and carry no title
      And Now lists one pending add for "docs" on conversation 41 asked by "docs"
      And "docs" still cannot read conversation 41

    @v1 @api
    Scenario: A join request for a conversation that is not there is 404
      When "docs" asks to join conversation 9999 and a conversation in the trash
      Then both answers are 404

    @v1 @api
    Scenario: The owner settles a join request and the agent gets one notice
      Given "docs" asked to join conversation 41 and "triage" asked to join conversation 41
      When the owner approves "docs" and declines "triage"
      Then "docs" has one notice and can read conversation 41
      And "triage" has one notice and cannot read conversation 41

    @v1 @api
    Scenario: A triage agent's join request seats it at once
      Given the owner made "triage" a triage agent
      When "triage" asks to join conversation 41
      Then the answer is 201 "active" and no add is pending for the owner

    @v1 @api
    Scenario: Join requests are limited per agent
      When "docs" asks to join 12 conversations in a row
      Then the first 10 are answered and the rest are 429 with Retry-After

    @v1 @api
    Scenario: Only an agent session can ask to join
      When the owner's device session and a caller with no credential ask to join conversation 41
      Then the answers are 401 and 401

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
    Scenario: Only a triage agent may ask what waits on the owner
      When "triage" asks for what waits without the right
      And the owner asks with a device session
      Then the answers are 403 and 401
