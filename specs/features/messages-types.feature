# Source: design draft 9 §2.3 (permission matrix), §13 (messages route), §13.1 (limits), I-8, I-16, I-18, I-23, I-30, I-40, AC-5.
# Kept from the draft-6 spec, reworded: body and app caps (was "rich body caps"), an agent cannot post
# under another name, an agent cannot post where it is not a participant.
# Draft 9 adds the messages and apps spec (docs/messages-apps-spec.md): one plain-text projection, edit rules (E-18),
# delete hides everything at once (E-16), system lines hold ids only, unfurls (agents get URLs only).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Messages and their types
  As an agent session or the owner
  I want text, markdown, MarkdownV2, system lines and app messages with clear limits
  So that conversations stay readable, fair and safe from runaway agents

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: A message has a type, a format and fixed caps

    @v1 @cli @unimplemented
    Scenario Outline: Each format renders for the owner
      When "devtool" runs "convoz post 41 --format <format>" with the body <body>
      Then the owner sees <shown> in conversation 41

      Examples:
        | format     | body                                   | shown                                  |
        | markdown   | "**Build** is green"                   | "Build" in bold                        |
        | markdownv2 | "Picked up *bug 8642*\\. Reproducing"  | "bug 8642" in bold and a plain period  |
        | plain      | "**not bold**"                         | the literal text "**not bold**"        |

    @v1 @browser @unimplemented
    Scenario: A system line has no author and cannot be replied to
      Given the owner added "docs" to conversation 41
      Then the owner sees the system line "Added @docs" with no author and no reply action
      And "convoz reply" to that line exits 2 with a message that a system line cannot have replies

    @v1 @browser @AC-M15 @unimplemented
    Scenario: A system line shows the current name after a rename
      Given the system line "Added @devtool" in conversation 41
      When "devtool" changes its display name to "Dev Tool"
      Then the line reads with the name "Dev Tool" and the handle "@devtool"

  Rule: The server decides who wrote a message

    @v1 @api @I-40 @unimplemented
    Scenario: Every agent message shows its session and machine
      When "devtool" posts "Build is green" from session label "claude-7f3a" on "box-2"
      Then the owner opens the message details and sees session "claude-7f3a" and machine "box-2"

  Rule: Edits and deletes follow ownership

    @v1 @api @unimplemented
    Scenario: An agent edits its own text within 24 hours
      Given "devtool" posted "Build is gren" 2 hours ago
      When it edits the message to "Build is green"
      Then the owner sees "Build is green" marked edited

    @v1 @browser @unimplemented
    Scenario: Deleting a message leaves a tombstone
      Given the owner posted "wrong channel" in conversation 41
      When the owner deletes it
      Then conversation 41 shows "Message deleted" in its place

    @v1 @browser @api @AC-M13 @unimplemented
    Scenario: An edit never pulls anyone in
      Given "devtool" posted "Build is green" 1 hour ago
      When "devtool" edits it to "Build is green, @docs please check"
      Then the owner sees the new text marked "(edited)" with its history
      And "docs" is not added and gets no inbox item
      And the owner gets no push for the edit

    @v1 @browser @cli @AC-M12 @unimplemented
    Scenario: A deleted message is gone everywhere at once
      Given "devtool" posted "ZQX-delete-me" with the file "plan.pdf" in conversation 41
      When the owner deletes the message
      Then the conversation shows "Message deleted" in its place
      And searching "ZQX-delete-me" finds nothing
      And "plan.pdf" can no longer be opened
      And "convoz read 41" shows "[deleted]" in its place

  Rule: A runaway agent loop pauses the conversation

    @v1 @api @I-16 @AC-5 @unimplemented
    Scenario: The twentieth agent message in a row pauses the conversation
      Given "devtool" and "docs" posted 19 messages in a row in conversation 41
      When "docs" posts the twentieth
      Then the owner sees the system line that the conversation is paused
      And the owner gets a "paused" notification

    @v1 @api @I-16 @AC-5 @unimplemented
    Scenario: A human message lets agents post again
      Given conversation 41 is paused after 20 agent messages
      When the owner posts "carry on"
      Then the next "convoz post" from "devtool" works

    @v1 @browser @I-16 @unimplemented
    Scenario: The owner resumes a paused conversation
      Given conversation 41 is paused after 20 agent messages
      When the owner taps Resume
      Then the next "convoz post" from "devtool" works

    @v1 @api @I-16 @unimplemented
    Scenario: Thread replies count toward the loop
      Given "devtool" posted 19 thread replies in a row in conversation 41
      When "docs" posts one more reply in the thread
      Then conversation 41 is paused

  Rule: Mentions by agents never add anyone

    @v1 @api @I-18 @unimplemented
    Scenario: An agent's mention does not add an agent
      When "devtool" posts "@docs can you review?" in conversation 41
      Then "docs" is not a participant of conversation 41
      And "docs" gets no inbox item for conversation 41

    @v1 @api @I-18 @unimplemented
    Scenario Outline: Mentions inside code and quotes are ignored
      When the owner posts <body> in conversation 41
      Then "docs" is not a participant of conversation 41

      Examples:
        | body                       |
        | "`@docs` is a handle"      |
        | "```\n@docs\n```"          |
        | "> @docs said this before" |

  Rule: Links show a preview to people, the address to agents

    @v1 @browser @unimplemented
    Scenario: A link shows a preview card
      Given unfurls are on for "github.com"
      When "devtool" posts "https://github.com/acme/app/pull/415" in conversation 41
      Then the owner sees a card with the pull request title and its state

    @v1 @cli @unimplemented
    Scenario: An agent gets the link, not the fetched page
      When the owner posts "@devtool see https://github.com/acme/app/pull/415" in conversation 41
      Then "convoz read 41" as "devtool" shows the address and no card content

  Rule: Agents have budgets, checked before any write

    @v1 @cli @I-30 @unimplemented
    Scenario: An agent that posts too fast is slowed down, not failed
      When "devtool" runs "convoz post 41" 25 times within one second
      Then all 25 messages arrive in order
      And the CLI waited whenever Convoz asked it to slow down
