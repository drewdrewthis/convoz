# Source: design draft 9 §9 (outbox), §11 (enter_to_send, default_format), §12.2 (send ≤16 ms), §12.3 (uploads),
# I-18, I-24, I-31, AC-13. Prototype: composer with "Mention an agent", "Attach a file", drag-and-drop drop target,
# "Files to send" strip, the agent picker "Add which agent".
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Composer
  As the owner
  I want to write, mention agents and attach files quickly, even offline
  So that talking to agents feels like texting

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Sending is instant and safe to repeat

    @v1 @browser
    Scenario: A sent message shows at once and then confirms
      When the owner sends "on it" in conversation 41
      Then the bubble shows at once as "sending"
      And it shows as sent when the server confirms

    @v1 @browser @phone
    Scenario: On a phone the composer stays above the keyboard and grows to a limit
      Given the owner has conversation 41 open on a phone
      When the keyboard opens and the owner types 12 lines
      Then the message box stays in view above the keyboard
      And it grew to about 6 lines and then scrolls inside itself

    @v1 @browser @phone
    Scenario: On a phone Enter adds a line and Send sends
      Given the owner has conversation 41 open on a phone
      Then Send is disabled while the message box is empty
      When the owner types "one", presses Enter and types "two"
      Then the message box holds two lines and nothing is sent
      When the owner taps Send
      Then the chat shows one message with two lines

    @v1 @browser
    Scenario: Enter sends on a desktop and adds a line on a phone
      Given the owner has conversation 41 open
      When the owner types "one", adds a line the way the device does and types "two"
      Then the message box holds two lines and nothing is sent
      When the owner sends the way the device does
      Then the chat shows one message with two lines

    @v1 @browser @phone
    Scenario: On a phone a failed send is retried once without a duplicate
      Given the owner has conversation 41 open on a phone and the network drops the next send
      When the owner sends "retry me" and then taps Retry
      Then the bubble first says "Not sent"
      And conversation 41 holds "retry me" once

    @v1 @browser @I-24 @unimplemented
    Scenario: An offline send is replayed once when back online
      Given the browser is offline
      When the owner sends "first" and then "second"
      And the browser comes back online
      Then conversation 41 shows "first" and then "second", each once, on a second browser

    @v1 @browser
    Scenario Outline: Enter sends or adds a new line
      Given the device setting "enter to send" is "<setting>" and the device <keyboard>
      When the owner presses Enter in the composer
      Then the composer <result>

      Examples:
        | setting | keyboard                    | result                  |
        | auto    | has a hardware keyboard     | sends the message       |
        | auto    | has only a touch keyboard   | adds a new line         |
        | off     | has a hardware keyboard     | adds a new line         |
        | on      | has only a touch keyboard   | sends the message       |

  Rule: Mentions bring agents in (I-18)

    @v1 @browser @I-18 @AC-13
    Scenario: Picking an agent from the mention list adds it
      When the owner types "@do" in conversation 41 and picks "docs" from the list
      And sends "@docs please write the release note"
      Then "docs" is a participant of conversation 41 from that message
      And "docs" gets a mention item

    @v1 @browser @I-18
    Scenario: A disabled agent is not offered and not added
      Given the owner disabled "release-bot"
      When the owner sends "@release-bot ship it" in conversation 41
      Then the mention list did not offer "release-bot"
      And "release-bot" is not a participant

    @v1 @browser @I-18
    Scenario: A mention inside code does not add an agent
      When the owner sends "run `@docs build`" in conversation 41
      Then "docs" is not a participant

  Rule: Files attach by button or drop and bind once (I-31)

    @v1 @browser @I-31
    Scenario: Dropping files attaches them to the next message
      When the owner drops "chart.png" and "deploy.log" on conversation 41
      Then the composer shows both under "Files to send"
      And sending posts one message with both files

    @v1 @browser
    Scenario: The owner removes a file before sending
      Given "chart.png" and "deploy.log" wait under "Files to send"
      When the owner removes "deploy.log"
      Then sending posts one message with only "chart.png"

    @v1 @browser
    Scenario: More than 10 attachments are refused in the composer
      When the owner drops 11 files on conversation 41
      Then the composer keeps 10 and says that 10 is the most per message
