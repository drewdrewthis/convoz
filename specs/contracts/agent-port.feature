# Contracts for `features/agent-port.feature`: what the agents-only listener serves and refuses, the limits that guard it, and the
# addresses it prints. Source: docs/design.md "The agents-only address"; owner ruling (Drew, 2026-10-18): "Funnel an agents-only port".

Feature: Agents-only address (contracts)
  The second listener behind `tailscale funnel` serves an allow-list taken from the route table and refuses everything else.

  Rule: The listener refuses everything the route table does not give it

    @v1 @api
    Scenario: An owner route gives 404 on the agents-only port even with the owner's cookie
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When the owner's cookie is sent to owner routes, pages, push, settings, admin and test routes on the agents-only port
      Then every one of them answers 404
      And the same cookie still works on the owner's port
      And GET /api/me on the agents-only port with the cookie answers 401

    @v1 @api
    Scenario: A request for a host name that is not the agents-only name is refused
      Given a Convoz server with an agents-only address
      When GET /healthz arrives with the Host of the owner's name
      Then the server answers 421

  Rule: Login and approval work end to end through the agents-only port

    @v1 @api
    Scenario: Login, approval and a lease work through the agents-only port
      Given a Convoz server with an agents-only address and owner "drew" signed in
      And an agent identity "dot" exists
      When a machine starts the device login on the agents-only port from the internet address 203.0.113.9
      Then the owner's list of requests shows source 203.0.113.9 with via_internet true
      When the owner approves it on the owner's port
      And the machine polls the token on the agents-only port and mints a session
      Then GET /api/me with the lease on the agents-only port answers the identity "dot"
      And the server log names the client address 203.0.113.9 and no cookie or credential

    @v1 @api
    Scenario: The install script and the version name the agents-only address
      Given a Convoz server with an agents-only address
      When /install and /api/version are fetched on both ports
      Then the script from the agents-only port names the agents-only address and not the owner's
      And /api/version carries agent_url on both ports
      And a server with no agents-only address carries no agent_url

  Rule: The internet-facing door is rate limited per address

    @v1 @api
    Scenario: Login starts are limited per internet address
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When one address starts the device login 10 times, the owner denying each
      Then the 11th start answers 429 with a Retry-After
      And another address can still start

    @v1 @api
    Scenario: Failed credentials are limited per internet address
      Given a Convoz server with an agents-only address
      When one address sends 30 requests with a bad credential
      Then they answer 401
      And its next request answers 429
      And another address still answers 401

  Rule: The flags go together

    @v1 @cli
    Scenario: One agent flag without the other is a usage error
      When "convoz serve" starts with --agent-listen and no --agent-host
      Then it exits with code 2
      And a non-loopback --agent-listen is refused with the wall's code 13
