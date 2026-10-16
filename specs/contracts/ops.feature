# Contracts for `features/ops.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/ops.feature.
# Source: design draft 9 §6 (encryption, keys), §14 (backups, export, delete, purge, residue), I-27, I-49, AC-3, AC-12, AC-23.

Feature: Data at rest, backups and deletion (contracts)
  Protocol, security and invariant rules behind data at rest, backups and deletion.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

  Rule: The database, its backups and its blobs are encrypted

    @v1 @cli @I-27 @AC-3
    Scenario: The data file cannot be read without the key
      Given "devtool" posted the seeded body "ZQX-secret-plan" in conversation 41
      When the data file and a fresh backup snapshot are opened with a plain SQLite reader
      Then both answer "file is not a database"
      And a strings scan of the data file, the WAL, the snapshot and every blob finds "ZQX-secret-plan" 0 times

  Rule: Deleting a conversation is soft for 30 days, then a purge

    @v1 @cli @invariant @I-49
    Scenario: The trash empties itself after 30 days
      Given the owner deleted conversation 41 with the seeded body "ZQX-old-plan"
      When the test clock moves 30 days and 1 hour and the nightly maintenance runs
      Then Trash no longer lists conversation 41
      And a byte scan of the encryption-off test build's data file finds "ZQX-old-plan" 0 times

  Rule: Purge and delete-my-data leave no readable trace

    @v1 @browser @api @invariant @I-5 @I-49 @C-7
    Scenario: Purging a message scrubs every copy of its content
      Given "devtool" posted "ZQX-purge-me", edited it to "ZQX-purge-edit", and asked "ZQX-purge-question" with a custom answer "ZQX-purge-answer"
      And "devtool" posted an app holding "ZQX-purge-app" that the owner answered through with "ZQX-purge-result"
      And the server runs as the encryption-off test build
      When the owner purges those messages with a passkey and the nightly maintenance runs
      Then the messages show as deleted with no body
      And search for "ZQX-purge" returns nothing
      And a byte scan of the data file and the WAL finds every "ZQX-purge" string 0 times

    # Draft 9 (C-7): delete-my-data is a member action, so AC-23 moves to later with members (S-15).
    # v1 proves the owner's purge with the same byte scan (the scenario above).
    @later @browser @invariant @I-49 @AC-23 @C-7
    Scenario: Delete my data leaves no trace of a member
      Given member "mia" seeded by the test build posted, edited, answered an ask with custom text, uploaded "ZQX-mia-file.pdf" and sent a voice note with a transcript, each holding a unique seeded string
      And the server runs as the encryption-off test build
      When "mia" deletes her data with a passkey and the nightly maintenance runs
      Then a byte scan of the data file and the WAL finds each seeded string 0 times
      And search for each seeded string returns nothing
      And her messages show as "Deleted user"
      And creating a new identity with the handle "mia" is refused
