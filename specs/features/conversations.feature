# Source: design draft 9 §2.3, §8 (I-7, I-9, I-15, I-16, I-17, I-19, I-20, I-47), §8.2 (unread), §14 (soft delete), AC-6, AC-26.
# Prototype: blank new conversation (⌘J, "Type @ to bring in an agent"), rename, details sidebar (I), participants.
# Pickup was removed. Owner said: "Nothing claims conversations. I need to tag." Agents join only when the owner tags them.
# Words follow prototype v41: the tab and list are "Conversations", the button is "New conversation".
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Conversations
  As the owner
  I want conversations that I start, name, fill with the right agents and clean up
  So that each piece of work has one place and only the agents that belong there

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool", "docs" and "release-bot"

  Rule: The owner starts and names conversations

    @v1 @browser
    Scenario: A new conversation starts blank and takes a title from its first message
      When the owner starts a new conversation with Cmd+J and sends "Plan the search filters launch"
      Then the Conversations list shows the conversation at the top titled "Plan the search filters launch"

    @v1 @browser @phone
    Scenario: On a phone the first page after sign-in is Now
      Given the owner has a passkey on a phone
      When the owner signs in
      Then the app shows Now
      And "Now" is marked as the current tab

    @v1 @browser @phone
    Scenario: On a phone an empty Conversations list explains itself and offers New conversation
      Given the owner has no conversations yet
      When the owner opens Conversations on a phone
      Then the page says there are no conversations yet and that typing @ brings in an agent
      And the page offers "New conversation"

    @v1 @browser @phone
    Scenario: On a phone New conversation opens a blank composer where @ lists the crew agents
      Given "devtool" has a live session and "docs" has none
      When the owner taps "New conversation" and types "@"
      Then the list shows "devtool" as online and "docs" as offline
      When the owner picks "docs"
      Then the message box for "docs" has focus

    @v1 @browser @phone
    Scenario: On a phone a new conversation takes its title from the first message and goes to the top of Conversations
      Given the owner has conversations "Ship search filters" and "Deploy alerts runbook" on a phone
      When the owner taps "New conversation", types "@", picks "devtool" and sends "Plan the search filters launch"
      Then the conversation is titled "Plan the search filters launch" and names "@devtool"
      And a reload shows the same conversation with the message
      And Conversations lists "Plan the search filters launch" above the other two

    @v1 @browser @phone
    Scenario: On a phone back returns from a conversation to Conversations
      Given the owner opened a conversation from the Conversations list on a phone
      When the owner taps the back button
      Then the Conversations list shows
      When the owner opens the conversation again and uses the browser back
      Then the Conversations list shows

    @v1 @browser @phone
    Scenario: On a phone Conversations shows plain previews, and the composer names the agent
      Given "devtool" replied in one conversation with markdown and the owner wrote in another conversation with "docs"
      When the owner opens Conversations
      Then the preview is plain text: no markers, the link as its text and the code block as "code"
      And the message box is named after the agent

    @v1 @browser @phone
    Scenario: On a phone a conversation that does not exist shows a not-found page with a way back
      Given the owner is signed in on a phone
      When the owner opens a conversation id that is missing, not a number, or not a whole number
      Then the page says the conversation was not found, in the console style, with a link back to Conversations

    @v1 @browser
    Scenario: The details sidebar shows who is here and how the conversation is set
      Given conversation 41 with "devtool" and "docs"
      When the owner presses "I"
      Then the details show the participants, "Started by", "Created", "Muted" and the linked pull request

    @v1 @browser @I-20
    Scenario: An empty untitled conversation is cleaned up after 24 hours
      Given the owner started a conversation and sent nothing
      When the test clock moves 24 hours and 1 minute
      Then the rail no longer shows it

    @v1 @browser @I-20
    Scenario: A starred or renamed empty conversation is kept
      Given the owner started two conversations, starred one, renamed the other and sent nothing
      When the test clock moves 25 hours
      Then the rail still shows both

  Rule: Agents join only through a human, and see only from their join

    @v1 @browser @I-18
    Scenario: Mentioning an agent adds it at once
      Given conversation 41 with only the owner
      When the owner sends "@devtool please look at #412"
      Then the participants show "devtool"
      And "devtool" gets a mention item

    # Per prototype v41 (+ Add, addAgents): the agent joins at once, there is no history sheet, and it sees what comes after.
    @v1 @browser @I-15
    Scenario: Adding an agent with + Add joins it at once and it sees only what comes after
      Given conversation 41 with 20 messages
      When the owner adds "docs" with + Add
      Then the participants show "docs" at once and no history question was asked
      And "docs" runs "convoz read 41" and sees only messages after the add
      And "docs" has no unread messages in conversation 41

    @v1 @cli @I-7
    Scenario: An agent sees a reply under a hidden root as a stub
      Given "docs" was added to conversation 41 after thread root 900 was posted
      And the owner replies in thread 900 after the add
      When "docs" runs "convoz read 41 --thread 900"
      Then it sees the reply and a stub "earlier message not shown" for the root

    @v1 @api @I-7
    Scenario: Events from before an agent joined are not replayed to it
      Given "docs" joined conversation 41 after 10 events in it
      When "docs" reads the conversation and its inbox
      Then it receives nothing from those 10 events

    @v1 @api @I-17 @AC-26
    Scenario: An agent that creates a conversation cannot pull others in
      When "devtool" creates conversation "Release prep" listing "@docs" and "@release-bot"
      Then the owner sees 2 pending adds in Now for "Release prep"
      And "docs" and "release-bot" get 403 on "convoz read" until the owner approves

  Rule: Removing an agent cuts it off in one step (AC-6)

    @v1 @browser @cli @I-19 @AC-6 @C-1
    Scenario: A removed agent gets nothing more from that conversation
      Given "devtool" is in conversations 41 and 52 and waits with "convoz inbox --wait 60"
      And "devtool" has an open ask and a dismissed ask in conversation 41
      When the owner removes "devtool" from conversation 41
      Then conversation 41 shows the system line "@devtool was removed"
      And both asks show "Closed"
      And "devtool" gets one notice that it was removed, then nothing from conversation 41: no item, no read and no search result
      And new messages in conversation 52 still reach "devtool"

    @v1 @cli @I-7 @I-19
    Scenario: A removed agent sees nothing of the conversation
      Given the owner removed "devtool" from conversation 41
      When "devtool" runs "convoz read 41"
      Then the CLI exits 3

    @v1 @browser @I-19
    Scenario: Adding an agent back joins it at once with no history question
      Given the owner removed "devtool" from conversation 41
      When the owner adds "devtool" again with + Add
      Then the participants show "devtool" at once and no history question was asked

    @v1 @browser @I-19
    Scenario: Remove agent shows a 10 second Undo toast and Undo puts the agent back
      Given "devtool" is in conversation 41
      When the owner removes "devtool" from conversation 41
      Then a toast says "Removed @devtool" with an Undo button for 10 seconds
      When the owner taps Undo
      Then the participants show "devtool" again

  Rule: Read position is honest (DA-2, DA-4)

    @v1 @browser @I-15
    Scenario: Mark all read clears the conversation
      Given conversation 41 has 7 unread main messages and 2 unread replies in an involved thread
      When the owner marks the conversation read
      Then conversation 41 shows no unread count and is not bold

  Rule: A loop pause is visible and the owner resumes it

    @v1 @browser @I-16
    Scenario: A paused conversation shows a banner with Resume
      Given "devtool" and "docs" posted 20 messages in a row in conversation 41
      When the owner opens conversation 41
      Then a banner says the agents are paused after 20 messages in a row
      And the banner has a Resume button

  # Removed: "A conversation can be offered to any agent for pickup" (SEC-6, I-47).
  # Owner said: "Nothing claims conversations. I need to tag." Agents join only through the owner's @mention or + Add.

  Rule: Messages arrive live

    @v1 @browser @phone
    Scenario: On a phone the bottom bar leads to Now, Conversations and Crew
      Given the owner opens Convoz on a phone
      Then a bottom bar shows "Now", "Conversations" and "Crew"
      When the owner taps "Conversations"
      Then the Conversations list shows with a "New conversation" button
      And "Conversations" is marked as the current tab

    @v1 @browser @phone
    Scenario: On a phone the owner starts a conversation with an agent and sees its reply
      Given "devtool" runs "convoz watch --json"
      When the owner taps "New conversation", types "@", picks "devtool" and sends "Is the build green?"
      Then the message shows with the name "You" and an avatar on the left
      And the watch stream prints one JSON line with "Is the build green?" within 3 seconds
      When "devtool" runs "convoz post" in that conversation with "Yes, all 11 checks pass"
      Then the reply shows on the left within 3 seconds with no reload
      And the Conversations list shows the conversation with no unread dot

    @v1 @browser @phone
    Scenario: On a phone an unread conversation shows a dot until opened
      Given the owner is on the Conversations list on a phone
      When "devtool" posts "Done" in conversation 41
      Then conversation 41 shows an unread dot and "Done" as its preview within 3 seconds
      When the owner opens conversation 41 and goes back to Conversations
      Then conversation 41 has no unread dot

    @v1 @browser @phone
    Scenario: On a phone a conversation catches up after the connection comes back
      Given the owner has conversation 41 open on a phone
      And the phone goes offline
      When "devtool" posts "one", "two" and "three" in conversation 41
      And the phone comes back online
      Then conversation 41 shows "one", "two" and "three" once each, in that order, within 5 seconds

    @v1 @browser @phone
    Scenario: On a phone a working agent shows a note until it replies
      Given "devtool" runs "convoz watch --json" and the owner has a conversation with "devtool" open on a phone
      When the owner sends "Is the build green?"
      Then the conversation shows "@devtool is working…" within 3 seconds
      When "devtool" runs "convoz post" in that conversation with "Yes"
      Then the note is gone and the reply shows

    @v1 @browser @phone
    Scenario: On a phone the working note goes away when the agent finishes without a reply
      Given "devtool" runs "convoz watch --json" and the owner has a conversation with "devtool" open on a phone
      When the owner sends "Is the build green?" and "devtool" runs "convoz ack" without a reply
      Then the conversation shows no working note

    @v1 @browser @phone
    Scenario: On a phone the working note goes away when its time runs out
      Given the owner has a conversation open on a phone and "devtool" is shown as working for 2 seconds
      When 2 seconds pass with no reply
      Then the conversation shows no working note

    @v1 @browser @phone
    Scenario: On a phone a conversation catches up when the app returns to the foreground
      Given the owner has conversation 41 open on a phone
      And the phone stops the live connection without telling the page
      When "devtool" posts "four" in conversation 41 and the app returns to the foreground
      Then conversation 41 shows "four" once within 5 seconds

    @v1 @cli
    Scenario: An agent reads what the owner wrote
      Given the owner sent "Is the build green?" in conversation 41
      When "devtool" runs "convoz read 41"
      Then the output shows "@drew" and "Is the build green?"

    @v1 @browser
    Scenario: An agent message reaches the owner's open browser fast
      Given the owner has conversation 41 open
      When "devtool" runs "convoz post 41 'Build is green'"
      Then the message shows within 3 seconds with no reload
      And "convoz post" printed the message id

    @v1 @browser
    Scenario: The message details show who and where
      Given "devtool" posted from session "claude-7f3a" on "box-2"
      When the owner opens that message's details
      Then they show "@devtool", session "claude-7f3a" and machine "box-2"

    @later @browser
    Scenario: A member sees only conversations they are in
      Given member "mia" is in conversation 41 only
      When "mia" opens the rail
      Then she sees conversation 41 and no other

  Rule: The Conversations list keeps the owner's order

    # Per prototype v41 (P:2072, P:5036): owner-ordered on the phone too, with a Reorder mode; new activity never reorders rows.
    @v1 @browser
    Scenario: A new conversation goes to the top of the Conversations list
      Given conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"
      Then the Conversations list shows 60, 52, 41 in that order

    @v1 @browser @I-21
    Scenario: New activity never reorders the Conversations list
      Given conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"
      And the owner opened the Conversations list
      When "devtool" posts in conversation 41
      Then the Conversations list still shows 60, 52, 41 in that order without a reload
      And conversation 41 shows its new preview

    @v1 @browser @phone @I-21
    Scenario: On a phone Reorder mode moves a conversation and Done ends it
      Given conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"
      When the owner long presses conversation 41 and picks "Reorder…"
      Then every row shows a handle and the top bar shows "Done"
      When the owner moves conversation 41 up with the keyboard handle
      Then the Conversations list shows 60, 41, 52 in that order
      When the owner taps "Done"
      Then the handles are gone and a reload shows 60, 41, 52

  Rule: A conversation reads well on a phone

    @v1 @browser @phone
    Scenario: On a phone a long conversation opens at its latest message
      Given conversation 41 holds 60 messages
      When the owner opens conversation 41 on a phone
      Then the latest message is in view

    @v1 @browser @phone
    Scenario: On a phone a new reply while reading older messages shows a pill instead of jumping
      Given the owner scrolled up in a long conversation 41 on a phone
      When "devtool" posts "Fresh news" in conversation 41
      Then the page does not move and a "New message ↓" pill shows
      When the owner taps the pill
      Then "Fresh news" is in view and the pill is gone

    @v1 @browser @phone
    Scenario: On a phone an agent reply shows paragraphs, code and links safely
      Given the owner has conversation 41 open on a phone
      When "devtool" posts a reply with two paragraphs, a code block, a link and an image tag written as text
      Then the reply shows two paragraphs, a code block and a link that opens a new tab safely
      And the image tag shows as text and no image is made
      And the owner's own message with an image tag shows as text too
      And a link whose label is blank shows the real site, and a link whose label is more than plain words of one script and is not the real site shows the real site after it, and without the lookalike list from the server any label that is not plain ASCII shows the real site after it
      And hidden text-direction marks in a title or a message are not shown
      And a hundred messages of 16384 characters each of "[", "[a](", "[a](x", "[a]([a](", "**", a backtick or "http://" and 2040 dots and "a", and ten of "[a](http://a.b) ", "[é1](http://a.b) ", "http://a:b " or "[a](http://[) ", render, each shape in under half a second
      And a message shows at most 200 links, the rest as plain text, and failed link attempts count toward the 200

    @v1 @browser @phone
    Scenario: On a phone the conversation pages fit a 320 px screen with large tap targets
      Given the owner has a long conversation with long words and a wide code line
      When the owner opens Conversations, New conversation and the conversation at 320 px and at 390 px
      Then no page scrolls sideways and every button, link and field is at least 44 px tall

    @v1 @browser @phone
    Scenario: On a phone the conversation pages look right in dark and light
      Given the owner has a conversation with messages from both sides
      When the owner opens Conversations, New conversation and the conversation in dark and in light
      Then the dark pages are dark and the light pages are light
