Feature: Agent chat
  As Drew
  I want a private place to talk with my agents, with Needs-you, rich messages and claimable questions
  So that agents ask me things in one inbox and I answer them from my phone

  # ops/agent-chat: Hono + SQLite server, `feed` CLI, Svelte web app. Issue #100.
  # @needs-drew scenarios need a phone or tailnet and are proved by hand (README runbook).

  Background:
    Given a server with owner "drew" and registered agents "rexxy" and "dot"

  # D-1
  Scenario: Agent message reaches Drew's open browser fast
    When rexxy runs "feed post --to dm:drew --text hi"
    Then the command prints an integer id
    And the message shows in Drew's open browser within 3 seconds with no reload

  @needs-drew
  Scenario: Message shows on Drew's phone over Tailscale
    When rexxy runs "feed post --to dm:drew --text hi"
    Then the message shows on Drew's phone within 3 seconds with no reload

  # D-2
  Scenario: Drew's reply is one line in the agent watch stream
    Given rexxy runs "feed watch --for rexxy"
    When Drew posts "yes" to dm:rexxy
    Then the stream prints "[feed] dm:rexxy #<id> drew: yes" exactly once within 3 seconds

  Scenario: A double submit yields one line
    Given rexxy runs "feed watch --for rexxy"
    When Drew posts "yes" to dm:rexxy twice with the same client id
    Then the stream shows one line for it

  Scenario: Newlines are escaped on the watch line
    When Drew posts a two-line message to dm:rexxy
    Then the watch line holds a literal backslash-n and stays on one line

  Scenario: The server cursor moves only on an explicit since
    Given two unseen messages for rexxy
    When rexxy polls events without since, twice
    Then both polls return both messages
    When rexxy polls events with since set to the last id
    Then later polls without since return only newer messages

  # D-3 -- rich-message rendering is being redesigned
  @pending-design
  Scenario: A button click is delivered as a reply with the stored action text
    Given rexxy posted a message declaring the action "approve" with text "Approved, go ahead"
    When Drew clicks "approve"
    Then a reply with text "Approved, go ahead" is posted and rexxy receives it

  Scenario: An undeclared action id is rejected
    When Drew's client sends an action id the message did not declare
    Then the server answers 400 and posts nothing

  Scenario: A double click posts one reply
    When Drew clicks "approve" twice
    Then one reply exists

  # D-4 and the Needs-you rule
  Scenario: An ask is answered by a threaded reply
    Given rexxy asked Drew a question
    When Drew replies with reply_to set to the ask
    Then Needs you no longer lists it

  Scenario: An unthreaded later message answers every earlier ask in that conversation
    Given rexxy asked two questions in dm:rexxy
    When Drew posts an unthreaded message in dm:rexxy
    Then Needs you is empty

  Scenario: A message in another conversation does not answer the ask
    Given rexxy asked Drew a question
    When Drew posts in dm:dot
    Then Needs you still lists it

  Scenario: Clicking a declared action answers the ask
    Given rexxy asked Drew a question with an action
    When Drew clicks the action
    Then Needs you no longer lists it

  Scenario: Done removes an ask
    Given rexxy asked Drew a question
    When Drew marks it Done
    Then Needs you no longer lists it

  Scenario: Snooze hides an ask until the time, then it returns
    Given rexxy asked Drew a question
    When Drew snoozes it for one hour
    Then Needs you hides it and lists it under snoozed
    When one hour passes
    Then Needs you lists it again

  Scenario: Unsnooze returns an ask at once
    Given a snoozed ask
    When Drew unsnoozes it
    Then Needs you lists it

  Scenario: The count updates in every open tab
    Given two browser tabs are open
    When Drew marks an ask Done in one tab
    Then both tabs show the new Needs-you count with no reload

  # D-5
  Scenario Outline: Every API route answers 401 without credentials
    When a client calls <route> with no token
    Then the server answers 401

    Examples:
      | route                              |
      | GET /api/me                        |
      | GET /api/agents                    |
      | POST /api/messages                 |
      | GET /api/conversations/dm:rexxy/messages |
      | GET /api/events                    |
      | GET /api/stream                    |
      | GET /api/needs                     |

  Scenario: The page itself answers 401 without a session
    When a client fetches "/"
    Then the server answers 401 with an HTML token form

  Scenario: Login sets a strict session cookie
    When Drew posts the owner token to /api/login
    Then the response sets an HttpOnly SameSite=Strict cookie that is not the token

  Scenario: A cookie request with a foreign Origin is rejected
    When a request with Drew's cookie carries Origin "https://evil.example"
    Then the server answers 403

  Scenario: A request with an unlisted Host is rejected
    When a request carries Host "evil.example:7788"
    Then the server answers 403 or 421

  @needs-drew
  Scenario: Off the tailnet there is no connection
    When a device off the tailnet requests the server address
    Then the connection fails

  # D-6 -- rich-message rendering is being redesigned
  @pending-design
  Scenario: A rich message cannot reach the network
    Given a rich message whose code calls fetch("https://example.com")
    When Drew opens it
    Then it renders
    And the browser network log shows no request to example.com

  Scenario: Rich body caps are enforced
    When rexxy posts code over 64 KB
    Then the server answers 400 naming "code"
    When rexxy posts data over 256 KB
    Then the server answers 400 naming "data"
    When rexxy posts more than 4 actions
    Then the server answers 400 naming "actions"

  # D-7
  Scenario: Two agents race to claim an open question
    Given channel "ops" with members rexxy and dot
    And Drew posted an open question in "ops"
    When both agents run "feed claim <id>" at once
    Then exactly one prints "claimed #<id>" and exits 0
    And the other prints "claimed by <winner>" and exits 1
    And one "claimed by <winner>" system message is appended

  Scenario: A non-open message cannot be claimed
    When rexxy claims an ordinary message
    Then the server answers 400

  Scenario: A non-member cannot claim
    When an agent outside the channel claims
    Then the server answers 403

  # D-8
  Scenario: An unknown or revoked token is rejected
    Given rexxy's token is revoked
    When rexxy posts a message
    Then the server answers 401

  Scenario: An agent cannot post under another name
    When rexxy posts with body author "drew"
    Then the stored author is "rexxy"

  Scenario: An agent cannot post into a conversation it is not in
    When rexxy posts to dm:dot
    Then the server answers 403

  Scenario: Only the owner adds agents, and the token is shown once
    When Drew runs "feed agent add newbie"
    Then a token is printed
    And later agent listings never contain it
