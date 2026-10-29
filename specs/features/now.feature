# Source: design draft 9 §4.2 (`now`: asks, pending adds, machine requests), §8.1, §9 (badge, deep links),
# §13 GET /api/now, I-13, I-15, I-17, I-36. Prototype: the ask bar (R quick reply, S snooze, X dismiss, O open app).
# Kept from the draft-6 spec, reworded: Needs-you → Now; Done → Dismiss; snooze hides then returns;
# unsnooze returns at once; the count updates in every open tab.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Now
  As the owner
  I want one screen with everything waiting on me: asks, pending agent adds and machine requests
  So that I can clear my queue from my phone in a few taps

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: Every item in the dev build shows when it last changed, and its thread starts collapsed

    @v1 @browser @unimplemented
    Scenario: An item shows a relative time with the exact time on hover
      Given a server item changed 5 minutes ago, an ask was asked 2 hours ago and a done step finished yesterday
      When the owner opens Now in the dev build
      Then the items show "5m", "2h" and "Yesterday" in a time element, and the exact date and time on hover
      And the times move on as the minutes pass

    @v1 @browser @unimplemented
    Scenario: A thread starts collapsed with a one-line summary, and Reply opens it
      Given an item whose thread has 3 replies and an item whose thread has none
      When the owner opens Now in the dev build
      Then the first shows "Show thread · 3 replies" with the replies hidden, and the second shows no thread
      When the owner presses "Reply" on the second
      Then its thread opens with the reply box in focus and stays open

  Rule: Reply on any item in the dev build opens a reply box in focus

    @v1 @browser @unimplemented
    Scenario: Reply on a server item with no thread shows the empty reply box in focus, and a sent reply starts the thread
      Given "devtool" has a started item "Index the filters" that nobody has replied to
      When the owner opens Now in the dev build
      Then the item shows no reply box
      When the owner presses "Reply" and sends "Use the new index"
      Then the box was in focus when it appeared, and the item shows its thread with the reply

  Rule: Sending a reply closes the item, and an agent's reply reopens it (dev build)

    @v1 @browser @unimplemented
    Scenario: After Reply sends, the item leaves the list, and comes back when the agent replies
      Given "devtool" has a blocking item "Merge the filters" in the list
      When the owner presses "Reply" and sends "Go, but wait for CI"
      Then the item leaves the list
      When "devtool" replies in the item's thread
      Then the item is in the list again, even if the owner had snoozed it

  Rule: Every ask in the dev build is drawn as an item (owner, conv 179 msg 12807, 12813)

    @v1 @browser @unimplemented
    Scenario: A permission ask is an item: the action is the title, risk and undo the context, with Okay, Reply and Snooze
      Given "devtool" asked "Do you OK this?" with the action "Merge PR 12 into main", a risk, an undo and one other way
      When the owner opens Now in the dev build
      Then the card is titled "Merge PR 12 into main" and its context has the risk, the undo and the other way
      And it has Okay, Reply, Snooze and the item menu, and no "Needs your OK", "I will", Go, Not this, I have questions or Dismiss

    @v1 @browser @unimplemented
    Scenario: A draft ask is an item: the draft is the context, Okay sends it as written, Reply edits it first
      Given "devtool" asked "Send this to Alex?" with the draft "Thanks, Friday works."
      When the owner opens Now in the dev build
      Then the card is titled "Send this to Alex?" and its context starts "Draft:" with the text
      When the owner presses "Okay"
      Then the draft is sent as written
      When the owner presses "Reply" on another draft
      Then the reply box opens with the draft text, and Send sends the edited text

  Rule: An ask message in a conversation is drawn as the item (dev build, owner conv 179 msg 12889, 12904)

    @v1 @browser @unimplemented
    Scenario: An open ask in a conversation is a blocking item, and a closed one is a done item with one line
      Given a conversation holds an ask "Merge PR 12?" from "devtool"
      When the owner opens the conversation in the dev build
      Then the ask is a blocking item with Okay, Reply and Snooze and no From link
      When the owner presses "Okay"
      Then the ask is a done item with the line "Go, by drew" and no buttons, and Pin and Delete stay in its menu

  Rule: Okay and Snooze work on the cards the browser builds (dev build, owner conv 179 msg 12910)

    @v1 @browser @unimplemented
    Scenario: Okay hides a question card until it moves
      Given the owner's question "Can step 1 ship?" shows as a card
      When the owner presses "Okay"
      Then the card leaves Now, and returns when the conversation moves on

  Rule: A question card is only for a real question, and the owner's reply closes it (dev build, owner conv 179 msg 12991 and 12992)

    @v1 @browser @unimplemented
    Scenario: A bare reply word is no question card
      Given the owner answered an ask with "Go" and an agent then wrote in the chat
      Then Now shows no card "Your question: Go"

    @v1 @browser @unimplemented
    Scenario: The owner's reply closes a question card until an agent writes again
      Given the owner's question "Why is CI red?" shows as a card
      When the owner replies from the card
      Then the card leaves Now
      When an agent writes in that thread
      Then the card returns

  Rule: A started item quiet for 15 minutes says so (dev build, owner conv 179 msg 12699, 12763)

    @v1 @browser @unimplemented
    Scenario: A started item with no update for 15 minutes shows the time of its last update
      Given "devtool" has a started item whose last update was 20 minutes ago
      When the owner opens Now in the dev build
      Then the item shows "No update since" and that time under its context
      And a blocking item, a done item and a started item updated a minute ago show no such line

  Rule: Okay takes a server item out of the feed, whatever its state (dev build)

    @v1 @browser @unimplemented
    Scenario: Okay on a started item or a blocking item with no recommendation hides it until the agent moves it again
      Given "devtool" has a started item "Index the filters" and a blocking item "Which branch?" with no recommendation
      When the owner opens Now in the dev build and presses "Okay" on each
      Then both leave the list on every device
      When "devtool" blocks "Index the filters"
      Then it is in the list again

  Rule: Every item in the dev build has the actions Okay, Reply and Snooze, each with the icon of the main Now

    @v1 @browser @unimplemented
    Scenario: Okay, Reply and Snooze show a label and the icons of the ask card
      Given a blocking item that recommends something in the dev build
      When the owner opens Now
      Then the item shows "Okay" with a check, "Reply" with the chat bubble and "Snooze" with the clock, and no "Add info", "Accept" or "Got it"
      When the owner presses "Reply"
      Then the item's thread opens and the reply box has focus, and the item stays in the list

  Rule: In the dev build an item opens directly into a thread about it

    @v1 @browser @unimplemented
    Scenario: An open ask shows its thread with a reply box, without a click
      Given an agent has an open ask in Now in the dev build
      Then the ask's frame shows its thread and a reply box
      When the owner writes a reply
      Then it shows in the thread and the owner stays in Now

    @v1 @browser @unimplemented
    Scenario: The owner's answered question shows its thread the same way
      Given the owner asked a question in a conversation and an agent answered
      Then the question's item in Now shows the conversation thread of that question with a reply box


  Rule: An item the server keeps opens directly into its thread (dev build)

    @v1 @browser @unimplemented
    Scenario: A server item shows its thread, or an empty reply box that starts one
      Given an agent made an item with "convoz item block", and an older item has no thread root
      Then an item with a thread shows it with a reply box, and an item with none shows an empty reply box
      When the owner writes in the empty reply box
      Then the text starts the thread, shows in it, and the owner stays in Now

  Rule: In the dev build every item has a vertical dots menu with Copy link

    @v1 @browser @unimplemented
    Scenario: An ask copies the link of its message
      Given an agent has an open ask in Now in the dev build
      When the owner opens the dots menu of the ask's frame and taps "Copy link"
      Then the clipboard holds the full link of the ask's message in its conversation
      And the app shows "Link copied"

    @v1 @browser @unimplemented
    Scenario: A server item copies the link of its thread, else of its conversation
      Given the server keeps an item in the feed, with a thread or without one
      When the owner opens the dots menu of the item's frame and taps "Copy link"
      Then the clipboard holds the full link of the thread's root message, or of the conversation when the item has no thread

  Rule: The one-list Now, the right drawer and the Work screen are the app's screens, in the main app and the dev build (/dev) alike (Drew, conv 179 msg 13342)

    @v1 @browser @unimplemented
    Scenario: The dev build opens Now in a right-side drawer with the address ?panel=now
      Given the owner is in the dev build with a conversation open
      When the owner presses Cmd+.
      Then Now opens in a drawer on the right, the conversation stays visible, and the address has "?panel=now"

    @v1 @browser @unimplemented
    Scenario: The app names Deliveries as Work
      Given the owner is in the main app
      When the owner opens Work from the rail on a computer, or from the bottom bar on a phone
      Then the page is Work, at "/delivery"

    @v1 @browser @unimplemented
    Scenario: The main app draws the one-list Now, the right drawer and Work
      Given the owner is in the main app
      When the owner opens Now, presses Cmd+. in a conversation, and opens Work
      Then each is the screen the dev build drew before (one list of items, the drawer, the Work page)

  Rule: Now is one list of feed items, newest first, each following one piece of work: started, blocking or done

    @v1 @browser @unimplemented
    Scenario: The list has no section headings and mixes blocking and fyi items
      Given "devtool" asked "Merge #415 on its own?" and "docs" finished the deliverable "Search filters" today
      When the owner opens Now
      Then there are no headings "Needs you" and "Updates"
      And the items are listed newest first in one list

    @v1 @browser @unimplemented
    Scenario: A blocking item shows the frame and Okay answers with the first option
      Given "devtool" asked "Merge #415 on its own?" with the recommended option "Merge" because "CI is green"
      When the owner opens Now
      Then the item shows the marker "Blocking", the title "Merge #415 on its own?", the context "Recommended: Merge", the link "From Ship search filters" and the actions "Okay", "Reply" and "Snooze"
      And the item has no "Dismiss" button and no list of options
      When the owner presses "Okay"
      Then the ask is answered with "Merge"

    @v1 @browser @unimplemented
    Scenario: Reply opens the thread inside the item with the reply box in focus
      Given "devtool" asked "Merge #415 on its own?"
      When the owner opens Now and presses "Reply"
      Then the thread opens inside the item and the reply box has focus

    @v1 @browser @unimplemented
    Scenario: A plan step that waits on the owner is a blocking item
      Given the plan of "devtool" in conversation 41 waits on the owner for "Pick the launch date"
      When the owner opens Now
      Then the item shows the marker "Blocking", the title "Pick the launch date" and the link "From Ship search filters"
      And "Okay" and "Reply" open conversation 41
      And the item has no "Snooze" button

    @v1 @browser @unimplemented
    Scenario: A step done today is a done item with no action yet
      Given the plan of "devtool" in conversation 41 lists "Search filters" as done today
      When the owner opens Now
      Then the item shows the state "Done", the title "Search filters — done" and the link "From Ship search filters"
      And the item has no "Okay" button

    @v1 @browser @unimplemented
    Scenario: The first Now line of a plan is the item and the rest are Next
      Given the plan of "devtool" in conversation 41 has the Now lines "Index the filters" and "Write the docs" and the Next line "Ship"
      When the owner opens Now
      Then one item shows the state "Started" and the title "Index the filters"
      And it shows the quiet line "Next: Write the docs · Ship"

    @v1 @browser @unimplemented
    Scenario: The same step is one row that moves from started to done
      Given the plan of "devtool" lists "Index the filters" in Now
      When "devtool" moves "Index the filters" to done
      Then Now lists one row for "Index the filters", with the state "Done"

    @v1 @browser @unimplemented
    Scenario: A question the owner asked, once an agent replied, is an item
      Given the owner wrote "Why is CI red?" in conversation 41 and "devtool" replied "A flaky test. Fixed."
      When the owner opens Now
      Then the item shows the state "Done", the title "Your question: Why is CI red?", the context "A flaky test. Fixed." and the link "From Ship search filters"

    @v1 @browser @unimplemented
    Scenario: A question the owner followed up on is started
      Given the owner wrote "Why is CI red?", "devtool" replied, and the owner wrote again in its thread
      When the owner opens Now
      Then the item shows the state "Started" and the title "Your question: Why is CI red?"

    @v1 @browser @unimplemented
    Scenario: The dev build hides the mention and reply cards unless old=1
      Given a message that mentions the owner is unread in conversation 41
      When the owner opens Now in the dev build
      Then no mention card is listed
      When the owner opens Now with "?old=1"
      Then the mention card is listed

  Rule: Items the server keeps (GET /api/feed) join the list with real actions

    @v1 @browser @unimplemented
    Scenario: Okay on a blocking item that recommends something accepts it
      Given "devtool" has a blocking item "Pick the launch date" recommending "Friday" in conversation 41
      When the owner opens Now and presses "Okay"
      Then the item is done and leaves the list

    @v1 @browser @unimplemented
    Scenario: Okay on an item that changed is refused and the owner is told
      Given the owner sees a blocking item and "devtool" raises its version
      When the owner presses "Okay"
      Then Now reads the feed again and says "This changed, look again."

    @v1 @browser @unimplemented
    Scenario: Reply sends the owner's words in the item's thread, and the item stays
      Given "devtool" has a blocking item "Pick the launch date"
      When the owner presses "Reply" and sends "Friday works"
      Then the text shows in the item's thread, the agent is woken, and the item stays in the list

    @v1 @browser @unimplemented
    Scenario: Okay on an fyi item hides it and Snooze hides any item until its time
      Given "devtool" has an fyi item "Search filters shipped"
      When the owner presses "Okay"
      Then the item leaves the list on every device
      When the owner snoozes another item until tomorrow
      Then it is hidden until tomorrow 9:00

    @v1 @browser @unimplemented
    Scenario: With no items the list looks like the rest of Now
      Given no agent has used items
      When the owner opens Now
      Then no empty item section is drawn

  Rule: Now lists what waits on the owner, most urgent first

    @v1 @browser
    Scenario: Urgent asks come before other asks
      Given "devtool" asked "Merge #415 on its own?" and then "docs" asked an urgent "Roll back box-3?"
      When the owner opens Now
      Then "Roll back box-3?" is listed first
      And each ask shows the agent as "Display Name @handle" and the conversation title

    @v1 @browser
    Scenario: Now shows pending adds and machine requests next to asks
      Given "devtool" requested to add "@release-bot" to conversation 41
      And a machine request "box-9" with the code "PLRT-HXCV" is pending
      When the owner opens Now
      Then Now shows the pending add with Approve and Decline
      And Now shows the machine request card with the code "PLRT-HXCV"

    @v1 @browser @phone
    Scenario: The badge counts open asks that are not snoozed
      Given 3 open asks and 1 of them snoozed
      And this browser last had Now in the desktop rail
      When the owner opens Now on the phone
      Then Now is the full-screen page with no rail and no Now toggle button
      When the installed app is in the background
      Then the app badge shows 2

    # Owner, msg 275: "also, this page is almost really nice. I'd say center everything, and drop the nothing needs you to where the list would be underneith"
    @v1 @browser
    Scenario: With nothing waiting, the feed centres the wordmark, the all-clear line under it, and the folds
      Given conversation 41 has an answered ask and a dismissed ask, and nothing else waits
      When the owner opens Now
      Then the wordmark, "All clear. Nothing needs you." and the fold chips are centred in the page column, in that order from the top
      And the page does not scroll sideways

    # Owner, conv 1, msg 535: "hmm, it says nothing needs me, but there are a lot of unseen responses.. i'm wondering if there's a better way for that to be handled"
    # Msg 562: "hmm, probably you can come up with a good ui/ux for that that really makes the absorbtion of info quick an easy"
    @v1 @browser
    Scenario: With no decisions but unread conversations, Now lists them instead of saying all clear
      Given no decision waits and "devtool" posted 5 messages in conversation 41 that the owner has not read
      When the owner opens Now
      Then Now says "No decisions waiting" and not "All clear. Nothing needs you."
      And the wordmark is not shown, so the "Other chats" list sits near the top
      And the "Other chats" list has one row for conversation 41 reading "devtool, 5 new"

    # Owner, conv 179 msg 6018 (UX review): a card that needs the owner is cleared with Done; a reply card keeps Mark read
    @v1 @browser
    Scenario: A Needs you card has Done instead of Mark read
      Given "docs" posted "@drew can you check the deploy log?" in conversation 42, and the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered
      When the owner opens Now with the mention and reply cards turned on
      Then the card of conversation 42 under Needs you has "Done" and no "Mark read"
      And the card of conversation 41 under "Replies to you" has "Mark read" and no "Done"
      When the owner taps "Done" on the card of conversation 42
      Then the card leaves the list and conversation 42 has 0 unread

    # Owner, conv 324, msg 5900: "Mark read" works once, then every card goes grey and cannot be clicked
    # Owner, conv 179 msg 6018 (UX review): a Needs you card has "Done" in place of "Mark read"
    @v1 @browser
    Scenario: Marking two cards read in a row works and the other cards stay clickable
      Given 3 conversations where an agent @mentions the owner, so "Mentions of you" has 3 cards, and the first "Done" is slow to finish
      When the owner opens Now with the mention and reply cards turned on and taps "Done" on the first card
      Then "Done" on the other two cards is still enabled
      When the owner taps "Done" on the second card
      Then the second card leaves the list
      When the first "Done" finishes
      Then the first card leaves the list
      And only the third card is left, and its "Done" button is enabled

    # Issue 103: a mention card has "Later" like an ask has Snooze; the card hides until the time, and a new @mention brings it back at once
    @v1 @browser
    Scenario: Later hides a mention card until its time comes
      Given "docs" posted "@drew can you check the deploy log?" in conversation 42
      When the owner opens Now with the mention and reply cards turned on and taps "Later" on the card of conversation 42 and picks "1 hour"
      Then the card leaves "Mentions of you" and the heading "Needs you" is gone
      When the test clock moves 61 minutes on and the owner reloads Now
      Then the card of conversation 42 is back under Needs you

    # Issue 103
    @v1 @browser
    Scenario: A new @mention after Later brings the card back at once
      Given "docs" posted "@drew can you check the deploy log?" in conversation 42, and the owner picked "Later" for 1 hour on its card in Now with the mention and reply cards turned on
      When "docs" posts "@drew still there?" in conversation 42
      Then the card of conversation 42 is back under Needs you with the line "docs @drew still there?"

    # Owner, conv 179, msgs 5840/5841 (see above)
    @v1 @browser
    Scenario: Agent talk the owner is not in folds to one line per chat with one Mark all read
      Given "devtool" posted 2 messages in conversation 41 and "docs" posted 1 message in conversation 42, and the owner wrote nothing
      When the owner opens Now
      Then "Other chats" has 2 rows, one reading "devtool, 2 new" and one "docs, 1 new", with no message lines
      When the owner taps "Mark all read"
      Then both conversations have 0 unread and Now says "All clear. Nothing needs you."

    # Advisor, conv 331 msg 5950: a chat whose only new message is an ask must still be listed, so Mark all read can clear it
    @v1 @browser
    Scenario: A chat whose only new message is an ask is listed under Other chats
      Given "devtool" asked the owner a question in conversation 41, and nothing else is new there
      When the owner opens Now
      Then "Other chats" has one row for conversation 41 reading "devtool, 1 new"
      When the owner taps "Mark all read"
      Then the "Other chats" list is gone

    # Owner, conv 1, msg 535 (see above)
    @v1 @browser
    Scenario: Marking all read from Now clears the list and shows all clear
      Given no decision waits and "devtool" posted 2 messages in conversation 41 that the owner has not read
      When the owner opens Now and taps "Mark all read"
      Then the "Other chats" list is gone and Now says "All clear. Nothing needs you."

    # Owner, conv 1, msg 535 (see above): muted conversations are not listed
    @v1 @browser
    Scenario: A muted conversation is not listed under Unread
      Given no decision waits and "devtool" posted 2 messages in a muted conversation 41 that the owner has not read
      When the owner opens Now
      Then Now says "All clear. Nothing needs you." and has no "Other chats" list

    # Owner, conv 1, msg 535 (see above)
    @v1 @browser
    Scenario: Opening an unread row lands at the first unread message
      Given no decision waits and "devtool" posted "First news", "Second news" and "Third news" in conversation 41 that the owner has not read
      When the owner opens Now and taps the conversation 41 row under "Other chats"
      Then conversation 41 opens with the "New messages" line above "First news"

    # Conv 16, msg 321: "the \"Now\" should always reflect if there's something in the feed if anything is there"
    @v1 @browser
    Scenario: The Now item shows how many items wait in the feed and updates live
      Given 2 open asks, 1 snoozed ask and 1 answered ask
      When the owner opens Now
      Then the Now item in the rail and the Now tab on a phone show 2
      When the agent answers nothing and the owner answers one ask
      Then the Now item shows 1
      When the owner answers the last ask
      Then the Now item shows no count

    # Conv 17, msg 323: "after approving a new bot, I should have a quick way to message it right after"
    @v1 @browser
    Scenario: After approving a new agent the card offers a message to it
      Given an agent asked to connect as "dev-ci" from the machine "box-2"
      When the owner opens Now and taps Approve
      Then the card reads "@dev-ci joined" with a "Message @dev-ci" button
      When the owner taps "Message @dev-ci"
      Then a new conversation opens with @dev-ci tagged and the cursor in the composer

  Rule: Replies to you lists the chats where an agent answered the owner; a thread reply counts only in the chat's 30 newest threads

    # Owner, conv 179, msgs 5840/5841 (see above)
    @v1 @browser
    Scenario: A reply to the owner's message shows the full latest message under Replies to you
      Given the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered with a 300-character message
      When the owner opens Now with the mention and reply cards turned on
      Then "Replies to you" has one card for conversation 41 showing the whole answer
      And no "Needs you" heading is shown

  Rule: The owner answers from Now without losing their place

    @v1 @browser @I-15
    Scenario: Answering from Now does not mark the conversation read
      Given conversation 41 has 4 unread messages and an open ask "Merge #415 on its own?"
      When the owner presses "Okay" on the ask in Now
      Then the ask shows "Answered · Merge it"
      And conversation 41 still shows 4 unread in the rail

    @v1 @browser
    Scenario: The Dismissed fold lists dismissed asks and Reopen puts one back
      Given an open ask of "devtool" that the owner dismissed
      When the owner opens "Dismissed today" in Now
      Then it lists the ask as "Dismissed" with a "Reopen" button
      When the owner taps "Reopen"
      Then Now lists the ask as open again

    # Owner, feed ask 237: "I can't reopen the items in the feed. I should be able to. Also, I should always be able to quick reply/snooze/etc"
    @v1 @browser
    Scenario: Every item in the feed opens its conversation when tapped
      Given conversation 41 has a snoozed ask, an answered ask and a dismissed ask
      When the owner opens each fold in Now and taps the ask in it
      Then conversation 41 opens with that ask in view

    @v1 @browser
    Scenario: Reopen puts a dismissed ask back on a phone
      Given an open ask of "devtool" that the owner dismissed
      When the owner opens "Dismissed today" in Now and taps "Reopen"
      Then Now lists the ask as open again with "Okay", "Reply" and "Snooze"

    @v1 @browser
    Scenario Outline: An open ask always shows its quick bar
      Given an open ask of "devtool" <before>
      When the owner looks at the ask <where>
      Then the ask shows its quick bar with <buttons>

      Examples:
        | before                   | where                            | buttons                         |
        | in Now                   | in Now                           | Okay, Reply, Snooze             |
        | in conversation 41       | in conversation 41               | Okay, Reply, Snooze             |
        | in conversation 41       | with its reply box open          | Okay, Reply, Snooze             |
        | that was dismissed       | in Now after "Reopen"            | Okay, Reply, Snooze             |
        | that was snoozed         | in Now after "Unsnooze"          | Okay, Reply, Snooze             |
        | in Now                   | in Now after a reload            | Okay, Reply, Snooze             |
        | in conversation 41       | in conversation 41 after a reload| Okay, Reply, Snooze             |

    # Owner, feed ask 240: "It doesn't reopen, but I should be able to click and still reply in thread or jump to convo. I should be able to follow up"
    @v1 @browser
    Scenario: An answered ask in the feed lets the owner follow up in its thread or jump to its conversation
      Given an answered ask, a dismissed ask and a snoozed ask of "devtool"
      When the owner opens the folds in Now
      Then each row offers "Reply in thread" and "Jump to conversation"
      When the owner taps "Reply in thread" on the answered row
      Then the thread of the ask opens and its Reply box has focus
      When the owner taps "Jump to conversation" on the answered row
      Then conversation 41 opens with the ask in view and the ask is still answered

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: The thread of an ask in Now and a fold row show the replies
      Given an open ask of "devtool" in Now that "docs" replied to twice in its thread, and an answered ask with one reply
      When the owner opens Now
      Then the open ask, with its "Okay" and "Reply", shows "Show thread · 2 replies"
      When the owner opens the folds in Now
      Then "Reply in thread" on the answered row shows "1 reply"
      And an ask with no reply shows no "Show thread"

  # Owner said (msg 1117): "the feed items are sometimes like you know they don't really give me the context that I need. And while opening things in a new thread, like responding in a thread is relatively easy, it fails to consider that as a user flow, right? It's like, okay, I've opened it as a thing, and now it's like basically just delegates to a new thread, but then the item still stays there. It doesn't show that I've responded. The conversation kind of doesn't continue in the same way, right?"
  # Owner said (msg 1131): "update this ask so it has all of my QA answered ... that's the way to do it."
  # An ask waits under You replied only while the owner's reply is the last word in its thread: once the agent (or anyone else) posts
  # after it, the ask is back in the main list and its card no longer says "You replied · waiting on @agent". One reply counts for one ask.
  Rule: Asks where the owner's reply is the last word wait under You replied, and the thread opens inside the app

    @v1 @browser
    Scenario: Asks the owner replied to wait in their own section
      Given an open ask of "devtool" that the owner replied to with a long reply, and an open ask of "docs" that the owner did not reply to
      When the owner opens Now
      Then Now lists the ask of "docs" in the main list
      And under "You replied · waiting on the agent" it lists the ask of "devtool" with its question, "@devtool", the first 100 characters of the reply and its age
      And the ask of "devtool" is not in the main list and does not count in the badge
      When the owner taps the row
      Then the thread of the ask opens

    # Owner said (msg 1202, relayed in msg 1204): "wherever a message shows 'Reply in thread', add a small count of the replies, and of the new ones. Then you can tell at a glance that a thread exists and has something new."
    @v1 @browser
    Scenario: A You replied row shows the replies and the new ones, and the new clear when the thread is opened
      Given an open ask of "devtool" that the owner replied to, "devtool" replied in its thread, and the owner replied again
      When the owner opens Now
      Then the row under "You replied · waiting on the agent" shows "3 replies · 1 new"
      When the owner opens the thread from the row and goes back to Now
      Then the row shows "3 replies" with no "new"

    @v1 @browser
    Scenario: Reply on an ask in Now opens its thread in place, and the ask moves at once
      Given an open ask of "devtool" in Now
      When the owner taps "Reply" on the ask in Now
      Then the thread opens inside the ask with its reply box in focus, and the page was not loaded again
      When the owner sends "Which runner?" from that box
      Then the ask is under "You replied · waiting on the agent" at once, without waiting for a poll

    @v1 @browser
    Scenario: An unread conversation in Now has a Reply action that focuses the composer
      Given the owner wrote "Are the filters in?" and "devtool" answered "The filters are in" in conversation 41
      When the owner opens Now with the mention and reply cards turned on and taps "Reply" on its card under "Replies to you"
      Then conversation 41 opens inside the app and its composer has focus

  Rule: Snooze hides an ask until its time

    @v1 @browser @I-13
    Scenario: A snoozed ask returns at its time
      Given an open ask of "devtool"
      When the owner snoozes it for "1 hour"
      Then Now lists it under snoozed with its wake time
      And after the test clock moves 1 hour Now lists it as open again
      And the owner gets a "snooze_wake" notification

    @v1 @browser @I-13
    Scenario: Snooze shows an Undo toast and Undo puts the ask back
      Given an open ask of "devtool"
      When the owner snoozes it for "1 hour"
      Then a toast says "Snoozed until 1 hour" with the wake time and an Undo button for 10 seconds
      When the owner taps Undo
      Then Now lists the ask as open again

    @v1 @browser @I-13
    Scenario: Unsnooze returns an ask at once
      Given an ask snoozed until tomorrow 09:00
      When the owner unsnoozes it
      Then Now lists it as open

    # Per prototype v41 (P:3925): 1 hour; Tonight = 6:00 PM (18:00) local the same day; Tomorrow = 9:00 AM local.
    # DEFAULT (owner to confirm): the prototype offers Tonight at any hour; a real wake time cannot be in the past, so Tonight is not offered from 6:00 PM.
    @v1 @browser @I-13 @C-9 @AC-29
    Scenario Outline: Snooze presets set the right wake time
      Given the time is 2026-10-16 14:00 in the owner's time zone
      When the owner snoozes an ask with "<preset>"
      Then the wake time is <wake>

      Examples:
        | preset   | wake                |
        | 1 hour   | 2026-10-16 15:00    |
        | Tonight  | 2026-10-16 18:00    |
        | Tomorrow | 2026-10-17 09:00    |

    @v1 @browser
    Scenario: The count updates in every open tab
      Given Now is open in two tabs with 3 open asks
      When the owner presses "Okay" on an ask in one tab
      Then both tabs show 2 open asks with no reload

    @v1 @browser @I-13 @C-9 @AC-29
    Scenario: Tonight is not offered from 6:00 PM
      Given the time is 2026-10-16 19:30 in the owner's time zone
      When the owner opens the snooze menu of an open ask
      Then it offers "1 hour" and "Tomorrow" but not "Tonight"

  Rule: Agent adds wait for a human (pending adds)

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @browser @I-17
    Scenario: Approving a pending add lets the agent in from the request
      Given "devtool" requested to add "@docs" to conversation 52 at message 300
      When the owner approves the add
      Then conversation 52 shows "Approved · @docs added"
      And "docs" reads conversation 52 with the earlier messages and the ones after the request

    @v1 @browser @I-17
    Scenario: Declining a pending add keeps the agent out
      Given "devtool" requested to add "@docs" to conversation 52
      When the owner declines the add
      Then conversation 52 shows "Declined"
      And "docs" cannot read conversation 52

  Rule: Machine requests are approved from Now

    # Owner said: "Approvals just go into the feed, right?" One tap, no passkey, no sheet.
    @v1 @browser @I-36
    Scenario: Now shows an agent's connect request as one card with Approve and Decline
      Given an agent asked to connect as "dev-ci" from the machine "box-2" with the description "Runs CI"
      When the owner opens Now
      Then one card reads "box-2 wants to connect as @dev-ci" with "Runs CI" under "From the agent"
      And the card has Approve and Decline
      And Deny all removes it

    @v1 @browser @I-36
    Scenario: A machine request deep link brings its card into view
      Given a machine request "box-9" with request id 9 is pending
      When the owner opens "/now/machine/9"
      Then the card of "box-9" is in view with its code, the reported host info and the source, and Approve and Decline

    @v1 @browser @I-36
    Scenario: An expired machine request leaves Now
      Given a machine request "box-9" made 10 minutes ago
      When the test clock passes its expiry
      Then Now no longer shows it with no reload
