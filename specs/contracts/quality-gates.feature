# Source: design draft 9 §4.3 (boundary rules), §4.4 (testing: Gherkin end to end is the spec), §12.1 (server budget),
# §16, docs/testing.md, AC-1, AC-9, AC-16, AC-17. Feature files may change in any PR; CI lists the changes in the PR summary.
# Not a product feature: the gates the repo itself must pass. They are driven from the command line
# against the repo and a real `convoz serve` on the 1M-message fixture in a fresh `mktemp -d` dir,
# never against production data. Every command is bounded by a timeout.

Feature: Build and quality gates (contracts)
  As the owner
  I want CI to refuse work that breaks the architecture, the budgets or the accessibility bar
  So that agents driving the build cannot quietly lower the standard

  Rule: Every invariant and AC has a bound scenario that failed before its code and passes after (AC-1)

    @v1 @cli @AC-1 @unimplemented
    Scenario: A slice PR shows its scenarios red first and green at head
      Given a slice PR with a test-only commit followed by code commits
      When CI runs the slice's tagged scenarios on the test-only commit and on head
      Then every scenario tagged with that slice's invariants fails on the test-only commit
      And passes on head

    @v1 @cli @AC-1
    Scenario: The coverage matrix has no gap
      When "specs/scripts/check_specs.py specs --write-coverage" runs
      Then it exits 0
      And specs/coverage.md lists no invariant from I-1 to I-50, no AC from AC-1 to AC-29 and no AC-M without a scenario

    @v1 @cli @AC-1
    Scenario: Changed scenarios are listed in the PR summary
      Given a PR that edits the text of 2 scenarios and deletes 1
      When CI runs the spec diff step
      Then the PR summary lists the 2 changed and the 1 deleted scenario by file and title
      And the PR is not blocked for it

    @v1 @cli @AC-1
    Scenario: The checker keeps user-facing scenarios in the user's words
      Given a scenario in specs/features that says "the server answers 409"
      When "specs/scripts/check_specs.py specs" runs
      Then it exits 1 and names the file, the line and the rule

  Rule: Module boundaries are enforced (AC-16)

    @v1 @cli @AC-16 @unimplemented
    Scenario Outline: CI fails a boundary break
      Given a branch that <breaks>
      When CI runs
      Then the "<check>" check fails and names the file

      Examples:
        | breaks                                                          | check            |
        | imports an internal file of another web feature                  | boundaries       |
        | imports app code from packages/ui                                | boundaries       |
        | queries a table that its Go module does not own                  | table-ownership  |
        | imports internal/server from internal/cli or internal/mcp        | go-arch-lint     |
        | changes generated contract code without changing the contract    | contract-drift   |

  Rule: The UI library meets the accessibility and look bar (AC-17)

    @v1 @browser @AC-17 @unimplemented
    Scenario: Every ui story passes axe in every theme and size
      When the Ladle stories run in Playwright in light and dark, for each palette, at 390x844 and 1280x940
      Then axe reports 0 violations for every story
      And each story has a screenshot for each combination

    @v1 @cli
    Scenario: Every text colour pair meets 4.5 to 1
      When the tokens build runs
      Then every text and background pair has contrast of at least 4.5 to 1 in both themes for every palette

  Rule: Server speed is measured, not hoped for (AC-9)

    @v1 @cli @AC-9 @unimplemented
    Scenario Outline: Server paths meet their p95 budget on the 1M fixture
      Given the encrypted 1M-message fixture on the target VM
      When the benchmark "<bench>" runs
      Then its p95 is at most <p95>

      Examples:
        | bench                       | p95    |
        | BenchmarkPostMessage        | 10 ms  |
        | BenchmarkAnswerAsk          | 10 ms  |
        | BenchmarkRail_FloorZero1M   | 12 ms  |
        | BenchmarkMessagesPage       | 5 ms   |
        | BenchmarkNow                | 8 ms   |
        | BenchmarkSearch1M           | 50 ms  |
        | BenchmarkSearch1M_Prefix2   | 50 ms  |
        | BenchmarkBrief              | 30 ms  |
        | BenchmarkInboxWake          | 25 ms  |
        | BenchmarkInboxClaimContention | 20 ms |
        | BenchmarkFanout             | 25 ms  |
        | BenchmarkDeltaSync          | 20 ms  |

    @v1 @cli @AC-9 @unimplemented
    Scenario: A budget miss or a 20 percent regression blocks the slice
      Given a benchmark result over budget or 20 percent slower than main
      When CI compares it with benchstat
      Then the slice is marked NOT READY

  Rule: The supply chain is pinned

    @v1 @cli
    Scenario: The build uses only pinned inputs
      When CI installs and builds from a clean checkout
      Then pnpm runs with a frozen lockfile and Go with -mod=readonly
      And go mod verify passes and the SQLite module checksum matches the recorded value
      And every GitHub Action is pinned by SHA
