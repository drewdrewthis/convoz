# Contracts for `features/cli-dist.feature`: what the install script and the /cli routes promise.
# Source: the Convoz server hands out its own CLI (design "CLI distribution").

Feature: The server hands out its own CLI (contracts)
  The installer checks what it downloads, the files are cached by version, and a CLI that differs from its server says so.

  Background:
    Given a Convoz server

  Rule: The installer trusts only bytes that match SHA256SUMS

    @v1 @cli
    Scenario: The installer refuses a binary whose checksum does not match
      Given SHA256SUMS lists another checksum than the binary the server serves
      When the install script runs in an empty home folder
      Then it exits 1 and names the checksum mismatch
      And no convoz and no half-finished download is left in ".local/bin"

  Rule: The CLI files are public and cached by version

    @v1 @api
    Scenario: The server serves its CLI with cache headers fixed by version
      When each CLI file is asked for with no credential
      Then a request naming the version of the server is cached as immutable
      And a request without the version is revalidated by its ETag
      And SHA256SUMS lists the four platforms, with the digest each binary's ETag names
      And a platform the server does not have answers 404

  Rule: A CLI that differs from its server says so

    @v1 @cli
    Scenario: Login warns when the CLI and the server differ in version
      Given a server that reports another version than the CLI
      When "convoz login" runs against it
      Then it warns on standard error with "update: curl -fsSL <server>/install | sh"
