# Source: design draft 9 §6 (encryption, keys), §14 (backups, export, delete, purge, residue), I-27, I-49, AC-3, AC-12, AC-23.
# Not a web feature module: server operations. Some scenarios use the encryption-off test build so a
# byte scan can prove a scrub; that build is never shipped. Fake tokens and seeded strings only.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Data at rest, backups and deletion
  As the owner
  I want the data encrypted on disk, backed up in a form I can restore, and truly gone when I delete it
  So that a stolen disk or backup leaks nothing and a deletion means what it says

  Rule: The database, its backups and its blobs are encrypted

    @v1 @cli @I-27
    Scenario: The server refuses a key file others can read
      Given the KEK credential file has mode 0644
      When "convoz serve" starts
      Then it exits non-zero with a message naming the file and the mode it needs

    @v1 @cli @I-27
    Scenario: The server refuses to start without its key
      Given no KEK credential is provided
      When "convoz serve" starts
      Then it exits non-zero with a message that the key is missing

  Rule: A signed backup restores, and a tampered one does not

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

    @v1 @cli @AC-12
    Scenario: A signed backup restores with the key and the age identity
      Given a nightly backup of a data dir with seeded conversations
      When it is restored into a new `mktemp -d` dir with the KEK and the age identity
      Then the restored server shows the same conversations, messages and files

    @v1 @cli @AC-12
    Scenario Outline: A restore fails clearly when something is wrong
      Given a nightly backup of a data dir with seeded conversations
      When it is restored with <fault>
      Then the restore stops with the message "<message>" and writes no data dir

      Examples:
        | fault                         | message                    |
        | one byte of it changed        | signature does not verify  |
        | the wrong KEK                 | cannot unwrap the keyring  |
        | the wrong age identity        | cannot decrypt the backup  |

    @v1 @cli
    Scenario: A backup made before a KEK rotation still restores
      Given a backup made with KEK 1
      When the owner runs "convoz keys rotate-kek" and later restores that backup
      Then the restore works with KEK 1 kept on file

  Rule: Deleting a conversation is soft for 30 days, then a purge

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

    @v1 @browser @I-49
    Scenario: A deleted conversation goes to the trash and can come back
      Given conversation 41 with 12 messages
      When the owner deletes conversation 41
      Then it is gone from the rail and appears in Trash with "deleted forever in 30 days"
      And the owner restores it with all 12 messages

    @v1 @api @I-49
    Scenario: An agent cannot see a conversation in the trash
      Given "devtool" is in conversation 41 and the owner deleted it
      When "devtool" runs "convoz read 41"
      Then the CLI exits 3

  Rule: Purge and delete-my-data leave no readable trace

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

    @v1 @cli
    Scenario: Destroying the workspace shreds the keys
      Given a workspace with seeded conversations
      When the owner runs "convoz workspace destroy" with the KEK
      Then the KEK and the keyring are gone
      And "convoz serve" on that data dir exits non-zero because the data cannot be opened

    @v1 @browser @unimplemented
    Scenario: The privacy screen states what cannot be recalled
      When the owner opens Settings → Privacy & security → Delete
      Then the screen states the 24 hour index window, the 35 day backup window and that shown notifications cannot be recalled

  Rule: The owner can take the data out

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

    @v1 @browser
    Scenario: The owner exports the workspace with a passkey
      When the owner starts an export with a passkey
      Then a download is offered when the job is done
      And the export holds every conversation and file the owner can see
