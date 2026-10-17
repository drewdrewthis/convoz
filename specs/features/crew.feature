# Source: design draft 9 §3.1 (identity is assigned), §3.3 (disable), §3.5, §4.5 (Add agent → "Allow on machine" or
# `convoz login`, the one-line prompt), I-2, I-3, I-32, I-37, I-38, I-42. Prototype: Crew directory, agent profile with
# status ring (working, waiting on you, idle, offline as a hollow dot), "Waiting on you", "Conversations together",
# "New conversation with @x". The prototype's "Revoke token" on an agent is superseded: keys belong to machines.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Crew: identities, machines and sessions
  As the owner
  I want one directory of who my agents are, which machines may speak for them and which sessions are live
  So that I always know who said what, from where, and can cut anyone off

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

  Rule: The owner creates identities; names are unique and never reused

    # -> S-U (S1 plan, amendment 5): the S1 console has no Crew, Sessions or Audit screens; the API half is bound in the contracts.
    @v1 @browser @I-42
    Scenario: Adding an agent on a machine that already allows it
      Given "box-2" has allow mode "any"
      When the owner adds agent "dev-search" named "Search Dev" with a passkey
      Then Crew shows "Search Dev @dev-search"
      And the sheet shows the one-line prompt "You're @dev-search on Convoz. Run convoz brief first."
      And the sheet shows no key and no string starting with "cvz_"

    # -> S-U (S1 plan, amendment 5): the S1 console has no Crew, Sessions or Audit screens; the API half is bound in the contracts.
    @v1 @browser @I-37
    Scenario: Adding an agent that no machine allows yet
      When the owner adds agent "docs" named "Docs" with a passkey
      Then the sheet offers "Allow on machine…" with "box-2"
      And it shows the command "convoz login" for a new machine
      And choosing "box-2" lets "convoz session start --as docs" work there

    @v1 @browser @I-3
    Scenario: A handle is never used again
      Given the owner disabled the agent "release-bot"
      When the owner tries to add a new agent with the handle "release-bot"
      Then the add sheet says the handle "release-bot" was used before
      And Crew still lists the disabled "release-bot" with its old messages

    @v1 @browser @I-3
    Scenario: The handle always shows next to an agent's display name
      Given "devtool" set its display name to "Drew"
      When the owner views a message from "devtool"
      Then the author reads "Drew @devtool"

    @v1 @browser @I-2
    Scenario: Identities are disabled, never deleted
      When the owner disables "devtool" with a passkey
      Then Crew lists "devtool" as disabled
      And its old messages still show "@devtool"
      And Crew offers no way to delete "devtool"

  Rule: Disabling an identity cuts every session at once (I-38)

    @v1 @browser @cli @I-38
    Scenario: Disabling an identity ends its sessions and closes its asks
      Given "devtool" has sessions on "box-2" and an open ask in conversation 41
      When the owner disables "devtool" with a passkey
      Then the next command of each "devtool" session exits 3 with a message that the identity was disabled
      And the ask shows "Closed"
      And Crew shows "devtool" as disabled

  Rule: The owner manages machines and their allow-lists

    # -> S-U (S1 plan, amendment 5): the S1 console has no Crew, Sessions or Audit screens; the API half is bound in the contracts.
    @v1 @browser
    Scenario: Crew lists machines with their state
      Given "box-2" has 3 live sessions and was last used 2 minutes ago
      When the owner opens Crew → Machines
      Then "box-2" shows its key hint, allow-list, "3 live sessions" and "last used 2 min ago"

    # -> S-U (S1 plan, amendment 5): the S1 console has no Crew, Sessions or Audit screens; the API half is bound in the contracts.
    @v1 @browser @I-37
    Scenario: Editing a machine's allow-list needs a passkey
      When the owner adds "docs" to the allow-list of "box-2"
      Then the app asks for a passkey first
      And after it, "convoz session start --as docs" works on "box-2"

    # -> S-U (S1 plan, amendment 5): the S1 console has no Crew, Sessions or Audit screens; the API half is bound in the contracts.
    @v1 @browser
    Scenario: Crew lists live sessions with label and machine
      Given "devtool" has sessions "claude-7f3a" and "claude-91bc" on "box-2"
      When the owner opens Crew → devtool → Sessions
      Then both sessions show with their label, machine and last seen time

    @v1 @browser
    Scenario: The owner reads an agent's handoff notes
      Given "devtool" stored 3 handoff notes
      When the owner opens Crew → devtool → Handoffs
      Then the 3 notes show newest first with session and machine

  Rule: Agents describe themselves, within limits

    @v1 @browser @I-32 @unimplemented
    Scenario: An agent's own avatar shows safely
      Given "devtool" set an SVG avatar of plain shapes
      When the owner opens Crew
      Then the avatar shows next to "@devtool"

    @v1 @browser
    Scenario Outline: The status ring tells the agent's state without colour alone
      Given "devtool" has the status "<state>"
      When the owner opens Crew
      Then "devtool" shows the label "<label>" and a <ring>

      Examples:
        | state    | label          | ring                    |
        | working  | working        | moving gradient ring    |
        | waiting  | waiting on you | amber ring              |
        | idle     | idle           | grey ring               |
        | offline  | offline        | hollow grey dot         |

    @v1 @browser
    Scenario: An agent profile shows what waits on the owner and shared conversations
      Given "devtool" has 2 open asks and shares 4 conversations with the owner
      When the owner opens the profile of "devtool"
      Then "Waiting on you · 2" and "Conversations together" list them
      And "New conversation with @devtool" starts a conversation with "devtool" in it

  Rule: Later, more humans join the crew

    @later @browser
    Scenario: The owner invites a member
      When the owner invites "mia" as a member with a passkey
      Then "mia" gets a one-time link
      And the link cannot be used twice and never makes an owner
