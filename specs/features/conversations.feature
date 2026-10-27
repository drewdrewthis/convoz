# Source: design draft 9 §2.3, §8 (I-7, I-9, I-15, I-17, I-19, I-20, I-47), §8.2 (unread), §14 (soft delete), AC-6, AC-26.
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

    # Owner report (conv 112 msg 2893, https://github.com/drewdrewthis/convoz/issues/62): a newly created conversation showed no star and
    # no details buttons in its title bar until a reload.
    @v1 @browser
    Scenario: A new conversation has the star and details buttons from its first send
      When the owner starts a new conversation and sends "Plan the search filters launch"
      Then without a reload the title bar shows "Star conversation" and "Show details"
      And "Show details" opens the details

    # Owner report (conv 359 msg 6385): "this conversation was bricked -- I couldn't send? no errors, no toasts, nothing". The app had drawn
    # New conversation from its offline copy, the owner sent before the server said who the crew is, and the late answer started the page over.
    @v1 @browser
    Scenario: A first send made before the crew has loaded keeps its message
      Given the server is slow to say who the owner and the crew are
      When the owner opens New conversation, picks "devtool" and sends "Plan the search filters launch"
      And the server then says who the owner and the crew are
      Then the conversation shows "Plan the search filters launch" and is titled "Plan the search filters launch"
      And a second message "and the rollout" goes to the same conversation
      And the owner has one conversation, with both messages

    @v1 @browser
    Scenario: A first send whose conversation is still being made when the crew loads keeps its message
      Given the server is slow to say who the owner and the crew are, and slower to make a conversation
      When the owner opens New conversation, picks "devtool" and sends "Plan the search filters launch"
      And the server says who the owner and the crew are before it has made the conversation
      Then the conversation shows "Plan the search filters launch" and is titled "Plan the search filters launch"
      And a second message "and the rollout" goes to the same conversation
      And the owner has one conversation, with both messages

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

    # Owner (Drew, conv 7 msg 191): "the @ mention for a new conversation still doesn't work correctly and I can't start a convo with multiple"
    @v1 @browser
    Scenario: In New conversation the owner picks several agents from the @ list and sends
      Given "devtool" and "docs" have a live session
      When the owner opens New conversation and picks "devtool" and then "docs" from the @ list
      Then the message box shows "@devtool" and "@docs"
      When the owner sends "please look at the build"
      Then the new conversation has "devtool" and "docs" as participants
      And "devtool" and "docs" each get a mention item

    # Owner (Drew, conv 7 msg 191): "the @ mention for a new conversation still doesn't work correctly and I can't start a convo with multiple"
    @v1 @browser
    Scenario: In New conversation an agent typed by hand counts like a pick
      Given "docs" has a live session
      When the owner opens New conversation and types "@docs hello" without picking from the list
      Then Send is enabled
      When the owner sends the message
      Then the new conversation has "docs" as a participant
      And "docs" gets a mention item

    # Owner (Drew, conv 15 msg 316): "I can send an image as the first message"
    # Owner (Drew, conv 15 msg 317): "*can't"
    @v1 @browser
    Scenario: The owner can start a conversation with an image and no text
      Given "devtool" has a live session
      When the owner opens New conversation with "devtool" and attaches "chart.png" by the Attach button or by paste
      Then the composer shows "chart.png" under "Files to send" and Send is enabled
      When the owner sends
      Then the new conversation holds one message with the image, and with the words when there are any
      And the conversation is titled by the words, or by the file name when there are none

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

  Rule: An agent in a conversation may rename it; a title the owner chose stays the owner's

    # Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
    # An agent may rename only a title that is automatic or an agent's own. A title the owner chose is the owner's, with no timer.
    @v1 @cli
    Scenario: An agent renames a conversation it is in
      Given conversation 41 with "devtool", titled by its first message
      When "devtool" runs "convoz rename 41 'Build status'"
      Then conversation 41 shows the system line '@devtool renamed this to "Build status"'
      And the title of conversation 41 is "Build status"

    @v1 @cli
    Scenario: An agent cannot rename a title the owner chose
      Given conversation 41 "Ship search filters", named by the owner, with "devtool"
      When "devtool" runs "convoz rename 41 'Something else'"
      Then the command exits 4 and says that a person chose the title
      And the title of conversation 41 is still "Ship search filters"
      And conversation 41 shows no rename line

    @v1 @cli
    Scenario: An agent that is not in a conversation cannot rename it
      Given conversation 41 with "devtool" only
      When "docs" runs "convoz rename 41 'Not mine'"
      Then the command exits 3
      And the title of conversation 41 is unchanged

    @v1 @browser
    Scenario: The owner sees an agent's rename at the top, in the list and in the chat
      Given the owner has conversation 41, titled by its first message, open with "devtool" in it
      When "devtool" renames it to "Build status"
      Then the top of the conversation and the Conversations list show "Build status"
      And the chat shows the line '@devtool renamed this to "Build status"'

  Rule: Agents join only through a human, and see only from their join

    @v1 @browser @I-18
    Scenario: Mentioning an agent adds it at once
      Given conversation 41 with only the owner
      When the owner sends "@devtool please look at #412"
      Then the participants show "devtool"
      And "devtool" gets a mention item

    # Per prototype v41 (+ Add, addAgents): the agent joins at once and there is no history sheet.
    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @browser @I-15
    Scenario: Adding an agent with + Add joins it at once and it sees the whole history
      Given conversation 41 with 20 messages
      When the owner adds "docs" with + Add
      Then the participants show "docs" at once and no history question was asked
      And "docs" runs "convoz read 41" and sees the 20 messages from before the add and the ones after
      And "docs" has no unread messages in conversation 41

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @cli @I-7
    Scenario: An agent sees a thread whose root was posted before it joined
      Given "docs" was added to conversation 41 after thread root 900 was posted
      And the owner replies in thread 900 after the add
      When "docs" runs "convoz read 41 --thread 900"
      Then it sees the reply and no "earlier message not shown" stub for the root

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @cli @I-7
    Scenario: An agent added to a conversation reads the messages from before it joined
      Given conversation 41 had 3 messages before the owner added "docs"
      When "docs" runs "convoz read 41"
      Then it sees all 3 earlier messages

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @cli @I-7
    Scenario: Joining does not put old messages in the new member's inbox
      Given conversation 41 had 3 messages before the owner added "docs"
      When "docs" peeks at its inbox
      Then it has only the notice that it was added and no item for the 3 earlier messages
      And "docs" has no unread messages in conversation 41

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @api @I-7
    Scenario: Events from before an agent joined are not replayed to it
      Given "docs" joined conversation 41 after 10 events in it
      When "docs" reads its inbox
      Then it receives nothing from those 10 events

    @v1 @api @I-17 @AC-26
    Scenario: An agent that creates a conversation cannot pull others in
      When "devtool" creates conversation "Release prep" listing "@docs" and "@release-bot"
      Then the owner sees 2 pending adds in Now for "Release prep"
      And "docs" and "release-bot" get 403 on "convoz read" until the owner approves

  Rule: An agent starts a conversation for its own plan or finished work

    # Owner (Drew, conv 19 msg 343): "agents need to start a new conversation with me and the assistant whenever they have a new plan or think they are done"
    # From @langwatch-technician (conv 19 msg 378): "an agent cannot start a new conversation from the CLI (no command for it)... Let an agent create a conversation with chosen members (for example `convoz new --with @drew,@langwatch-assistant \"title\"`)."
    # A listed agent that already shares a conversation with the creator joins at once; any other one is a join request, as with "convoz add" (I-17).
    @v1 @cli @browser
    Scenario: An agent starts a conversation with the owner and another agent
      Given "devtool" and "docs" share conversation 41
      When "devtool" runs "convoz new --with @drew,@docs 'Plan: search filters' 'Here is the plan.'"
      Then the CLI prints the new conversation id
      And the Conversations list shows "Plan: search filters" with "Drew", "@devtool" and "@docs" in it
      And "Here is the plan." is the first message, written by "devtool"

    @v1 @cli @browser
    Scenario: A new conversation's other agent who shares no conversation with the creator becomes a join request
      When "devtool" runs "convoz new --json --with @release-bot 'Plan: release'"
      Then the CLI prints the conversation id and "release-bot" as pending
      And the owner sees one pending add for "release-bot" in Now
      And "release-bot" cannot read the conversation until the owner approves

    # From @dot (conv 2 msg 490): "Installed CLI … and MCP expose neither conversation creation nor agent discovery. Is there an existing supported way to create that conversation and resolve the writer handle?"
    @v1 @cli
    Scenario: An agent finds another agent's handle
      Given "docs" has the description "Writes the docs" and "release-bot" is disabled
      When "devtool" runs "convoz agents --json"
      Then it lists "docs" with its display name, its description and its state "idle"
      And it lists neither "devtool", nor the disabled "release-bot", nor an id, a key or a machine

    @v1 @cli
    Scenario: An agent starts at most 20 conversations an hour
      Given "devtool" started 20 conversations in the last hour
      When "devtool" runs "convoz new 'One too many'"
      Then the CLI exits 5 and no conversation "One too many" exists
      When an hour has passed
      Then "convoz new 'One more'" works

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

    # Owner, 2026-10-19 (msg 266, on the row "Convoz feedback with Cl... 5"): "This is confusing, right -- I guess this means that there are
    # 5 unviewed items hidden in threads somewhere?" Msg 267: "that's what I was saying we needed to update -- so I could more easily see
    # hidden threads, and jump back in. Basically a conversation is the main thread, but then there are sub-threads right, so I should
    # actually see all the threads on the lists." The conversation badge counts the main chat only; thread replies count on the thread's row.
    @v1 @browser @I-15
    Scenario: Mark all read clears the conversation
      Given conversation 41 has 7 unread main messages and 2 unread replies in an involved thread
      When the owner marks the conversation read
      Then conversation 41 and its thread rows show no unread count and it is not bold

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

    # Owner (Drew, msg 114): "Maybe add like a little count badge on the back button from the conversation so I can see when there's a new response or thing to check it out from the feed or the inbox when I'm in a single conversation"
    @v1 @browser
    Scenario: The Back button counts the other conversations with something new
      Given the owner has read every conversation and has conversation 41 open
      Then the Back button has no count and is named "Back"
      When "devtool" posts "Done" in conversation 41
      Then the Back button still has no count
      When "docs" posts "Ready" in conversation 52
      Then the Back button shows "1" within 3 seconds and is named "Back, 1 new"
      When "docs" posts "Again" in conversation 52
      Then the Back button still shows "1"
      When the owner reads conversation 52 in another tab
      Then the Back button has no count within 3 seconds

    # Owner (Drew, msg 114): "…little count badge on the back button…"
    @v1 @browser
    Scenario: A question waiting in the feed counts on the Back button
      Given the owner has read every conversation and has conversation 41 open
      When "devtool" asks a question in conversation 41
      Then the Back button shows "1" within 3 seconds and is named "Back, 1 new"

    # Owner (Drew, msg 114): "…little count badge on the back button…"
    @v1 @browser
    Scenario: The Back count stops at 99+
      Given the owner has conversation 41 open and 100 other conversations with something new
      Then the Back button shows "99+" and is named "Back, 99+ new"

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
      Then the conversation shows "@devtool is replying…" within 3 seconds
      When "devtool" runs "convoz post" in that conversation with "Yes"
      Then the note is gone and the reply shows

    @v1 @browser
    Scenario: The owner sees when an agent has seen a message
      Given "devtool" runs "convoz watch --json" and the owner has a conversation with "devtool" open
      When the owner sends "Is the build green?"
      Then the message shows "Seen by @devtool" within 3 seconds
      When the owner reloads the page
      Then the message still shows "Seen by @devtool"

    @v1 @browser
    Scenario: The owner sees an agent replying in a thread
      Given "devtool" runs "convoz watch --json" and the owner has the thread of message 900 open
      When the owner replies "Can step 1 ship on its own?" in the thread
      Then the thread shows "@devtool is replying…" within 3 seconds
      And the conversation shows no replying note

    @v1 @browser
    Scenario: Replying clears when the agent posts
      Given the owner has a conversation with "devtool" and "docs" open
      When "devtool" and "docs" run "convoz typing" in that conversation
      Then the conversation shows "@devtool and @docs are replying…" within 3 seconds
      When "devtool" runs "convoz post" in that conversation with "Yes"
      Then the conversation shows "@docs is replying…" and the reply shows

    @v1 @browser
    Scenario: A card in Now shows who has seen and who is replying
      Given "devtool" asked a question in a conversation and runs "convoz watch --json"
      When the owner sends "Take your time" in that conversation
      Then the card in Now shows "Seen by @devtool" and "@devtool is replying…" within 3 seconds
      When "devtool" runs "convoz ack" without a reply
      Then the card in Now still shows "Seen by @devtool" and no replying note

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

    # Per prototype v41 (P:2072, P:5036): owner-ordered on the phone too, with a Reorder mode; a new message puts a row on top.
    @v1 @browser
    Scenario: A new conversation goes to the top of the Conversations list
      Given conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"
      Then the Conversations list shows 60, 52, 41 in that order

    @v1 @browser @I-21
    Scenario: New activity puts a conversation on top of the Conversations list
      Given conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" were created in that order with "devtool"
      And the owner opened the Conversations list
      When "devtool" posts in conversation 41
      Then the Conversations list shows 41, 60, 52 in that order without a reload
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

    @v1 @browser
    Scenario: Agent replies use the full width
      Given the owner has conversation 41 open
      And the owner sent "Is the build green?" and "devtool" replied "Yes, all 11 checks pass"
      Then the reply has no bubble and fills the message column
      And the message column is the screen with 12 px gutters on a phone and a centred 760 px column on a desktop
      And the owner's message is a compact bubble on the right, at most 85% wide, with its time above it

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

    # Owner (Drew, msg 253): "We just had to scroll really far for this conversation. There's a lot of text. I guess you should try to scroll to the bottom initially by itself."
    @v1 @browser
    Scenario: A long conversation opens at the newest message
      Given conversation 41 holds 200 long messages with code, images and asks
      When the owner opens conversation 41 from the Conversations list
      Then the newest message is in view and stays there
      When the owner reloads the page
      Then the newest message is in view and stays there
      When the owner goes back to the list and forward again
      Then the newest message is in view and stays there
      When the owner opens conversation 41 on a slow network
      Then the newest message is in view and stays there

    # Owner (Drew, msg 253): "We just had to scroll really far for this conversation."
    @v1 @browser
    Scenario: A link to a message in a long conversation still opens at that message
      Given conversation 41 holds 200 long messages with code, images and asks
      When the owner opens the link to "msg-101"
      Then "msg-101" is in view and the log is not at the newest message

    # Owner (Drew, msg 253): "And then if you're not there, maybe a little button hovers to scroll to the bottom automatically. Just make it easier."
    @v1 @browser
    Scenario: A Jump to latest button shows when the owner scrolls up and takes them to the newest message
      Given conversation 41 holds 200 long messages with code, images and asks
      And the owner has conversation 41 open at its newest message
      Then no Jump to latest button shows
      When the owner scrolls up two screens
      Then a round Jump to latest button floats above the composer and covers neither the composer nor the log's last line
      And it reads clearly in the dark and the light look
      When the owner taps the button
      Then the newest message is in view and the button is gone
      When the owner scrolls up two screens and "devtool" posts "Fresh news" in conversation 41
      Then the one button reads "New message ↓" with the count and no second control shows
      When the owner taps it
      Then "Fresh news" is in view and the button is gone

    # Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
    @v1 @browser
    Scenario: A New messages line marks where unread began and stays while the chat is open
      Given "devtool" posted "First news", "Second news" and "Third news" in conversation 41 while the owner was away
      When the owner opens conversation 41
      Then a "New messages" line shows above "First news"
      And the line is not above "Second news" or "Third news"
      When "devtool" posts "Fourth news" in conversation 41
      Then the "New messages" line is still above "First news" and shows only once
      When the owner leaves and opens conversation 41 again
      Then no "New messages" line shows

    # Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
    @v1 @browser
    Scenario: Messages by one author more than 5 minutes apart are separate groups with their time
      Given "devtool" posted "Early" and then 6 minutes later "Late" and "Later" in conversation 41
      When the owner opens conversation 41
      Then "Early" and "Late" each show with the author's name and time
      And "Later" shows without its own name or time

    # Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
    @v1 @browser
    Scenario: A pill counts new messages while the owner reads above and jumps to the first of them
      Given the owner scrolled up in a long conversation 41
      When "devtool" posts "Fresh one" and "Fresh two" in conversation 41
      Then a pill reading "↓ 2 new" shows and the page does not move
      When the owner taps the pill
      Then "Fresh one" is in view and the pill is gone

    # Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
    @v1 @browser
    Scenario: Nothing shows through the name and buttons at the top
      Given the owner has conversation 41 open and scrolled so that messages pass under the name and buttons at the top
      Then the title area belongs to the top of the conversation and not to a message behind it
      And the title area looks the same with the messages hidden

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

    # Owner (conv 179 msg 4100): agent handles should be clickable. Issue 34.
    @v1 @browser
    Scenario: The agent handle under the title of a conversation opens that agent
      Given a conversation with "devtool" is open
      When the owner clicks the handle @devtool under the title
      Then the agent page of "devtool" opens

    @v1 @browser
    Scenario: The agent handle on its card in the details panel opens that agent
      Given a conversation with "devtool" is open with its details showing
      When the owner clicks the handle @devtool on its card
      Then the agent page of "devtool" opens
