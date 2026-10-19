# Source: docs/design.md "The agents-only address". Owner ruling (Drew, 2026-10-18), on the ask "Let agents outside your tailnet
# (like dot) connect?": he chose "Funnel an agents-only port": "Tailscale Funnel on a separate port that serves only device login and
# the agent API, with the web app and owner routes refused. You still approve each agent with one tap."
# Every scenario runs end to end against a real `convoz serve --agent-listen ... --agent-host ...` on a fresh `mktemp -d` data dir.
# The test build uses "localhost" for both names, because the funnel name cannot be dialled.

Feature: Agents outside the tailnet connect through an agents-only address
  As the owner
  I want an agent that is not on my tailnet to connect through one public address that serves nothing else
  So that I approve it with one tap and my own app stays on the tailnet

  Rule: An agent outside the tailnet logs in on the agents-only address

    @v1 @cli @browser
    Scenario: An agent outside the tailnet connects with one tap
      Given a Convoz server with an agents-only address
      When "convoz login --name dot-box --as dot" runs against the agents-only address
      Then the CLI prints 'Approve "dot-box" as @dot in Convoz.' with the code
      And the owner sees one Now card "dot-box wants to connect as @dot"
      And the card says the request came "via internet"
      When the owner taps Approve on that card
      Then the CLI logs in as machine "dot-box"
      And "convoz session start --as dot" works on "dot-box" against the same address

  Rule: The invite prompt tells the agent both addresses it can reach

    # Owner ruling (Drew, conv 1 msg 245): "I thought the ideas was that there were two entry points. One for people already on the Tail net, and one for the open Internet."
    # The agents-only port refuses a caller on the tailnet by design, so a prompt with only that address fails for an agent on the tailnet.

    @v1 @browser
    Scenario: The invite prompt shows the agents-only address
      Given a Convoz server with an agents-only address
      When the owner opens the invite sheet in Crew
      Then the prompt names the agents-only address for the open internet

    @v1 @browser
    Scenario: The invite prompt gives the tailnet and the internet entry points
      Given a Convoz server with an agents-only address
      When the owner opens the invite sheet in Crew
      Then the prompt names the tailnet address first and the agents-only address second
      And the install and "convoz login" commands each have a code block for each address, and "convoz session start" has one

    @v1 @cli @browser
    Scenario: One invite works through the main address
      Given a Convoz server with an agents-only address, an invite, and a machine "box-2" logged in without the create_identity scope
      When a new machine runs "convoz login --invite" against the main address
      Then the owner approves one card and the CLI logs in
      And a session start with that invite on the main address files a request for the owner
      And a second use of the same invite is refused on either address
      And on the main address a used invite gets a clear error, and the CLI prints it and exits non-zero

  Rule: An agent outside the tailnet needs a one-use invite

    # Owner ruling (Drew, 2026-10-18), on whether to add a code check to approvals, and who may invite:
    # "if something requests access, there's never really a way to know without access to that agents internal session. What we could do I require a token to request access that always changes, but I want agents to be able to invite other agents. So I guess invites are always 1 time use?"
    # Standing rulings: "Approvals just go into the feed, right?" (one tap, no passkey; a declined request still uses the invite up) and
    # "Removal is just revoking their key." The code-match option (--agent-approve-code) was dropped for invites.

    @v1 @browser
    Scenario: The invite prompt carries the invite
      Given a Convoz server with an agents-only address
      When the owner opens the invite sheet in Crew
      Then the prompt carries an invite in its install line and in its "convoz login" and "convoz session start" lines
      And the invite is one the owner can see as open

    @v1 @browser
    Scenario: The owner revokes an invite
      Given a Convoz server with an agents-only address
      And the owner opened the invite sheet in Crew
      When the owner taps "Revoke invite"
      Then the sheet says the invite is revoked
      And an agent that asks with that invite makes no card in Now

    @v1 @cli @browser
    Scenario: An agent invites another agent and the card says who invited it
      Given a Convoz server with an agents-only address and the agent "claude" logged in on "box-2"
      When "claude" runs "convoz invite" and a new agent runs "convoz login --invite" with that invite against the agents-only address
      Then the owner sees one Now card "dot-box wants to connect as @dot"
      And the card says it was "invited by @claude"

    @v1 @cli @browser
    Scenario: The owner makes an invite with the CLI on the server's own machine
      Given a Convoz server with an agents-only address
      When the owner runs "convoz invite --note 'for dot'" on the server's machine and a new agent runs "convoz login --invite" with it
      Then the owner sees one Now card "dot-box wants to connect as @dot"
      And the card says it was "invited by you" and shows the note "for dot"
