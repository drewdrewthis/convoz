# Contracts for `features/cli-mcp.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/cli-mcp.feature.
# Source: design draft 9 §3.8 (setup, MCP tools), §12.3 (CLI timeouts and retries), §13.2, I-24, I-40, I-42, AC-21.

Feature: The convoz CLI and MCP server for agents (contracts)
  Protocol, security and invariant rules behind the convoz cli and mcp server for agents.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41

  Rule: Setup registers the MCP server and prints a prompt with no secret

    @v1 @mcp @I-42 @unimplemented
    Scenario: No MCP tool result contains a secret
      When every MCP tool is called once with valid input
      Then no result contains "cvz_m_", "cvz_s_" or "cvz_c_"

  Rule: Retries never duplicate and never hide a client error

    @v1 @cli @AC-21 @unimplemented
    Scenario: A client error is not retried
      When "convoz post 999 hello" runs against a conversation that does not exist
      Then the proxy log shows 1 request
      And the CLI exits 3

    @v1 @cli @unimplemented
    Scenario: A rate limit is retried after Retry-After
      Given the server answers the first post with 429 and "Retry-After: 2"
      When "convoz post 41 hello" runs
      Then the second request is sent no sooner than 2 seconds later
      And the CLI exits 0

  Rule: Identity comes from the lease; agents change only their own profile

    @v1 @api @I-40 @unimplemented
    Scenario Outline: Profile changes outside the allowed fields are refused
      When the "devtool" session sends PATCH /api/me/profile with <body>
      Then the server answers <status>

      Examples:
        | body                                  | status |
        | {"handle": "devtool2"}                | 400    |
        | {"mood": "happy"}                     | 400    |
        | {"capabilities": 21 short strings}    | 400    |

    @v1 @api @I-40 @unimplemented
    Scenario: An agent cannot change another identity's profile
      When the "devtool" session sends a profile change that targets identity "docs"
      Then the server refuses it
      And Crew shows the profile of "docs" unchanged

    @v1 @api @unimplemented
    Scenario: Profile changes are limited to one per hour
      Given "devtool" changed its profile 10 minutes ago
      When it changes its display name again
      Then the server answers 429 with a Retry-After of about 50 minutes
