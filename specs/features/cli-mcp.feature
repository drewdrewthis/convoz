# Source: design draft 9 §3.8 (setup, MCP tools), §12.3 (CLI timeouts and retries), §13.2, I-24, I-40, I-42, AC-21.
# Kept from the draft-6 spec (D-2): one line per item in the watch stream, a double submit gives one line,
# newlines never break a line. Updated: `feed watch` → `convoz watch`, lines are JSON.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.
# Generated commands are argv lists; nothing runs through a shell.

Feature: The convoz CLI and MCP server for agents
  As an agent session
  I want one small binary that sets itself up, talks to Convoz over a poor link and never leaks a secret
  So that any Claude session can join with a one-line prompt

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41

  Rule: Setup registers the MCP server and prints a prompt with no secret

    @v1 @cli @I-42
    Scenario: Setup registers convoz mcp with Claude Code when the command exists
      Given a stub "claude" command on PATH that records its argv
      When "convoz setup --as devtool --scope project" runs
      Then the stub recorded "mcp add" with "convoz mcp --as devtool"
      And the CLI prints "You're @devtool on Convoz. Run convoz brief first."
      And no output contains "cvz_"

    @v1 @cli
    Scenario: Setup prints the config when Claude Code is absent
      Given no "claude" command on PATH
      When "convoz setup --as devtool" runs
      Then the CLI prints the MCP server config to add by hand
      And no file outside "~/.config/convoz" changed

    # Owner said: the agent "should request the connection accepted and send its id package for its handle."
    @v1 @cli @I-42
    Scenario: The connect commands send the agent's own identity and print no secret
      When "convoz login --name box-5 --as code-review --description 'Reviews PRs'" runs on a new machine
      Then the CLI prints 'Approve "box-5" as @code-review in Convoz.' and a code
      And "convoz login --as" with a handle that is not a handle exits 2 and names the rule
      And "convoz session start --create" without a name starts the request and prints no key, device code or lease
      And no output contains "cvz_"

    @v1 @mcp @I-42
    Scenario: The MCP server lists self-describing tools
      When a client lists the tools of "convoz mcp --as devtool"
      Then the tools are whoami, brief, inbox, claim, ack, read, search, post, reply, ask, status, handoff, profile, app_validate and app_build
      And each has a one-line purpose and a JSON schema that validates
      And post, reply and ask accept an app in the app.v1 shape

    @v1 @mcp
    Scenario: The MCP server ends its lease on exit
      Given "convoz mcp --as devtool" is running with a live session
      When its stdin closes
      Then Crew → Sessions shows that session as ended within 2 seconds

  Rule: Retries never duplicate and never hide a client error

    @v1 @cli @lossy @I-24 @AC-21
    Scenario: A post retried after a lost response makes one message
      Given a fault proxy drops the response of the first "convoz post" request
      When "convoz post 41 'Build is green'" runs
      Then the proxy log shows 2 requests with the same client id
      And conversation 41 shows "Build is green" once
      And the CLI exits 0

    @v1 @cli
    Scenario Outline: Exit codes tell scripts what went wrong
      When <situation>
      Then the CLI exits <code>

      Examples:
        | situation                                                          | code |
        | "convoz post" runs with no conversation argument                    | 2    |
        | "convoz post 41 hi" runs with an ended session                      | 3    |
        | "convoz ack" runs with a claim token that another session replaced  | 4    |
        | Convoz refuses five tries in a row as rate limited                   | 5    |
        | the server is unreachable for five tries in a row                    | 6    |

    @v1 @cli @lossy
    Scenario: The CLI gives up on a dead link in bounded time
      Given the stall proxy holds every connection without answering
      When "convoz post 41 hello" runs
      Then the CLI exits 6 within 90 seconds

  Rule: The watch stream prints one JSON line per inbox item

    @v1 @cli
    Scenario: The owner's reply is one line in the watch stream
      Given "convoz watch --json" runs as "devtool"
      When the owner posts "@devtool yes" in conversation 41
      Then the stream prints exactly one JSON line for that message within 3 seconds

    @v1 @cli @I-24
    Scenario: A double submit gives one watch line
      Given "convoz watch --json" runs as "devtool"
      When the owner's client sends "@devtool yes" twice with the same client id
      Then the stream prints one line for it

    @v1 @cli
    Scenario: A two-line message stays on one watch line
      Given "convoz watch --json" runs as "devtool"
      When the owner posts a two-line message mentioning "@devtool"
      Then the stream line holds an escaped newline and the output has no extra line

    @v1 @cli
    Scenario: Watch leaves the item in the inbox until the agent acks it
      Given "convoz watch --json" runs as "devtool"
      And the owner posts "Is the build green?" in conversation 41
      And the stream printed one line for it
      Then "convoz inbox --peek" still shows the item for conversation 41
      When "devtool" runs "convoz post 41 'Yes, all 11 checks pass'" and then "convoz ack" with the item from the stream line
      Then "convoz inbox --peek" shows no item for conversation 41

    @v1 @cli
    Scenario: Watch stops with exit 3 when its session ends
      Given "convoz watch --json" runs as "devtool"
      When the session ends
      Then "convoz watch" exits 3 and says the session ended

  Rule: An agent posts, reads and acks

    @v1 @cli
    Scenario: Post prints only the message id
      When "devtool" runs "convoz post 41 'Build is green'"
      Then the CLI prints one line holding the message id and exits 0

    @v1 @cli
    Scenario: Ack removes an item and refuses a stale claim
      Given "devtool" claimed an item for conversation 41 and acked it
      When "devtool" acks the same item again
      Then the CLI exits 4 with "claim_lost"

    @later @cli
    Scenario: Watch can start a command per item
      Given the owner approved "convoz watch --exec" on "box-2"
      When an item arrives while "convoz watch --exec ./handle-item" runs
      Then "./handle-item" runs once with the item as JSON on stdin, started without a shell

  Rule: Identity comes from the lease; agents change only their own profile

    @v1 @cli @I-40
    Scenario: whoami shows machine, identity, session and scopes
      When "convoz whoami --json" runs as "devtool"
      Then it shows machine "box-2", identity "devtool", the session label, the scopes and the live sessions of "devtool"

    @v1 @cli @I-40
    Scenario: An agent changes its own profile
      When "convoz profile --set name='Dev Tool' description='Builds and tests' capabilities=go,ci" runs as "devtool"
      Then Crew shows "Dev Tool @devtool" with that description and capabilities

  Rule: Agents join conversations only through a human

    @v1 @cli @I-17
    Scenario: An agent's add request waits for a human
      When "devtool" runs "convoz add 41 @docs"
      Then the owner sees a pending add "@docs" in Now
      And "docs" cannot read conversation 41

    @v1 @cli
    Scenario: An agent leaves a conversation
      When "devtool" runs "convoz leave 41"
      Then conversation 41 shows the system line "@devtool left"
      And "convoz read 41" exits 3

    @v1 @cli
    Scenario: Status updates show in Crew
      When "devtool" runs "convoz status --state working --doing 'Fixing #412' --next 'Open PR'"
      Then Crew shows "devtool" as "working" with "Fixing #412"
