# Source: design draft 9 §2.3, §8 (I-7, I-9, I-15, I-16, I-17, I-19, I-20, I-47), §8.2 (unread), §14 (soft delete), AC-6, AC-26.
# Prototype: blank new conversation (⌘J, "Type @ to bring in an agent"), rename, details sidebar (I), participants.
# Kept from the draft-6 spec (D-7), reworded: two agents race for an open question → two agents race to pick up
# a conversation the owner opened for pickup; an agent without the right is refused.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Conversations
  As the owner
  I want conversations that I start, name, fill with the right agents and clean up
  So that each piece of work has one place and only the agents that belong there

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool", "docs" and "release-bot"

  Rule: The owner starts and names conversations

    @v1 @browser @unimplemented
    Scenario: A new conversation starts blank and takes a title from its first message
      When the owner starts a new conversation with Cmd+J and sends "Plan the search filters launch"
      Then the rail shows the conversation at the top titled "Plan the search filters launch"

    @v1 @browser @unimplemented
    Scenario: The details sidebar shows who is here and how the conversation is set
      Given conversation 41 with "devtool" and "docs"
      When the owner presses "I"
      Then the details show the participants, "Started by", "Created", "Muted" and the linked pull request

    @v1 @browser @I-20 @unimplemented
    Scenario: An empty untitled conversation is cleaned up after 24 hours
      Given the owner started a conversation and sent nothing
      When the test clock moves 24 hours and 1 minute
      Then the rail no longer shows it

    @v1 @browser @I-20 @unimplemented
    Scenario: A starred or renamed empty conversation is kept
      Given the owner started two conversations, starred one, renamed the other and sent nothing
      When the test clock moves 25 hours
      Then the rail still shows both

  Rule: Agents join only through a human, and see only from their join

    @v1 @browser @I-18 @unimplemented
    Scenario: Mentioning an agent adds it at once
      Given conversation 41 with only the owner
      When the owner sends "@devtool please look at #412"
      Then the participants show "devtool"
      And "devtool" gets a mention item

    @v1 @browser @I-15 @unimplemented
    Scenario Outline: Adding an agent sets what history it sees
      Given conversation 41 with 20 messages
      When the owner adds "docs" with history "<history>"
      Then "docs" runs "convoz read 41" and sees <seen>
      And "docs" has no unread messages in conversation 41

      Examples:
        | history   | seen                                |
        | since now | only messages after the add         |
        | full      | all 20 messages                     |

    @v1 @cli @I-7 @unimplemented
    Scenario: An agent sees a reply under a hidden root as a stub
      Given "docs" was added to conversation 41 after thread root 900 was posted
      And the owner replies in thread 900 after the add
      When "docs" runs "convoz read 41 --thread 900"
      Then it sees the reply and a stub "earlier message not shown" for the root

    @v1 @api @I-7 @unimplemented
    Scenario: Events from before an agent joined are not replayed to it
      Given "docs" joined conversation 41 after 10 events in it
      When "docs" reads the conversation and its inbox
      Then it receives nothing from those 10 events

    @v1 @api @I-17 @AC-26 @unimplemented
    Scenario: An agent that creates a conversation cannot pull others in
      When "devtool" creates conversation "Release prep" listing "@docs" and "@release-bot"
      Then the owner sees 2 pending adds in Now for "Release prep"
      And "docs" and "release-bot" get 403 on "convoz read" until the owner approves

  Rule: Removing an agent cuts it off in one step (AC-6)

    @v1 @browser @cli @I-19 @AC-6 @C-1 @unimplemented
    Scenario: A removed agent gets nothing more from that conversation
      Given "devtool" is in conversations 41 and 52 and waits with "convoz inbox --wait 60"
      And "devtool" has an open ask and a dismissed ask in conversation 41
      When the owner removes "devtool" from conversation 41
      Then conversation 41 shows the system line "@devtool was removed"
      And both asks show "Closed"
      And "devtool" gets one notice that it was removed, then nothing from conversation 41: no item, no read and no search result
      And new messages in conversation 52 still reach "devtool"

    @v1 @cli @I-7 @I-19 @unimplemented
    Scenario: A removed agent sees nothing of the conversation
      Given the owner removed "devtool" from conversation 41
      When "devtool" runs "convoz read 41"
      Then the CLI exits 3

    @v1 @browser @I-19 @unimplemented
    Scenario: Adding an agent back offers the original history
      Given the owner removed "devtool" from conversation 41
      When the owner adds "devtool" again
      Then the add sheet offers "since now" and "full history"

  Rule: Read position is honest (DA-2, DA-4)

    @v1 @browser @I-15 @unimplemented
    Scenario: Mark all read clears the conversation
      Given conversation 41 has 7 unread main messages and 2 unread replies in an involved thread
      When the owner marks the conversation read
      Then conversation 41 shows no unread count and is not bold

  Rule: A loop pause is visible and the owner resumes it

    @v1 @browser @I-16 @unimplemented
    Scenario: A paused conversation shows a banner with Resume
      Given "devtool" and "docs" posted 20 messages in a row in conversation 41
      When the owner opens conversation 41
      Then a banner says the agents are paused after 20 messages in a row
      And the banner has a Resume button

  Rule: A conversation can be offered to any agent for pickup (SEC-6)

    @v1 @browser @cli @I-47 @unimplemented
    Scenario: The owner opens a conversation for pickup and one agent takes it
      Given machine "box-2" has the pickup scope
      And the owner opened conversation 60 for pickup
      When "devtool" and "docs" run "convoz pickup 60" at the same time
      Then exactly one exits 0
      And the other exits 4 naming the agent that picked it up
      And conversation 60 shows one system line naming the winner

  Rule: Messages arrive live

    @v1 @browser @unimplemented
    Scenario: An agent message reaches the owner's open browser fast
      Given the owner has conversation 41 open
      When "devtool" runs "convoz post 41 'Build is green'"
      Then the message shows within 3 seconds with no reload
      And "convoz post" printed the message id

    @v1 @browser @unimplemented
    Scenario: The message details show who and where
      Given "devtool" posted from session "claude-7f3a" on "box-2"
      When the owner opens that message's details
      Then they show "@devtool", session "claude-7f3a" and machine "box-2"

    @later @browser
    Scenario: A member sees only conversations they are in
      Given member "mia" is in conversation 41 only
      When "mia" opens the rail
      Then she sees conversation 41 and no other
