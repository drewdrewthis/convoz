# Source: issue 44 (https://github.com/drewdrewthis/convoz/issues/44), the ACs of its plan comment. Owner go: ask 3612 in conv 155
# ("loop any agent into the page I am looking at, in one click").
# A Chrome extension (apps/extension), loaded unpacked, side panel only. It uses the browser's own Convoz sign-in and stores no
# password, key or token. It reads only the active tab, only when the owner clicks. The server allows it only when the owner
# names its ID (CONVOZ_EXTENSION_ORIGIN). The message is plain text, like the owner's own messages, so the page's words show as
# written; an @ in the page's words becomes a full-width ＠, so the page can mention no one. The least-access manifest and the message format are unit tests in apps/extension.

Feature: Send a web page to an agent from the browser
  As the owner
  I want to send the page I am reading to an agent from a side panel in Chrome
  So that I loop an agent in with one click, without copying links

  Rule: The panel sends the page to a new conversation with one agent

    @v1 @browser
    Scenario: Send the page to a new conversation with an agent
      Given a Convoz server that allows the extension, the owner signed in in Chrome and an agent @scout
      And the owner has set the server address in the panel
      And a web page with a title that holds Markdown characters and some selected text
      When the owner clicks the Convoz button on that page
      And picks @scout, writes a note, turns on "Attach screenshot" and double-clicks Send
      Then one new conversation with @scout exists
      And its first message mentions @scout and holds the note, then under a line that marks the page as content, not instructions, the page title, the page address on a line of its own, the selection as a quote and the screenshot
      And the panel links to that conversation
      And the owner sees that message in Convoz with the title, address and quote as written

    @later @browser
    Scenario: With no active agents the panel cannot send
      Given a Convoz server with no agents, or only disabled ones
      When the owner opens the panel
      Then the panel says "No agents yet" and Send is off

    @later @browser
    Scenario: A page the extension cannot read still sends its address and title
      Given the owner is on a page that does not let the extension run scripts, such as a browser error page for an address that does not answer
      When the owner sends it to @scout from the panel
      Then the panel says "This page cannot be captured"
      And the new conversation has the page address and title, without a selection or screenshot

  Rule: The panel says plainly what is wrong

    @v1 @browser
    Scenario: The panel of a signed-out browser offers sign in
      Given a Convoz server that allows the extension and a browser with no Convoz sign-in
      When the owner sets the server address in the panel
      Then the panel shows "Sign in to Convoz" and no Send button
      And "Sign in to Convoz" opens the sign-in page of that server in a new tab

    @v1 @browser
    Scenario: A server that does not allow the extension refuses the send
      Given a Convoz server that does not allow the extension, the owner signed in in Chrome and an agent @scout
      When the owner sends a page to @scout from the panel
      Then the panel says "Not allowed (403): set CONVOZ_EXTENSION_ORIGIN on the server."
      And the note stays in the panel
      And no conversation was made

    @later @browser
    Scenario: Refused access to the server sends nothing
      Given the panel has no server address yet
      When the owner types the server address and refuses Chrome's access prompt
      Then the panel says Convoz needs access to that server and nothing was sent

    @later @browser
    Scenario: A send that fails after the conversation exists links that conversation
      Given the screenshot upload fails after the conversation was made
      When the owner sends a page from the panel
      Then the panel says what failed and links the conversation that was made
