# Contracts for `features/asks.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/asks.feature.
# Source: design draft 9 §8.1 (ask state machine, DA-5), I-10…I-13, I-15, I-19, I-24, AC-4, AC-13.

Feature: Asks and their state machine (contracts)
  Protocol, security and invariant rules behind asks and their state machine.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: An ask has a question, a recommendation and at least one alternative, each with a reason

    @v1 @api @I-11 @AC-13
    Scenario Outline: An incomplete or oversized ask is refused
      When "devtool" posts an ask with <problem>
      Then the server answers 400 naming "<field>"
      And Now shows no new ask

      Examples:
        | problem                                 | field        |
        | no alternative                          | alternatives |
        | an empty reason for the recommendation  | why          |
        | a reason of 281 characters              | why          |
        | 5 alternatives                          | alternatives |
        | a question of 501 characters            | question     |
        | no owners_call                          | owners_call  |
        | an owners_call kind of "whim"           | owners_call  |
        | an owners_call reason of 0 characters   | owners_call  |
        | an owners_call reason of 281 characters | owners_call  |

    @v1 @api
    Scenario: A refused ask tells the agent to decide and the stored ask keeps why it is the owner's call
      When "devtool" posts an ask without owners_call
      Then the server answers 400 naming "owners_call" with the words "Decide this yourself"
      When "devtool" posts an ask with owners_call kind "scope" and reason "Which teams get the beta is yours to set"
      Then the server answers 201 and the ask in Now and in GET shows owners_call kind "scope" and that reason

    @v1 @api
    Scenario: Only an agent with the ask scope asks
      Given machine "laptop-1" has no ask scope and runs "docs"
      When "docs" on "laptop-1" posts a valid ask
      Then the server answers 403

    @v1 @api
    Scenario: A human cannot post an ask
      When the owner posts a valid ask with the device cookie
      Then the server answers 403

    @v1 @api
    Scenario: An identity holds at most 20 open asks
      Given "devtool" has 20 open asks
      When "devtool" posts another valid ask
      Then the server answers 429 with the code "ask_cap"

    @v1 @api @invariant @I-10
    Scenario: Ask content never changes after it is posted
      Given an open ask of "devtool" with the question "Merge #415 on its own?"
      When "devtool" tries to edit the ask message or its options
      Then the server refuses the change
      And GET /api/now shows the original question and options

  Rule: Every transition follows the state table; anything else is a conflict

    @v1 @api @I-12 @I-13 @C-4 @C-5 @AC-29
    Scenario Outline: Ask transitions
      Given an ask of "devtool" in state "<from>"
      When <actor> sends "<event>"
      Then the server answers <status>
      And the ask is in state "<to>"

      Examples:
        | from      | actor           | event     | status | to                 |
        | open      | the owner       | answer    | 200    | answered           |
        | open      | the owner       | dismiss   | 200    | dismissed          |
        | dismissed | the owner       | answer    | 200    | answered           |
        | dismissed | the owner       | undismiss | 200    | open               |
        | dismissed | the owner       | dismiss   | 200    | dismissed          |
        | open      | "devtool"       | withdraw  | 200    | closed (withdrawn) |
        | dismissed | "devtool"       | withdraw  | 200    | closed (withdrawn) |
        | answered  | the owner       | dismiss   | 409    | answered           |
        | answered  | "devtool"       | withdraw  | 409    | answered           |
        | closed    | the owner       | answer    | 409    | closed             |
        | open      | "docs"          | withdraw  | 403    | open               |
        | answered  | the same owner, same choice  | answer | 200 | answered          |
        | answered  | the owner, another choice    | answer | 409 | answered          |
        | open      | the owner       | snooze    | 200    | open               |
        | dismissed | the owner       | snooze    | 409    | dismissed          |
        | answered  | the owner       | snooze    | 409    | answered           |

    @v1 @api @invariant @I-12 @AC-4 @C-4
    Scenario: Fifty racing answers produce one decision
      Given an open ask of "devtool"
      When 50 answer requests with 50 different custom texts arrive at the same time
      Then exactly 1 answers 200
      And 49 answer 409 with the winning text
      And re-sending the winning text as the same owner answers 200 and writes nothing
      And conversation 41 shows exactly 1 answer message
      And the owner's unread state of conversation 41 is unchanged

    @v1 @api @I-12
    Scenario: Undismiss after the asker left is refused
      Given a dismissed ask of "devtool"
      And "devtool" left conversation 41
      When the owner undismisses the ask
      Then the server answers 409 with the code "asker_gone"

    @v1 @api @I-12
    Scenario: Undismiss respects the open-ask cap
      Given a dismissed ask of "devtool" and 20 other open asks of "devtool"
      When the owner undismisses the ask
      Then the server answers 409 with the code "ask_cap"

    @v1 @cli @I-12
    Scenario: A repeated ack is a no-op
      Given "devtool" acked the answer to its ask
      When "devtool" acks the same item again with the same claim token
      Then the CLI exits 0

  Rule: Answers are explicit and idempotent

    @v1 @api
    Scenario: A choice the ask did not offer is refused
      Given an open ask of "devtool" with 1 alternative
      When the owner answers with alternative 3
      Then the server answers 400
      And conversation 41 shows no answer message

    @v1 @api @cli @C-3
    Scenario: There is no answer path for agents or the CLI in v1
      When the "devtool" lease calls POST /api/asks/:id/answer on an open ask
      Then the server answers 403
      And "convoz --help" lists no answer command

    @v1 @api @I-12 @C-6
    Scenario: The ask history is append-only and names every actor
      Given an ask of "devtool" that the owner dismissed and undismissed, and that "devtool" then withdrew
      When a client reads GET /api/asks/:id
      Then the history has the rows create by "devtool", dismiss by the owner, undismiss by the owner and withdraw by "devtool", in version order
      And no route can change or delete a history row

  Rule: Snooze is a personal overlay that never changes the ask

    @v1 @api @I-13
    Scenario: Snoozing does not change the ask version
      Given an open ask of "devtool" at version 1
      When the owner snoozes it until tomorrow 09:00
      Then GET /api/now shows the ask under snoozed with version 1
      And an answer sent with if_version 1 answers 200

  Rule: A draft ask is checked and answered by its own rules

    @v1 @api
    Scenario: A draft ask is checked, stored with a fixed owner's call and answered with Send or Don't send
      When "devtool" posts a draft ask with a draft of 4001 characters
      Then the server answers 400 naming "draft"
      When "devtool" posts a draft ask with an original of 2001 characters
      Then the server answers 400 naming "original"
      When "devtool" posts an ask with owners_call kind "in-your-name" and options but no draft
      Then the server answers 400 naming "owners_call" with the words "draft ask only"
      When "devtool" posts a draft ask with no owners_call and no options
      Then the server answers 201 and GET shows owners_call kind "in-your-name" with the reason "It goes out in your name.", the draft and the options "Send" and "Don't send"
      When the owner answers "recommended" with a text of 4001 characters
      Then the server answers 400 naming "text"
      When the owner answers "custom" with a text
      Then the server answers 400 naming "choice"
      When the owner answers "recommended" with the text "Final words"
      Then GET shows the reply send true with the text "Final words" and the answer "Send: Final words"

  # Drew, conv 349 msg 6199: see the rule "An ask is a permission request" of specs/features/asks.feature.
  Rule: A permission ask is checked, told apart from a decision and a draft, and answered with Go or Not this

    @v1 @api
    Scenario: A permission ask opens with its parts and is told apart from a decision and a draft
      When "devtool" posts a permission ask with no question and no owners_call
      Then the server answers 201 and the ask is open, of kind "permission", with its parts, the action as its question and the options Go and Not this
      And an ask in the old shape reads as kind "decision" with no permission object
      And a draft ask reads as kind "draft"

    @v1 @api
    Scenario: A permission ask that is incomplete or over a limit is refused naming the field
      When "devtool" posts a permission ask that is over a limit, empty, whitespace-only, with undo and one_way together or neither, with 0 or 4 considered lines, with a confidence of -1, 101 or 80.5, or together with a draft
      Then the server answers 400 naming the field, each time, and Now shows no new ask
      And an action of 100 characters is accepted and one of 101 is refused with "Shorten: action has at most 100 characters"

    @v1 @api
    Scenario: A confidence under 80 is refused and 80 is accepted
      When "devtool" posts a permission ask with a confidence of 79, 0 or none
      Then the server answers 400 with the text "Get confident first: research it or run it by @advisor, then ask with --confidence 80 or more. Never hand the owner the thinking."
      When "devtool" posts it with a confidence of 80
      Then the server answers 201

    @v1 @api
    Scenario: Go and Not this answer a permission ask
      Given two open permission asks of "devtool"
      When the owner answers the first with Go and the second with Not this and the reason "Wait for PR 412"
      Then the answers read "Go" and "Not this: Wait for PR 412" for the owner, in conversation 41 and in the inbox of "devtool"
      And a second, different answer to the first ask is refused with 409

    @v1 @api
    Scenario: A Not this answer without a good reason is refused
      Given an open permission ask of "devtool"
      When the owner answers Not this with no text, with whitespace only or with 4001 characters, or answers Go with a text
      Then the server answers 400 naming "text" and the ask stays open

    @v1 @api
    Scenario: The agent rewrites the parts of its permission ask
      Given an open permission ask of "devtool"
      When "devtool" updates the action and the considered lines
      Then the ask shows the new parts, its question is the new action and "changed" reads exactly "action, considered"
      When "devtool" updates the ask to one_way true
      Then the ask is one-way and has no undo

    @v1 @api
    Scenario: A permission update that changes the wrong thing is refused
      Given an open permission ask of "devtool", an open decision ask and an open draft ask
      When "devtool" updates the permission ask with undo and one_way together, with a new confidence or with an action of 101 characters
      Then the server answers 400 naming "undo", "confidence" and "action"
      When "devtool" updates the decision ask or the draft ask with permission fields
      Then the server answers 400

    @v1 @cli
    Scenario: The CLI asks for permission and refuses a low confidence
      When "devtool" runs "convoz ask" with --action, --risk, --undo, two --considered and --confidence 79
      Then the command exits 2, stdout and stderr carry the get-confident text and the owner sees no new ask
      When "devtool" runs it with --confidence 80
      Then the command succeeds, prints the id and the owner sees a permission ask with both considered ways
      When "devtool" runs it with --one-way instead of --undo
      Then the command succeeds

    @v1 @cli
    Scenario: Old ask flags still make a decision ask and mixing them with the new flags is refused
      When "devtool" runs "convoz ask" with the old flags --question, --recommend, --alt and --owners-call
      Then the command succeeds, stderr is the one line "hint: use --action ... for a permission ask" and the owner sees a decision ask
      When "devtool" runs "convoz ask" with --action and --recommend
      Then the command exits 2 and the owner sees no new ask

    @v1 @mcp
    Scenario: The ask tool takes a permission request and refuses a low confidence
      When the "ask" tool is called with an action, a risk, an undo, considered lines and confidence 79
      Then the tool is refused with the get-confident text and the owner sees no new ask
      When the "ask" tool is called with confidence 80
      Then the owner sees a permission ask with those parts

    @v1 @api
    Scenario: A permission ask pushes what the agent will do
      Given the owner is subscribed to push
      When "devtool" asks permission to "Merge PR 415 into main"
      Then the push body reads "@devtool will: Merge PR 415 into main"
      When "devtool" asks an old-shape question "Merge #415 on its own?"
      Then the push body reads "Merge #415 on its own?"
