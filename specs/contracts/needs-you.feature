# Contracts for the needs-you field of a message: the request field, the warning, the refusal and the computed wire field.
# Owner said (msg 366): "Maybe the message schema should require a true/false field that says if it requires an action/decision from the user -- this will differentiate regular messages from actual blocking requests. We can probably do a lot of powerful stuff with the schema and validation"
# This release: the field is optional and an absent field counts as false, with a warning header. A later release makes it required for agents.
# `needs_you` on a message is computed: true only for an ask that is open. No column stores it.

Feature: The needs-you field of a message (contracts)
  Protocol rules behind the field that tells news from a request that blocks on the owner.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "dot"
    And "dot" is an active participant of conversation 41 "Ship search filters"

  Rule: An agent post says whether it needs the owner

    @v1 @api
    Scenario: needs_you false is accepted as news
      When "dot" posts "Build is green" with needs_you false
      Then the server answers 201
      And the answer has no Convoz-Warning header
      And the stored message reads needs_you false

    @v1 @api
    Scenario: An absent needs_you is accepted with a warning header
      When "dot" posts "Build is green" without needs_you
      Then the server answers 201
      And the Convoz-Warning header says "needs_you will be required; send needs_you:false for news, or use an ask"
      And the stored message reads needs_you false

    @v1 @api
    Scenario: needs_you true on a plain post is refused with the ask command and the text echoed
      When "dot" posts "Ship it?" with needs_you true
      Then the server answers 422 "needs_you_is_an_ask" naming "needs_you"
      And the message names "convoz ask" with the text "Ship it?" as the question
      And conversation 41 has no message "Ship it?"

    @v1 @api
    Scenario: A reply in a thread follows the same rule
      Given the owner posted "Status?" in conversation 41
      When "dot" replies in that thread with needs_you true
      Then the server answers 422 "needs_you_is_an_ask"
      And "dot" replies in that thread with needs_you false and the server answers 201

    @v1 @api
    Scenario: A refused post spends no rate limit
      When "dot" posts "Ship it?" with needs_you true 40 times
      And "dot" posts "Build is green" with needs_you false
      Then every refusal answers 422 and the last post answers 201

    @v1 @api
    Scenario: The owner posts without needs_you and is never warned
      When the owner posts "Looks good" without needs_you
      Then the server answers 201
      And the answer has no Convoz-Warning header

  Rule: Every message reads needs_you

    @v1 @api
    Scenario: A plain message reads needs_you false
      Given "dot" posted "Build is green" with needs_you false
      When the owner reads conversation 41
      Then the message reads needs_you false

    @v1 @api
    Scenario: An open ask reads needs_you true and an answered ask reads false
      Given "dot" asked a question in conversation 41
      When the owner reads conversation 41
      Then the ask message reads needs_you true
      When the owner answers the ask
      And the owner reads conversation 41
      Then the ask message reads needs_you false
