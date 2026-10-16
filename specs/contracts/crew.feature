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
    Scenario: A display name that looks like another identity is refused
      When the owner creates an agent named "devtooI" with the handle "helper"
      Then the server answers 400 naming "display_name"

    @v1 @api @invariant @I-2
    Scenario: No request can delete an identity or change its kind
      When a client tries every identity route to delete "devtool" or change it from agent to human
      And the test tries the same writes on the data file of the encryption-off test build
      Then every attempt is refused
      And GET /api/identities still lists "devtool" as an agent

    @later @api @I-3 @AC-23 @C-7
    Scenario: A handle retired by delete-my-data is never used again
      Given member "mia" deleted her data, so her handle was retired
      When the owner creates an agent with the handle "mia"
      Then the server answers 409
