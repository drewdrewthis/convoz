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
    Scenario: The name and buttons at the top shrink while typing on a phone
      Given the owner has conversation 41 open on a phone
      When the keyboard opens on the message box
      Then the top of the conversation is one 36 px line with Back and the title
      And the message box grows from one line to at most four
      And the message box asks for a new line on Return, capitals at sentence starts, spelling and autocorrect
      When the keyboard closes
      Then the full top of the conversation is back

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

    @v1 @browser @I-24
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
    Scenario: Pending attachments show as previews before send
      Given "chart.png" and "deploy.log" wait under "Files to send"
      Then "chart.png" shows as a 56 px thumbnail and "deploy.log" as a chip with its icon, name and size
      And each has a remove button
      When the owner sends the message
      Then the message shows the image at most 240 px high that opens whole in its own tab
      And "deploy.log" shows as a file card with its icon, name, size and a download link

    @v1 @browser
    Scenario: The owner removes a file before sending
      Given "chart.png" and "deploy.log" wait under "Files to send"
      When the owner removes "deploy.log"
      Then sending posts one message with only "chart.png"

    @v1 @browser
    Scenario: More than 10 attachments are refused in the composer
      When the owner drops 11 files on conversation 41
      Then the composer keeps 10 and says that 10 is the most per message

  Rule: Pasted files attach like picked ones; pasted text stays text

    # Owner ruling 2026-10-18: "Inline file paste doesn't work, but it should."
    # Prototype v41: both composers handle paste; a paste with files attaches them and keeps the text paste normal.
    @v1 @browser @I-31
    Scenario Outline: Pasting a file into the composer attaches it
      Given conversation 41 is open with a thread on its first message
      When the owner pastes the image "screenshot.png" into <box>
      Then <box> shows "screenshot.png" under "Files to send"
      And "screenshot.png" is not typed into <box> as text
      And sending posts one <sent> with the file

      Examples:
        | box                    | sent    |
        | the message box        | message |
        | the thread's reply box | reply   |

    @v1 @browser
    Scenario: Pasting text into the composer stays a normal paste
      Given conversation 41 is open with a thread on its first message
      When the owner pastes the words "Looks good to me" into the message box and into the thread's reply box
      Then both boxes show "Looks good to me" as text
      And no file waits under "Files to send"

  Rule: The phone composer is compact and the page does not zoom

    # Owner ruling 2026-10-18 (iPhone, Chrome): "I think you should also disable zoom, tighten the input component to save space,
    # and get rid of the padding under 'also send to conversation'"
    @v1 @browser @phone
    Scenario: The phone composer is compact and the page does not zoom
      Given conversation 41 is open with a thread on its first message
      When the owner opens conversation 41 on a 390 by 844 phone with the keyboard closed
      Then the viewport has maximum-scale=1
      And every text box has a font size of at least 16 px
      And the empty composer is at most 56 px tall
      When the owner opens the thread
      Then its reply box is 16 px too

  Rule: The @ mention and the paperclip work on a phone with the keyboard up

    # Owner report 2026-10-18 (iPhone, Chrome): "Also the @ mention is weird. I doesn't stay in the input - some weird behavior there"
    @v1 @browser @phone
    Scenario: The @ text stays as typed while the list is open on a phone
      Given conversation 41 is open on a phone with the keyboard up
      When the owner types "@cl" key by key
      Then the message box shows "@cl" and the list offers "claude-convoz"
      And the same holds when the keyboard sends the letters as one insert or as a composition

    @v1 @browser @phone
    Scenario: Tapping a name leaves the handle in the box on a phone
      Given conversation 41 is open on a phone with the keyboard up and "@cl" typed
      When the owner taps "claude-convoz" in the list
      Then the message box holds "@claude-convoz " with the caret after it
      And it survives the keyboard closing and opening

    @v1 @browser @phone
    Scenario: A mention sent from a phone is in the message
      Given conversation 41 is open on a phone with the keyboard up and "@claude-convoz " picked by a tap
      When the owner types "hi" and taps Send
      Then the message is "@claude-convoz hi" and "claude-convoz" is in the conversation

    # Owner report 2026-10-18 (iPhone, Chrome): "once you start typing in the input the paperclip stops working"
    @v1 @browser @phone
    Scenario: The paperclip works after the owner types on a phone
      Given conversation 41 is open on a phone with the keyboard up
      When the owner types "hello" and taps the paperclip once
      Then the file chooser opens
      And the message box still holds "hello"

  Rule: The conversation header floats over the messages

    # Owner ruling 2026-10-18: "You didn't do the ui update for the chat yet? It should have the floating circle buttons instead of the full header"
    @v1 @browser @phone
    Scenario: The conversation's name and buttons at the top are floating circle buttons
      Given conversation 41 has more messages than fit on a phone screen
      When the owner opens conversation 41 on a phone
      Then the top of the conversation has no bar background
      And the back button and the action buttons are circles of at least 44 px
      And the title is visible
      And the message list scrolls under the top area

  Rule: The microphone note says why it is not available

    # Owner (Drew, ask 119): "Chrome"
    @v1 @browser
    Scenario: Chrome on iPhone without a microphone API is told to use Safari
      Given the owner's browser is Chrome on an iPhone with no microphone API
      When the owner taps the microphone
      Then the note says "Chrome on iPhone can't use the microphone here. Open Convoz in Safari and add it to the Home Screen from there."

    # Owner (Drew, ask 119): "Chrome"
    @v1 @browser
    Scenario: Another browser without a microphone API says it cannot record
      Given the owner's browser has no microphone API and is not Chrome on an iPhone
      When the owner taps the microphone
      Then the note says "This browser can't record audio."

    # Owner (Drew, ask 119): "Chrome"
    @v1 @browser
    Scenario: A refused microphone says access is off
      Given the owner's browser refuses the microphone with NotAllowedError
      When the owner taps the microphone
      Then the note says "Microphone access is off. Allow it in Settings for this app, then try again."
