# Source: design draft 9 §3.0 (machine · identity · session), §3.3 (session start), I-33, I-37, I-38, I-42, §13.1.
# Draft 9 folds in: M5 (re-minting with the same client_id issues a NEW working lease and
# ends the old one; expired-open rows are ended first), M8 (a lease renewal extends the session's claims).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir. Fake tokens only.

Feature: Agent sessions as one identity
  As an agent session
  I want to start a short lease as one identity on a logged-in machine
  So that countless Claude sessions on one machine can each speak as the right crew member

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "dev-*"
    And agent identities "devtool", "dev-search", "docs" and "release-bot" exist

  Rule: A lease is minted only for an identity the machine may use

    @v1 @cli @I-37 @I-42
    Scenario: Session start prints only a local session id
      When "convoz session start --as devtool" runs on "box-2"
      Then the CLI prints one line "CONVOZ_SID=a1b2c3"
      And the output contains no "cvz_s_" or "cvz_m_" string
      And "~/.config/convoz/sessions/a1b2c3" exists with mode 0600
      And "convoz whoami --sid a1b2c3" names identity "devtool", machine "box-2" and this session

  Rule: Many sessions may share one identity, within caps

    @v1 @api @I-37
    Scenario: Two machines run the same identity at once
      Given machine "laptop-1" is logged in with allow-list "devtool"
      When both "box-2" and "laptop-1" start a session as "devtool"
      Then "convoz whoami" works on both machines
      And "convoz whoami" on each machine lists 2 live sessions of "devtool"

  Rule: A lease lives 12 hours, renews while used, and ends cleanly

    @v1 @cli @I-37
    Scenario: A lease renews while the session works
      Given a session of "devtool" started 11 hours ago and posted 1 minute ago
      When the test clock moves forward 2 hours with one CLI call every 10 minutes
      Then every call works

    @v1 @cli @I-37
    Scenario: An idle lease expires after 12 hours
      Given a session of "devtool" that made no call for 12 hours and 1 minute
      When it calls "convoz inbox --wait 1"
      Then the CLI exits 3 with the message that the session ended
      And "convoz session start --as devtool" gives a working session

    @v1 @cli
    Scenario: Ending a session ends its lease
      Given a session of "devtool" with session id "a1b2c3"
      When "convoz session end --sid a1b2c3" runs
      Then "convoz inbox --sid a1b2c3 --wait 1" exits 3
      And Crew → Sessions shows the session as ended

    @v1 @cli @I-42
    Scenario: The CLI refuses a session file with loose permissions
      Given the session file of "a1b2c3" has mode 0644
      When "convoz post 41 --sid a1b2c3 hello" runs
      Then the CLI exits 3 and names the file and the mode it needs

  Rule: A machine may create identities only when the owner allowed it

    @v1 @cli @I-3
    Scenario: A machine with create_identity makes a new identity
      Given "box-2" has the create_identity scope
      When "convoz session start --as dev-ci --create --name 'CI helper'" runs on "box-2"
      Then the session works as "dev-ci"
      And Crew shows "CI helper @dev-ci" marked "created by box-2"

    @v1 @mcp
    Scenario: Calls inside one Claude session share one lease
      Given a Claude session whose environment has CLAUDE_CODE_SESSION_ID
      And "convoz mcp --as devtool" runs inside that Claude session
      When the same Claude session runs "convoz post 41 hello" in Bash
      Then the message is attributed to the same session label as the MCP calls
      And Crew → Sessions shows one live session for that Claude session

    @v1 @cli @mcp
    Scenario: A subagent shares its Claude session's lease and claims
      Given "convoz mcp --as devtool" runs in a Claude session that holds a claimed mention item
      When a subagent of that Claude session runs "convoz ack" for that item with its token
      Then the ack works
      And Crew → Sessions shows one live session for that Claude session

  Rule: A retry with the same client id gives a working lease and never two (M5)

    @v1 @mcp @I-37 @M5 @AC-27
    Scenario: A restarted MCP server in the same Claude session keeps working
      Given "convoz mcp --as devtool" runs in a Claude session and holds a claimed mention item
      When the MCP server process restarts in that Claude session
      Then the next tool call works
      And Crew → Sessions shows one live session for that Claude session
      And the mention item is still held by it and can be acked
