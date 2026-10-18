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

  Rule: The listener knows a client only by the Funnel proxy

    @v1 @api
    Scenario: A request that is not from the Funnel proxy is refused with 400
      Given a Convoz server with an agents-only address that knows a client only by the Funnel proxy
      When a request arrives with no Funnel marker, and another with a forged X-Forwarded-For and no marker
      Then both answer 400 and neither is served
      And a request with the marker and a client address is served
      And the log has no line that names 203.0.113.9 for the forged request

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

  Rule: Many look-alike cards cannot fill the owner's feed

    @v1 @api
    Scenario: Many addresses together cannot start more than 20 logins an hour
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When 20 different addresses each start the device login, the owner denying each
      Then a 21st address is refused with 429 and a Retry-After

    @v1 @api
    Scenario: A second pending request with the same machine name or handle is refused
      Given a Convoz server with an agents-only address, and one request "box-1" as @dot waiting
      When another address asks with the same machine name, and another with the same handle
      Then both answer 409 duplicate_pending
      And a request with a new name and handle is accepted

    @v1 @api
    Scenario: A taken handle or a missing conversation is not told to a stranger
      Given a Convoz server with an agents-only address, owner "drew" signed in, and an agent "dot" that exists
      When a stranger asks on the agents-only port with the taken handle, and another with a conversation that does not exist
      Then both are accepted like any other request
      And the same taken handle on the owner's port is refused 409 at once
      And the owner's approval of the card for the taken handle is refused 409 handle_taken

    @v1 @api
    Scenario: A request from a logged-in machine over the internet is marked on its card
      Given a Convoz server with an agents-only address, a machine "box-2" logged in without the create_identity scope
      When the machine asks for a new identity on the agents-only port, and for another on the owner's port
      Then the owner's Now lists the first request with via_internet true and the second with false

    @v1 @api
    Scenario: A session that ended is not counted as a wrong guess
      Given a Convoz server with an agents-only address and a lease that has ended
      When the ended lease is used 40 times from one address
      Then every answer is 401 and none is 429

  Rule: The code-match option makes the owner type part of the code

    @v1 @api
    Scenario: Approving an internet request needs the last 4 characters of the code when the server asks
      Given a Convoz server run with --agent-approve-code, and owner "drew" signed in
      When a request comes in on the agents-only port, and another on the owner's port
      Then only the internet request asks for the code
      And approving it with no code, or with a wrong one, is refused 403 code_mismatch
      And approving it with the last 4 characters of its code works, in lower case too
      And the tailnet request is approved with no code

  Rule: The flags go together

    @v1 @cli
    Scenario: One agent flag without the other is a usage error
      When "convoz serve" starts with --agent-listen and no --agent-host
      Then it exits with code 2
      And a non-loopback --agent-listen is refused with the wall's code 13
