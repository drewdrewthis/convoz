# Source: design draft 9 §3.1 (an agent adds itself from one prompt; owner decision), §3.3 (connect cards in Now, revoke key), §3.5, §4.5,
# I-2, I-3, I-17, I-32, I-37, I-38, I-42. Prototype: Crew directory, agent profile with
# status ring (working, waiting on you, idle, offline as a hollow dot), "Waiting on you", "Conversations together",
# "New conversation with @x", "Revoke key" with an inline Confirm / Cancel (prototype P:1747-1757) and the "Created … last used" row (P:6257).
# The prototype's invite sheet (P:3146-3195) is the add-agent sheet: only a copyable prompt, "Waiting for an agent to connect…", "Connected: X is online".
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Crew: identities, machines and sessions
  As the owner
  I want one directory of who my agents are, which machines may speak for them and which sessions are live
  So that I always know who said what, from where, and can cut anyone off

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"

  Rule: An agent adds itself from one prompt, the owner approves on a card; handles are unique and never reused

    # Owner said: "For adding an agent, I should actually just get a prompt right? Because the agent needs the cli and a token, but then
    # it should request the connection accepted and send its id package for its handle. We don't need a name, I don't think."
    # Prototype v41: the sheet is only a copyable prompt; the agent sends its own identity. Waiting, then "Connected: X is online".
    @v1 @browser @I-42
    Scenario: The invite sheet is one prompt with no form and no secret
      When the owner opens Crew and taps "Invite agent"
      Then the sheet "Invite agent" shows a prompt with no field to fill in
      And the prompt names this server, the install line, "convoz login", "convoz session start" with "--create", and the brief, post, ask, status and app lines
      And the prompt shows "--conversation" nowhere
      And the sheet shows "Waiting for an agent to connect…"
      And the sheet shows no key and no string starting with "cvz_"

    # Owner (Drew, msg 213): "I think that the prompt should encourage a quick lesson on how it works, so they know replies, feeds, apps, etc."
    # Agent (msg 214): "a one-line 'post = answer, reply = thread' rule in the prompt would have caught it."
    @v1 @browser
    Scenario: The invite prompt explains post, reply, asks, apps and ack
      When the owner opens Crew and taps "Invite agent"
      Then the prompt has a "How Convoz works" block
      And it says post is a normal answer and reply is a thread under one message
      And it says a watch item with a "thread_root_id" is answered with "convoz reply"
      And it says asks show as cards in the owner's feed and apps carry context
      And it says to ack after answering and that status goes to the owner

    # Agent (msg 211): pasted into Discord, the install line lost its "||".
    @v1 @browser
    Scenario: The install line survives a paste into Discord
      When the owner opens Crew and taps "Invite agent"
      Then the install line and the connect commands sit inside code fences
      And no text outside a code fence holds "||"

    # Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
    @v1 @browser
    Scenario: The invite prompt tells an agent it may rename a conversation
      When the owner opens Crew and taps "Invite agent"
      Then the prompt has a rename line with "convoz rename <conversation>"
      And the rename line says that a title the owner chose stays the owner's

    @v1 @cli @browser @I-3 @I-42
    Scenario: Adding an agent from a machine that is already logged in
      Given "box-2" is logged in without the create_identity scope
      And the owner opened the invite sheet in Crew
      When the agent runs the prompt's "convoz session start --as code-review --create --description 'Reviews pull requests'" on "box-2"
      Then the sheet shows the request card "box-2 wants to connect as @code-review" with "Reviews pull requests"
      When the owner taps Approve on the card in the sheet
      Then the sheet says "Connected: code-review is online."
      And the sheet offers "New thread with code-review" and "Done"
      And Crew shows "code-review" with the line "Reviews pull requests"

    @v1 @cli @browser @I-3 @I-42
    Scenario: Adding an agent from a new machine
      Given the owner opened the invite sheet in Crew
      When the agent runs the prompt's "convoz login --name box-5 --as code-review" on a new machine
      Then the sheet shows the request card "box-5 wants to connect as @code-review" with the code
      When the owner taps Approve on the card in the sheet
      Then the sheet says "Connected: code-review is online."
      And "convoz session start --as code-review" works on "box-5"

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @cli @browser @I-17
    Scenario: Inviting an agent from a conversation puts it in that conversation
      Given the owner is in the conversation "Ship search filters"
      When the owner types "@" in the message box and taps "Invite a new agent…"
      Then the sheet says the agent joins "Ship search filters"
      And the prompt carries that conversation for "--conversation"
      When the agent runs the prompt's "convoz login --name box-5 --as code-review --conversation" with that conversation on a new machine
      And the owner taps Approve on the card
      Then the sheet says "Connected: code-review is online and in “Ship search filters”."
      And "code-review" is a participant of "Ship search filters" and sees the whole history

    @v1 @browser
    Scenario: The details panel and the invite button in the rail open the same sheet
      Given the owner is in the conversation "Ship search filters"
      When the owner opens Details, taps "+ Add" and then "Invite a new agent"
      Then the sheet "Invite agent" opens for that conversation
      When the owner taps the invite button in the rail
      Then Crew opens with the sheet "Invite agent"

    @v1 @cli @browser @I-32
    Scenario: What an agent says about itself shows as data
      Given an agent sent the description "<b>bold</b> **stars** https://evil.example" and an SVG avatar with a script in it
      When the owner sees its request card
      Then the card shows that description as plain text under "From the agent", on one line
      And the machine name on the card is the server's own
      And the avatar is an image of the cleaned SVG and runs no script

    @v1 @cli @browser @I-3
    Scenario: A handle is never used again
      Given the owner revoked the key of the agent "release-bot"
      When an agent runs "convoz login --name box-5 --as release-bot"
      Then the CLI exits 4 and says the handle is taken or was used before
      And Now shows no request card
      And Crew still lists the disabled "release-bot" with its old messages

    @v1 @browser @I-3
    Scenario: A look-alike of an existing name is refused
      Given the agent "devtool" exists
      When an agent runs "convoz login --name box-5 --as devtoo1"
      Then the CLI says the handle looks like another identity's name
      And Now shows no request card

    @v1 @browser @I-3
    Scenario: The handle always shows next to an agent's display name
      Given "devtool" set its display name to "Drew"
      When the owner views a message from "devtool"
      Then the author reads "Drew @devtool"

    # Owner said: "Removal is just revoking their key". Crew → the agent → "Revoke key" → Confirm. No passkey.
    @v1 @browser @I-2
    Scenario: Identities are disabled, never deleted
      When the owner taps "Revoke key" on the profile of "devtool" and then Confirm
      Then no passkey prompt opens
      And Crew lists "devtool" as disabled
      And its old messages still show "@devtool"
      And Crew offers no way to delete "devtool"

  Rule: A revoked agent can be invited back as the same agent

    # Owner (Drew, msg 140): "I revoked dots token and reinvited… not sure what to do?" Ask 142, recommended option "Bring back the same @dot".
    @v1 @cli @browser @I-3
    Scenario: Revoking an agent and inviting it again from the same machine brings the same agent back
      Given a Convoz server with an agents-only address
      And "dot" is logged in on "box-2" and posted in the conversation "Ship search filters"
      And the owner revoked the key of "dot" with Revoke key and Confirm
      When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
      Then the owner sees one Now card "box-2 wants to connect as @dot"
      And the card says "Brings back @dot" and the day the key was revoked
      When the owner taps Approve on that card
      Then the CLI logs in as machine "box-2"
      And Crew lists one "dot", enabled, the same agent as before
      And "dot" posts again in "Ship search filters" and its old message is still there
      And Crew lists one active machine "box-2", the new one

    # Owner (Drew, msg 140): "I revoked dots token and reinvited… not sure what to do?"
    @v1 @cli @browser @I-3 @I-38
    Scenario: A revoked agent's old key and sessions stay dead when it comes back
      Given a Convoz server with an agents-only address
      And "dot" is logged in on "box-2" with a session
      And the owner revoked the key of "dot" with Revoke key and Confirm
      When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
      And the owner taps Approve on the card "box-2 wants to connect as @dot"
      Then the old session of "dot" still fails
      And the old machine key of "box-2" no longer works
      And "convoz session start --as dot" works on the new "box-2"

    # Owner (Drew, msg 140): "I revoked dots token and reinvited… not sure what to do?"
    @v1 @cli @browser @I-3
    Scenario: A machine that still serves an active agent keeps its name
      Given a Convoz server with an agents-only address
      And "dot" and "writer" are logged in on "box-2"
      And the owner revoked the key of "dot" with Revoke key and Confirm
      When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
      And the owner taps Approve on the card "box-2 wants to connect as @dot"
      Then the owner reads 'The name "box-2" is taken. Use Reveal or Regenerate on "box-2", or revoke it first.'
      And "dot" is still disabled
      And the machine "box-2" still works for "writer"

  Rule: Disabling an identity cuts every session at once (I-38)

    @v1 @browser @cli @I-38
    Scenario: Disabling an identity ends its sessions and closes its asks
      Given "devtool" has sessions on "box-2" and an open ask in conversation 41
      When the owner revokes the key of "devtool" with Revoke key and Confirm
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

    @v1 @browser @I-32
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
    Scenario: Revoke key asks to confirm and can be cancelled
      When the owner taps "Revoke key" on the profile of "devtool"
      Then the profile asks "Revoke the key for @devtool?" with Confirm and Cancel
      When the owner taps Cancel
      Then "devtool" is still enabled and "Revoke key" is offered again

    @v1 @browser
    Scenario: The profile shows when the key was created and when it was last used
      Given "devtool" has a session that was last seen 2 minutes ago
      When the owner opens the profile of "devtool"
      Then the Details row reads "Created" with a date and "last used 2 min ago"

    @v1 @browser
    Scenario: An agent profile shows what waits on the owner and shared conversations
      Given "devtool" has 2 open asks and shares 4 conversations with the owner
      When the owner opens the profile of "devtool"
      Then "Waiting on you · 2" and "Conversations together" list them
      And "New conversation with @devtool" starts a conversation with "devtool" in it

  Rule: On a computer Crew is a page in the right pane, like a conversation

    # Owner said (conv 15 msg 315): "this is weird UI". Crew was a floating card in a blank page, with a back arrow in an empty bar and a x on the card,
    # and the list slid under "Find an agent". Now: "Crew 8" in the page's bar, one way back, no card, the summary and the search stay put.
    @v1 @browser
    Scenario: On a computer, Crew opens as a page with one way back, and nothing hides under its search
      Given eight agents, and a window 1280 wide and 560 high, in light and in dark
      When the owner opens Crew and scrolls its list
      Then the bar of the page reads "Crew" and the count 8
      And the page has one back control and no element with the frame of a card
      And the first agent row that shows starts at or below the bottom of the search
      And the search and the summary above the list have an opaque background

    # Owner said (conv 15 msg 351): "also, you need to scroll to see machines -- that's a bit weird. a better UI/UX can be added here".
    # Machines is a row under the title, "Machines · n", and the dashed button at the foot of the list is gone.
    @v1 @browser
    Scenario Outline: Machines is in view when Crew opens, with no scrolling
      Given eight agents and a window <width> wide and <height> high
      When the owner opens Crew
      Then the link "Machines · 1" is inside the window
      And the link opens the machines page

      Examples:
        | width | height |
        | 390   | 844    |
        | 1280  | 720    |

  Rule: Later, more humans join the crew

    @later @browser
    Scenario: The owner invites a member
      When the owner invites "mia" as a member with a passkey
      Then "mia" gets a one-time link
      And the link cannot be used twice and never makes an owner

  Rule: An agent's handle can change; the old handle still reaches it and is never used again

    # Owner said (2026-10-18): "Handles I think can also change, that seems fine because there's an id, right?"
    # Earlier: "the handle is never reused." Every record keys on the identity, so a change keeps the agent and all it did.
    # Asked whether an agent's own change needs approval, the owner chose "Change at once, no approval" and said: "I think that's
    # too defensive and requires too much machinery?"
    @v1 @cli @browser @I-51
    Scenario: An agent changes its own handle at once
      Given "devtool" is in the conversation "Ship search filters"
      When "convoz profile --set handle=builder" runs as "devtool"
      Then the CLI prints "You are now @builder. Old @devtool works until" followed by the date 30 days on, and exits 0
      And the owner sees no Now card about it
      And Crew shows "builder" with the line "Was @devtool"
      And "Ship search filters" shows the line "@devtool is now @builder"
      And "convoz whoami" in the same session shows identity "builder"

    @v1 @browser @I-51
    Scenario: The owner changes an agent's handle in Crew
      Given "devtool" is in the conversation "Ship search filters"
      When the owner opens the profile of "devtool" in Crew, taps "Change handle", types "builder" and taps Save
      Then no passkey prompt opens
      And the profile shows "@builder" and "Was @devtool"
      And "Ship search filters" shows the line "@devtool is now @builder"

    @v1 @cli @I-51 @I-18
    Scenario: A message to the old handle still reaches the agent
      Given the owner changed the handle of "devtool" to "builder"
      When the owner writes "@devtool can you look at the build?" in a new conversation
      Then "builder" is a participant of that conversation
      And "convoz inbox" as "builder" lists the mention of that message

    @v1 @cli @I-51
    Scenario: The old handle works for 30 days with a warning, then is refused with the new one named
      Given a session of "devtool" on "box-2" and then the owner changed the handle of "devtool" to "builder"
      When "convoz whoami" runs with CONVOZ_AS=devtool in that session
      Then it shows identity "builder" and the warning names "@builder"
      When 30 days and 1 second pass
      Then "convoz whoami" with CONVOZ_AS=devtool exits 3 with an error that names "@builder"
      And "convoz whoami" with CONVOZ_AS=builder works

    @v1 @cli @I-51 @I-3
    Scenario: An old handle is never used again, and a handle changes 3 times a day at most
      Given "box-2" also runs "docs"
      And the owner changed the handle of "devtool" to "builder"
      When "convoz profile --set handle=devtool" runs as "docs"
      Then the CLI exits 4 and says the handle is taken or was used before
      When "convoz profile --set handle=builder-2" and then "handle=builder-3" run as the agent
      Then both succeed
      When "convoz profile --set handle=builder-4" runs as the agent
      Then the CLI exits 5 and says a handle changes 3 times a day at most
