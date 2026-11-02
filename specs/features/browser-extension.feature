# Source: issue 44 (https://github.com/drewdrewthis/convoz/issues/44), the ACs of its plan comment. Owner go: ask 3612 in conv 155
# ("loop any agent into the page I am looking at, in one click"). Version 2 (conv 310, the plan "Extension v2, page-aware agents"):
# the panel is the Convoz web app itself, and the owner shares a tab with a conversation (page-share.feature) instead of sending it.
# A Chrome extension (apps/extension), loaded unpacked, side panel only. It uses the browser's own Convoz sign-in and stores no
# password, key or token. The server allows it only when the owner names its ID (CONVOZ_EXTENSION_ORIGIN). The least-access
# manifest is a unit test in apps/extension.

Feature: Convoz in a Chrome side panel
  As the owner
  I want Convoz in a side panel of Chrome, signed in as I am in the browser
  So that I chat with my agents next to the page I am on

  Rule: The panel says plainly what is wrong

    @v1 @browser
    Scenario: The panel of a signed-out browser offers sign in
      Given a Convoz server that allows the extension and a browser with no Convoz sign-in
      When the owner sets the server address in the panel
      Then the panel shows "Sign in to Convoz" and no chat
      And "Sign in to Convoz" opens the sign-in page of that server in a new tab

    @later @browser
    Scenario: Refused access to the server shows no chat
      Given the panel has no server address yet
      When the owner types the server address and refuses Chrome's access prompt
      Then the panel says Convoz needs access to that server and shows no chat
