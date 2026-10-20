# Contracts for `features/voice-call.feature`: the one-use token, who may ask for it, its limit, the page policy and the voice-call mark.
# Owner said (msg 778): "it would probably be dope to be able to call the agent in the convo. Using a good voice - Gemini realtime is the winner I think? Or OpenAI. Investigate? Multiple agents? TTS <> STT?"
# Google's token service is a fake inside the test build: it records what the server sent.

Feature: Voice call (contracts)
  Protocol, security and limit rules behind the voice call.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "dot" and "ops"
    And "dot" is an active participant of conversation 41 "Ship search filters"

  Rule: The token is one use, short, and tied to one set-up

    @v1 @api
    Scenario: The owner gets a one-use token that locks the model, the instructions and the tools
      Given voice is on with the key "TESTONLY-gemini"
      When the owner asks for a voice token for conversation 41
      Then the server answers 200 with a token, the model, the socket address and an expiry
      And the token service was asked for 1 use, a new-session window of 2 minutes and a lifetime of 30 minutes
      And it was asked to lock the model "gemini-3.8-live", the instructions and the tool list
      And the instructions name "Ship search filters" as untrusted text and "dot" as the agent
      And the key "TESTONLY-gemini" is nowhere in the answer

    @v1 @api
    Scenario: An agent cannot get a voice token
      Given voice is on with the key "TESTONLY-gemini"
      When "dot" asks for a voice token for conversation 41
      Then the server answers 403
      And the token service was not asked

    @v1 @api
    Scenario: A conversation the owner cannot see gets no token
      Given voice is on with the key "TESTONLY-gemini"
      When the owner asks for a voice token for conversation 9999
      Then the server answers 404
      And the token service was not asked

    @v1 @api
    Scenario: Without a key there is no voice
      When the owner asks whether voice is on
      Then the server answers 200 with off
      And asking for a voice token answers 404 "voice_off"

    @v1 @api
    Scenario: With transcription off there is no voice, whatever the key
      Given voice is on with the key "TESTONLY-gemini"
      And the workspace transcription is "none"
      When the owner asks whether voice is on
      Then the server answers 200 with off and the reason "transcription is off"
      And asking for a voice token answers 404 "voice_off"

    @v1 @api
    Scenario: The owner gets at most 20 voice tokens an hour
      Given voice is on with the key "TESTONLY-gemini"
      When the owner asks for 20 voice tokens for conversation 41
      And the owner asks for a voice token for conversation 41
      Then the server answers 429 with a Retry-After header

  Rule: The page may reach Google only when voice is on

    @v1 @api
    Scenario: The page policy names Google's address only when voice is on
      When the owner loads the app page and the first-screen page
      Then neither policy names "generativelanguage.googleapis.com"
      Given voice is on with the key "TESTONLY-gemini"
      When the owner loads the app page and the first-screen page
      Then both policies allow "https://generativelanguage.googleapis.com" and "wss://generativelanguage.googleapis.com" to connect, and nothing else new

  Rule: A message made by a call says so

    @v1 @api
    Scenario: Only the owner can mark a message as sent by a voice call
      When "dot" posts a message marked as sent by a voice call
      Then the server answers 403 naming "via_voice"

    @v1 @api
    Scenario: The mark is stored with the message and shown to every reader
      When the owner posts "@dot is the deploy done?" marked as sent by a voice call
      Then reading conversation 41 shows that message with the mark
      And the same message without the mark shows none

  Rule: The call log is quiet

    @v1 @api
    Scenario: Only the owner's voice call posts a quiet message, and it wakes no agent
      When "dot" posts a quiet message
      Then the server answers 403 naming "quiet"
      When the owner posts a quiet message that is not marked as sent by a voice call
      Then the server answers 403 naming "quiet"
      When the owner's voice call posts a quiet message that mentions "@dot"
      Then the message is stored and "dot" has no inbox item for it
