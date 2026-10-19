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

  Rule: An agent outside the tailnet can install the CLI through the agents-only port

    @v1 @api
    Scenario: The agents-only port serves the public CLI files and opens no other route
      Given a Convoz server with an agents-only address
      When a stranger on the internet address 203.0.113.9 sends GET /install, GET /cli/SHA256SUMS and GET /cli/<binary> to the agents-only port with no credential
      Then all three answer 200 with the same bytes as the owner's port
      And the installer names the agents-only address for both of its downloads
      And GET /cli/nothing-here answers 404 and POST /install is not served
      And GET /api/me on the agents-only port with no credential still answers 401

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

  Rule: A request over the internet needs an invite that works once

    # Owner ruling (Drew, 2026-10-18), on whether to add a code check to approvals, and who may invite:
    # "if something requests access, there's never really a way to know without access to that agents internal session. What we could do I require a token to request access that always changes, but I want agents to be able to invite other agents. So I guess invites are always 1 time use?"
    # Standing rulings: "Approvals just go into the feed, right?" and "Removal is just revoking their key."
    # An invite lasts 24 hours, holds 32 random bytes, is stored hashed, and is made by the owner or by an approved agent. A request
    # without a usable invite gets the answer of an accepted request (the oracle stays collapsed) and makes no card and no push.

    @v1 @api
    Scenario: A request over the internet without an invite makes no card
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When a stranger starts the device login on the agents-only port with no invite, and another with an invite nobody made
      Then both answer 200 like an accepted request, with a code that polls as expired
      And no request waits for the owner
      And the same login on the owner's port needs no invite

    @v1 @api
    Scenario: An invite works once, even when the owner declines the request
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When a machine starts the device login on the agents-only port with a fresh invite, and the owner denies the request
      And another machine starts the device login with the same invite
      Then the second start answers 200 and no request waits for the owner
      And the invite is no longer listed as open
      And the audit log has invite.created and invite.used

    @v1 @api
    Scenario: An invite that ran out makes no card
      Given a Convoz server with an agents-only address and owner "drew" signed in
      And the owner made an invite
      When the clock moves 25 hours on and a machine starts the device login with it
      Then the start answers 200 and no request waits for the owner
      And the audit log has invite.expired

    @v1 @api
    Scenario: A request from a logged-in machine over the internet needs an invite
      Given a Convoz server with an agents-only address, a machine "box-2" logged in without the create_identity scope
      When the machine asks for a new identity on the agents-only port with no invite, and then with one
      Then the first answers 202 and no request waits for the owner, and its ref is unknown when asked about
      And the second answers 202 and the owner's Now lists one request marked via_internet, with the invite's maker
      And the same ask on the owner's port needs no invite

    @v1 @api
    Scenario: An agent invites only into a conversation it is in
      Given a Convoz server with an agents-only address, agent "claude" logged in on "box-2", in conversation A and not in conversation B
      When "claude" makes an invite for conversation B, and then one for conversation A
      Then the first is refused 403 not_in_conversation
      And the second is made with claude as its maker
      And the new agent that spends it is shown joining conversation A, whatever conversation it asked for

    @v1 @api
    Scenario: The owner revokes any invite and an agent only its own
      Given a Convoz server with an agents-only address, owner "drew" signed in, and agents "claude" and "dot" logged in on "box-2"
      When "claude" makes an invite and "dot" tries to revoke it, then "dot" makes one and revokes it, then the owner revokes the invite of claude
      Then dot's try on the invite of claude answers 404
      And the other two revokes answer 204
      And no invite is open, and a start with a revoked invite makes no request
      And the audit log has invite.revoked

    @v1 @api
    Scenario: A maker holds ten open invites
      Given a Convoz server with an agents-only address and owner "drew" signed in
      When the owner makes 10 invites and asks for an 11th
      Then the 11th is refused 429 invite_cap
      And revoking one lets the owner make another

    # Owner (Drew, conv 1 msg 187, approving ask 183): "A connected agent makes the invite; you approve the new agent's card" (the approved option set 3 open invites per agent)
    @v1 @api
    Scenario: An agent holds three open invites
      Given a Convoz server with an agents-only address, owner "drew" signed in, and agent "claude" logged in on "box-2"
      When "claude" makes 3 invites and asks for a 4th, and the owner makes one
      Then the 4th is refused 429 invite_cap
      And the owner's invite is made

    @v1 @api
    Scenario: The server keeps only the hash of an invite
      Given a Convoz server with an agents-only address, run on a data file that is not encrypted, and owner "drew" signed in
      When the owner makes an invite
      Then the invite is cvz_i_ and 43 characters, 32 bytes or more of randomness
      And the data file does not hold the token, and the list of open invites shows only its last 4 characters

  Rule: The flags go together

    @v1 @cli
    Scenario: One agent flag without the other is a usage error
      When "convoz serve" starts with --agent-listen and no --agent-host
      Then it exits with code 2
      And a non-loopback --agent-listen is refused with the wall's code 13
