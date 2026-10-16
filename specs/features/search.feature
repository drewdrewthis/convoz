# Source: design draft 9 §13 GET /api/search, §12.1 (recency, 2-char prefix), I-6, AC-13, open question 6 (newest first).
# Prototype: "Search agents, messages, files, asks", filter chips from, in conversation, is ask, is pinned, is starred,
# is app, has file, has link; "Active filters"; results open in their conversation.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Search
  As the owner
  I want to find any message, ask, file or agent fast, newest first
  So that I can get back to a decision without scrolling

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And the search fixture: conversations 41 "Ship search filters" and 52 "Deploy alerts runbook" with messages, asks, files, links and app messages from "devtool" and "docs"

  Rule: Search finds what was just written, newest first

    @v1 @browser
    Scenario: A new message is searchable at once
      When "devtool" posts "retry budget is 3 attempts" in conversation 41
      And the owner searches "budget" right away
      Then the first result is that message with "budget" highlighted

    @v1 @api
    Scenario: Results are newest first
      Given 5 messages that contain "rollback" posted on 5 different days
      When the owner searches "rollback"
      Then the results are ordered from newest to oldest

    @v1 @api
    Scenario: A two-letter prefix works
      When the owner searches "ro"
      Then results include messages with "rollback" and "router"

    @v1 @browser
    Scenario: A result opens in its conversation
      When the owner searches "runbook" and opens the first result
      Then conversation 52 opens scrolled to that message with it highlighted

  Rule: Filters narrow the results (AC-13)

    @v1 @api @AC-13
    Scenario Outline: Each filter narrows the results
      When the owner searches "<query>"
      Then every result <matches>

      Examples:
        | query                    | matches                                   |
        | from:@devtool deploy     | was written by "devtool"                  |
        | in:"Deploy alerts" error | is in conversation 52                     |
        | is:ask                   | is an ask                                 |
        | is:pinned                | is a message the owner pinned             |
        | is:starred               | is in a conversation the owner starred    |
        | is:app                   | is an app message                         |
        | has:file                 | has an attachment                         |
        | has:link                 | has a link                                |

    @v1 @browser
    Scenario: Filter chips show and can be removed
      When the owner searches "from:@devtool has:file chart"
      Then "Active filters" shows "from @devtool" and "has file"
      And removing "has file" widens the results

  Rule: Search shows only what the searcher can see (I-6)

    @v1 @api @I-6
    Scenario: Deleted and purged messages are not found
      Given the owner deleted a message with "ZQX-deleted" and purged one with "ZQX-purged"
      When the owner searches "ZQX"
      Then no result is returned

    @v1 @api @I-6
    Scenario: A conversation in the trash is not found
      Given the owner deleted conversation 52
      When the owner searches "runbook"
      Then no result is from conversation 52

    @v1 @cli @I-6
    Scenario: An agent finds only conversations it is in
      Given "docs" is in conversation 52 only
      When "docs" runs "convoz search filters"
      Then no result is from conversation 41

    @later @api @I-6
    Scenario: A member finds only conversations she is in
      Given member "mia" is in conversation 41 only
      When "mia" searches "runbook"
      Then no result is returned
