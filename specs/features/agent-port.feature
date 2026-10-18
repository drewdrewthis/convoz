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

  Rule: The invite prompt tells the agent an address it can reach

    @v1 @browser
    Scenario: The invite prompt shows the agents-only address
      Given a Convoz server with an agents-only address
      When the owner opens the invite sheet in Crew
      Then the prompt names the agents-only address as the server
      And the prompt does not name the tailnet address
