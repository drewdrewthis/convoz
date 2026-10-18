# Source: design draft 9 §3.3 (login flow), §3.5, I-33, I-36, I-42, AC-8, AC-15.
# Draft 9 folds in the devil's-advocate review of draft 8: M6 (the key can be fetched again
# with the same device code until it expires; it is marked delivered on first use).
# DA cut: there is no "replace the key" inside the device flow; a lost key is Reveal or Regenerate.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.
# Owner said: "Approvals just go into the feed, right? Removal is just revoking their key". So a connect request is one card in
# Now with Approve and Decline: no passkey step-up, no typed code, no approve sheet. The owner's signed-in session is the authority.
# Owner said: "For adding an agent, I should actually just get a prompt right? Because the agent needs the cli and a token, but then
# it should request the connection accepted and send its id package for its handle. We don't need a name, I don't think."
# All tokens are fake and contain TESTONLY. "The test clock" is the test build's clock control.

Feature: Machine login with a device flow
  As the owner
  I want each machine that runs agents to log in once with a code I approve with a passkey
  So that one machine key serves every agent on that machine and no secret passes through a prompt

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And agent identities "devtool", "docs" and "release-bot" exist

  Rule: A machine asks for access with a short code, and the owner approves it

    @v1 @cli @browser @I-36 @AC-8
    Scenario: Login prints a code and Now shows the same code
      When "convoz login --name box-2" runs on the machine
      Then the CLI prints 'Approve "box-2" in Convoz. Code: KQWD-MZTP'
      And the owner sees a Now card "box-2 wants to connect" with the code "KQWD-MZTP"
      And the card labels the host info "reported by the machine"
      And the card shows the address and the tailnet name of the machine that asked, or "unknown" when Tailscale cannot name it

    @v1 @api @I-36 @AC-8
    Scenario: A poll faster than the interval is told to slow down
      Given "convoz login --name box-2" is waiting for approval
      When the machine polls the token route twice within 2 seconds
      Then the second answer is "slow_down"
      And a poll 5 seconds later is again "slow_down" because the interval grew to 10 seconds

    @v1 @browser @I-36
    Scenario: Approval creates the machine with the default scopes
      Given a pending machine request "box-2"
      When the owner taps Approve on its card in Now
      Then no passkey prompt and no sheet opens
      And Crew → Machines lists "box-2" with a key hint that starts with "cvz_m_"
      And its scopes are read, post, ask, status and upload, without create_identity
      And it allows no agent yet
      And the owner's audit view lists "machine approved · box-2"

    @v1 @browser @I-36
    Scenario: Each pending request has its own card and needs no typed code
      Given pending machine requests "box-2" with code "KQWD-MZTP" and "box-9" with code "PLRT-HXCV"
      When the owner taps Approve on the card of "box-2"
      Then "box-2" is connected at once, without a code typed
      And the card of "box-9" still waits with its code "PLRT-HXCV"

    @v1 @cli @I-36 @AC-8
    Scenario: A denied request creates no machine
      Given "convoz login --name box-2" is waiting for approval
      When the owner denies the request
      Then the CLI exits 3 with a message that the owner denied the request
      And Crew → Machines does not list "box-2"

    @v1 @cli @I-36 @AC-8
    Scenario: An unapproved request expires after 10 minutes
      Given "convoz login --name box-2" is waiting for approval
      When the test clock moves forward 10 minutes and 1 second
      Then the CLI exits 3 with a message that the code expired
      And Now no longer shows the request

    @v1 @api @I-36 @M6
    Scenario Outline: Bad device codes all get the same error
      Given a device code that is <case>
      When the machine polls the token route with it
      Then the answer is "expired_token" with the same body as every other bad code

      Examples:
        | case                                    |
        | unknown to the server                   |
        | denied by the owner and then retried    |
        | past its 10-minute expiry               |
        | for a key that a request already used   |

  Rule: The key reaches the CLI safely and can be fetched again until it is used (M6)

    @v1 @cli @api @I-36 @M6 @C-8 @AC-8 @AC-27
    Scenario: A lost token response is recovered with the same device code
      Given the owner approved the machine request "box-2"
      And a fault proxy drops the response of the first successful token poll
      When the CLI polls again with the same device code
      Then the CLI receives a key and "convoz whoami" names the machine "box-2"
      And the proxy log shows two token polls with the same device code

    @v1 @cli @I-42 @AC-8
    Scenario: The key is stored in a private file and never printed
      When "convoz login --name box-2 --store file" completes
      Then "~/.config/convoz/credentials" has mode 0600 in a directory with mode 0700
      And stdout and stderr of the CLI contain no "cvz_m_" and no "cvz_c_" string

    @v1 @cli @I-42 @AC-8
    Scenario Outline: The CLI refuses a credentials file with loose permissions
      Given the credentials file has mode <file mode> in a directory with mode <dir mode>
      When "convoz whoami" runs
      Then the CLI exits 3
      And the message names the path and the mode it needs

      Examples:
        | file mode | dir mode |
        | 0644      | 0700     |
        | 0640      | 0700     |
        | 0600      | 0755     |

    @v1 @cli
    Scenario: Headless Linux falls back to the file store
      Given the machine has no OS keychain service
      When "convoz login --name box-2 --store auto" completes
      Then the key is in the credentials file with mode 0600
      And "convoz whoami" works

  Rule: An agent that logs in brings its own identity, and one card connects both

    @v1 @cli @browser @I-3 @I-36
    Scenario: A login as an agent shows one card and one tap connects the machine and the agent
      When "convoz login --name box-2 --as code-review --description 'Reviews pull requests'" runs on the machine
      Then the CLI prints 'Approve "box-2" as @code-review in Convoz.' with the code
      And the owner sees one Now card "box-2 wants to connect as @code-review"
      And the card shows "Reviews pull requests" labelled "From the agent"
      When the owner taps Approve on that card
      Then the CLI logs in as machine "box-2"
      And Crew lists "code-review" marked "created by box-2"
      And "convoz session start --as code-review" works on "box-2"
      And "box-2" has no create_identity scope and allows only "code-review"

    @v1 @cli @browser @I-36
    Scenario: Declining a login as an agent makes neither the machine nor the agent
      When "convoz login --name box-2 --as code-review" runs on the machine
      And the owner taps Decline on the card "box-2 wants to connect as @code-review"
      Then the CLI exits 3 with a message that the owner denied the request
      And Crew → Machines does not list "box-2"
      And Crew does not list "code-review"

    @v1 @cli @I-3
    Scenario: A login as a handle that exists is refused
      When "convoz login --name box-2 --as devtool" runs on the machine
      Then the CLI exits 4 and says the handle is taken
      And no card appears in Now

    # Owner (Drew, msg 143): "History should be accessible yes"
    @v1 @cli
    Scenario: An agent login may name a conversation, and the card shows its title
      Given conversation 41 "Ship search filters" has the owner in it
      When "convoz login --name box-2 --as code-review --conversation 41" runs on the machine
      Then the owner sees on the card that "code-review" joins "Ship search filters"
      When the owner taps Approve on that card
      Then "code-review" is an active participant of conversation 41 and sees the whole history

  Rule: Device-flow limits stop floods and name clashes

    @v1 @browser @I-33
    Scenario: Machine names are unique while active
      Given an active machine "box-2"
      When the owner tries to approve a new request named "box-2" as a new machine
      Then the sheet says the name is taken
      And it says to use Reveal or Regenerate on "box-2", or to revoke it first

    @v1 @browser @cli @I-36
    Scenario: The owner denies every pending request at once
      Given 3 machine requests are pending and the owner knows none of them
      When the owner taps "Deny all" in Now
      Then Now shows no machine request
      And each waiting "convoz login" exits 3 with a message that the owner denied the request

  Rule: A lost credential costs nothing but a reveal or a new login (AC-15)

    @v1 @cli @browser @I-38 @AC-15 @M7
    Scenario: Reveal and login with stdin restore the same agent state
      Given "devtool" on "box-2" has unread items, an unacked answer, an open ask, a handoff note and read positions
      And the output of "convoz brief --as devtool" is saved
      When the credentials file on "box-2" is deleted
      And the owner reveals the key of "box-2" with a passkey
      And the revealed key is piped into "convoz login --stdin"
      Then "convoz brief --as devtool" shows the same sections as the saved brief

    @v1 @cli @browser @I-38 @AC-15
    Scenario: Regenerating a lost key keeps the agent state
      Given machine "box-2" lost its credentials file
      When the owner regenerates the key of "box-2" with a passkey
      And the new key is piped into "convoz login --stdin" on "box-2"
      Then "convoz brief --as devtool" shows the same sections as before the loss
      And Crew → Machines shows the same allow-list for "box-2"
      And a command that still uses the old key exits 3

    @v1 @browser @phone @needs-owner @AC-8 @unimplemented
    Scenario: The owner approves a real machine from the phone
      Given the owner's phone has the installed Convoz app with push on
      When "convoz login --name box-2" runs on a real tailnet machine
      Then the phone shows the push "box-2 wants to connect" with the body "code KQWD-MZTP"
      And the owner approves from the Now card with the phone's passkey
      And "convoz whoami" on the machine names the machine "box-2"
