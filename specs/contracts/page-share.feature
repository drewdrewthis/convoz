# Source: the plan "Extension v2, page-aware agents" (conv 310), slice 1. Page sharing exists only when the owner names the
# extension (CONVOZ_EXTENSION_ORIGIN, the opt-in of issue 44); without it there is nothing to find. With it, the web app may be
# framed by that one extension and by nothing else. The relay itself (auth classes, membership, one share per conversation,
# heartbeat, timeout, caps, origin check) is unit-tested next to its handlers (page_share_test.go).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Page sharing is off unless the owner names the extension (contracts)
  As the owner
  I want page sharing and the framed web app to exist only when I named my extension
  So that no other page or extension can frame Convoz or reach a tab through it

  @v1 @api
  Scenario: Page routes and framing by the extension exist only with the extension origin
    Given a Convoz server started with --extension-origin chrome-extension://mbdignacpmfihffcpigobpekahlmeleb, the owner signed in and @scout in a conversation with a session lease
    When @scout sends POST /api/page/requests {conversation_id, op: "read"} while no tab is shared
    Then the server answers 409 with "no shared tab"
    And the web app page carries Content-Security-Policy frame-ancestors chrome-extension://mbdignacpmfihffcpigobpekahlmeleb and no other
    Given the same on a server started without --extension-origin
    When the owner sends POST /api/page/shares for that conversation from the extension's Origin
    And @scout sends GET /api/page/shares and POST /api/page/requests for that conversation
    Then the server answers 404 to all three
    And the web app page carries Content-Security-Policy frame-ancestors 'none'
