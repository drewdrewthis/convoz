# Contracts for `features/crew.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/crew.feature.
# Source: design draft 9 §3.1 (identity is assigned), §3.3 (disable), §3.5, §4.5 (Add agent → "Allow on machine" or

Feature: Crew: identities, machines and sessions (contracts)
  Protocol, security and invariant rules behind crew: identities, machines and sessions.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

  Rule: The owner creates identities; names are unique and never reused

    @v1 @api @I-3
    Scenario Outline: Handle rules
      When the owner creates an agent with the handle "<handle>"
      Then the server answers <status>

      Examples:
        | handle      | status |
        | devtool2    | 201    |
        | DevTool     | 409    |
        | admin       | 400    |
        | brief       | 400    |
        | 9lives      | 400    |
        | a           | 400    |
        | dev_tool    | 400    |

    @v1 @api @I-3
    Scenario: A handle that looks like another identity is refused
      When the owner creates an agent with the handle "devtoo1"
      Then the server answers 400 naming "handle"

    @v1 @api @I-3
    Scenario: A display name that looks like another identity is refused
      When the owner creates an agent named "devtooI" with the handle "helper"
      Then the server answers 400 naming "display_name"

    @v1 @api @invariant @I-2
    Scenario: No request can delete an identity or change its kind
      When a client tries every identity route to delete "devtool" or change it from agent to human
      And the test tries the same writes on the data file of the encryption-off test build
      Then every attempt is refused
      And GET /api/identities still lists "devtool" as an agent

    # Owner said: "Removal is just revoking their key". The route is the existing disable; the app confirms inline and asks for no passkey.
    @v1 @api @I-2 @I-38
    Scenario: Revoking an agent's key needs the owner's session and no passkey
      Given "devtool" has a live session on "box-2"
      When a machine key, a session lease and a caller with no credential each try to disable "devtool"
      Then the server answers 401 every time
      When the owner disables "devtool" with no step-up
      Then the server answers 200
      And the live session answers 401
      And "box-2" can no longer start a session as "devtool"
      And GET /api/identities still lists "devtool" as disabled, and its handle stays used

    @later @api @I-3 @AC-23 @C-7
    Scenario: A handle retired by delete-my-data is never used again
      Given member "mia" deleted her data, so her handle was retired
      When the owner creates an agent with the handle "mia"
      Then the server answers 409

  Rule: An agent's handle changes in one transaction; every record keys on the id (I-51)

    # Owner said (2026-10-18): "Handles I think can also change, that seems fine because there's an id, right?"
    # Earlier: "the handle is never reused."
    @v1 @api @I-51
    Scenario: A handle change retires the old handle at once and tells every conversation
      Given "devtool" is in conversations 41 and 52
      When the owner sends POST /api/identities/:id/handle with {"handle": "builder"} and no step-up
      Then the server answers 200 with the handle "builder" and the previous handle "devtool"
      And GET /api/identities lists "builder" under the same id with previous_handles ["devtool"]
      And retired_handles holds "devtool" for that id, retired at the time of the change
      And conversations 41 and 52 each end with the system line "@devtool is now @builder"
      And the audit row "identity.handle_changed" has the detail {"from": "devtool", "to": "builder"}

    @v1 @api @I-51 @I-3
    Scenario Outline: A new handle passes every rule of a new one
      Given the agents "docs" and "release-bot" exist and "docs" changed its handle to "writer"
      When the owner changes the handle of "devtool" to <handle>
      Then the server answers <status> with the code <code>

      Examples:
        | handle                                   | status | code            |
        | "admin" (reserved)                       | 400    | invalid_request |
        | "Dev_Tool!" (not a handle)               | 400    | invalid_request |
        | "writer" (taken)                         | 409    | handle_taken    |
        | "docs" (used before)                     | 409    | handle_taken    |
        | "re1ease-bot" (a look-alike)             | 400    | invalid_request |

    # Owner said (2026-10-18), asked whether an agent's own change needs approval: "Change at once, no approval"; "I think that's too
    # defensive and requires too much machinery?"
    @v1 @api @I-51 @I-26
    Scenario: An agent changes its own handle with its lease, at once
      Given "devtool" is in conversations 41 and 52
      When the "devtool" session sends POST /api/me/handle with {"handle": "builder"}
      Then the server answers 200 with the handle "builder", the previous handle "devtool" and a previous_until 30 days on
      And GET /api/now lists no handle requests
      And conversations 41 and 52 each end with the system line "@devtool is now @builder"
      And the audit has "identity.handle_changed" with the session of "devtool" and both handles
      When a machine key and a caller with no credential each send POST /api/me/handle
      Then the server answers 401 or 403 both times

    @v1 @api @I-51
    Scenario: Two changes at once: both apply in turn, and a post during them reaches the same agent
      When "devtool" changes its own handle to "maker", the owner changes it to "builder", and the owner posts "@devtool status?" all at once
      Then both changes answer 200, one after the other
      And the agent has the handle of the change that came last, and "devtool" and the handle between are each retired once
      And the post records a mention of the agent's id

    # Owner chose the option that said "you can rename it back from Crew", so an identity may take back a handle it retired itself.
    @v1 @api @I-51 @I-3
    Scenario: The owner renames an agent back to its own old handle, and nobody else may take a retired handle
      Given the agents "devtool" and "docs" exist and the owner changed the handle of "devtool" to "builder"
      When the owner changes the handle of "builder" back to "devtool" from Crew
      Then the server answers 200 with the handle "devtool" and the previous handle "builder"
      And retired_handles no longer holds "devtool" and holds "builder" for that id
      And "docs" asking for "devtool" or for "builder" gets 409 with the code "handle_taken"

    @v1 @api @I-51 @I-18
    Scenario: A post to the old handle records the mention and names the current handle
      Given the owner changed the handle of "devtool" to "builder"
      When the owner posts "@devtool look" in a conversation without "builder"
      Then "builder" is an active participant of that conversation and its inbox holds the mention
      And the message lists the mention {"as_written": "devtool", "identity_id": <the id>, "handle": "builder"}

    @v1 @api @I-51 @I-37
    Scenario: A handle change keeps the machines that may act as the agent
      Given "box-2" allows "dev-*" and "laptop-1" allows "ops-*"
      And "dev-search" has a live session on "box-2"
      When the owner changes the handle of "dev-search" to "searcher"
      Then the live session still answers 200 and "box-2" starts a new session as "searcher"
      And changing the handle of "devtool" to "ops-tool" answers 400 naming "handle"

    @v1 @api @I-51
    Scenario: The change limit and the old handle's 30 days run on the server clock
      Given the owner changed the handle of "devtool" to "builder", then to "builder-2" and to "builder-3"
      When the owner changes it again
      Then the server answers 429 with a Retry-After of about 24 hours
      And "box-2" asking for a lease as "devtool" answers 201 with renamed from "devtool" to "builder-3"
      When the test clock moves forward 30 days and 1 second
      Then asking for a lease as "devtool" answers 403 with the code "handle_renamed" and a message that names "@builder-3"
      And the owner can change the handle again

    @v1 @api @I-51
    Scenario: A push says who an agent was for 7 days
      Given the owner's browser is subscribed to pushes and the owner changed the handle of "devtool" to "builder"
      When "builder" asks a question
      Then the push title names "Dev Tool @builder (was @devtool)"
      When the test clock moves forward 7 days and "builder" asks again
      Then the push title names "Dev Tool @builder" and not "was"

    @v1 @api @I-51 @I-1
    Scenario: The schema refuses a human's change, a reused handle and a change without its time
      Given the owner changed the handle of "devtool" to "builder"
      When a second connection to the data file tries to change the owner's handle, to give "docs" the handle "devtool", and to change "builder" with no new time
      Then the schema refuses each write
      And the owner's own handle cannot be changed through POST /api/identities/:id/handle
