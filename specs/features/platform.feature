# Source: design draft 9 §5 (commands → events, thin events, sync), §7 (schema), I-4, I-5, I-9, I-23, I-24, I-34, I-48, AC-22.
# Not a web feature module: these are the server-wide rules every module stands on. They are written as
# end-to-end checks against a real `convoz serve` on a fresh `mktemp -d` data dir. Where the rule lives in
# the database (@invariant), the scenario observes it through the API, the CLI or the data file.

Feature: Platform rules every module relies on
  As the owner
  I want every change to be all-or-nothing, replayable and small on the wire
  So that clients and agents can trust what they sync

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Upgrades are forward only and safe

    @v1 @cli @I-34
    Scenario: The server refuses a database from a newer version
      Given a data dir migrated by a newer build
      When this build runs "convoz serve"
      Then it exits non-zero with a message naming both versions

    @v1 @cli @I-34
    Scenario: A migration starts with a backup
      Given a data dir from the previous release with seeded data
      When this build starts and migrates it
      Then an encrypted backup file dated before the migration exists
      And the seeded data is intact
