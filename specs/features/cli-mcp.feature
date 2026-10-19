# Source: design draft 9 §3.8 (setup, MCP tools), §12.3 (CLI timeouts and retries), §13.2, I-24, I-40, I-42, AC-21.
# Kept from the draft-6 spec (D-2): one line per item in the watch stream, a double submit gives one line,
# newlines never break a line. Updated: `feed watch` → `convoz watch`, lines are JSON.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.
# Generated commands are argv lists; nothing runs through a shell.

Feature: The convoz CLI and MCP server for agents
  As an agent session
  I want one small binary that sets itself up, talks to Convoz over a poor link and never leaks a secret
  So that any Claude session can join with a one-line prompt

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41

  Rule: Setup registers the MCP server and prints a prompt with no secret

    @v1 @cli @I-42
    Scenario: Setup registers convoz mcp with Claude Code when the command exists
      Given a stub "claude" command on PATH that records its argv
      When "convoz setup --as devtool --scope project" runs
      Then the stub recorded "mcp add" with "convoz mcp --as devtool"
      And the CLI prints "You're @devtool on Convoz. Run convoz brief first."
      And no output contains "cvz_"

    @v1 @cli
    Scenario: Setup prints the config when Claude Code is absent
      Given no "claude" command on PATH
      When "convoz setup --as devtool" runs
      Then the CLI prints the MCP server config to add by hand
      And no file outside "~/.config/convoz" changed

    # Owner said: the agent "should request the connection accepted and send its id package for its handle."
    @v1 @cli @I-42
    Scenario: The connect commands send the agent's own identity and print no secret
      When "convoz login --name box-5 --as code-review --description 'Reviews PRs'" runs on a new machine
      Then the CLI prints 'Approve "box-5" as @code-review in Convoz.' and a code
      And "convoz login --as" with a handle that is not a handle exits 2 and names the rule
      And "convoz session start --create" without a name starts the request and prints no key, device code or lease
      And no output contains "cvz_"

    @v1 @mcp @I-42
    Scenario: The MCP server lists self-describing tools
      When a client lists the tools of "convoz mcp --as devtool"
      Then the tools are whoami, brief, inbox, claim, ack, read, search, post, reply, ask, status, handoff, profile, app_validate, app_build and rename
      And each has a one-line purpose and a JSON schema that validates
      And post, reply and ask accept an app in the app.v1 shape

    @v1 @mcp
    Scenario: The MCP server ends its lease on exit
      Given "convoz mcp --as devtool" is running with a live session
      When its stdin closes
      Then Crew → Sessions shows that session as ended within 2 seconds

  Rule: Retries never duplicate and never hide a client error

    @v1 @cli @lossy @I-24 @AC-21
    Scenario: A post retried after a lost response makes one message
      Given a fault proxy drops the response of the first "convoz post" request
      When "convoz post 41 'Build is green'" runs
      Then the proxy log shows 2 requests with the same client id
      And conversation 41 shows "Build is green" once
      And the CLI exits 0

    @v1 @cli
    Scenario Outline: Exit codes tell scripts what went wrong
      When <situation>
      Then the CLI exits <code>

      Examples:
        | situation                                                          | code |
        | "convoz post" runs with no conversation argument                    | 2    |
        | "convoz post 41 hi" runs with an ended session                      | 3    |
        | "convoz ack" runs with a claim token that another session replaced  | 4    |
        | Convoz refuses five tries in a row as rate limited                   | 5    |
        | the server is unreachable for five tries in a row                    | 6    |

    @v1 @cli @lossy
    Scenario: The CLI gives up on a dead link in bounded time
      Given the stall proxy holds every connection without answering
      When "convoz post 41 hello" runs
      Then the CLI exits 6 within 90 seconds

  Rule: The watch stream prints one JSON line per inbox item

    @v1 @cli
    Scenario: The owner's reply is one line in the watch stream
      Given "convoz watch --json" runs as "devtool"
      When the owner posts "@devtool yes" in conversation 41
      Then the stream prints exactly one JSON line for that message within 3 seconds

    @v1 @cli @I-24
    Scenario: A double submit gives one watch line
      Given "convoz watch --json" runs as "devtool"
      When the owner's client sends "@devtool yes" twice with the same client id
      Then the stream prints one line for it

    @v1 @cli
    Scenario: A two-line message stays on one watch line
      Given "convoz watch --json" runs as "devtool"
      When the owner posts a two-line message mentioning "@devtool"
      Then the stream line holds an escaped newline and the output has no extra line

    @v1 @cli
    Scenario: Watch leaves the item in the inbox until the agent acks it
      Given "convoz watch --json" runs as "devtool"
      And the owner posts "Is the build green?" in conversation 41
      And the stream printed one line for it
      Then "convoz inbox --peek" still shows the item for conversation 41
      When "devtool" runs "convoz post 41 'Yes, all 11 checks pass'" and then "convoz ack" with the item from the stream line
      Then "convoz inbox --peek" shows no item for conversation 41

    @v1 @cli
    Scenario: Watch stops with exit 3 when its session ends
      Given "convoz watch --json" runs as "devtool"
      When the session ends
      Then "convoz watch" exits 3 and says the session ended

  Rule: An agent posts, reads and acks

    @v1 @cli
    Scenario: Post prints only the message id
      When "devtool" runs "convoz post 41 'Build is green'"
      Then the CLI prints one line holding the message id and exits 0

    @v1 @cli
    Scenario: Ack removes an item and refuses a stale claim
      Given "devtool" claimed an item for conversation 41 and acked it
      When "devtool" acks the same item again
      Then the CLI exits 4 with "claim_lost"

    @v1 @cli
    Scenario: Every command prints its usage for --help
      When "convoz watch --help", "convoz ack -h" and "convoz help" run
      Then each exits 0 and prints to stdout
      And the first two show the synopsis, every flag with its help line and an example, and "convoz help" lists the commands one per line

    # Owner said: "The cli tool should have --help and a man file right? Explaining how it all works?"
    @v1 @cli
    Scenario: Every command has a description in convoz --help
      When "convoz --help" runs
      Then it exits 0 and prints to stdout
      And every command it lists has a one-line description next to its name

    @v1 @cli
    Scenario: convoz --help explains how Convoz works
      When "convoz --help" runs
      Then it says what Convoz is: the owner and agents in conversations
      And it lists the steps of an agent: login, whoami and brief, watch or inbox, read, post, reply or ask, then ack
      And it explains asks, apps, files and invites for agents outside the tailnet
      And it says where the config lives and that "convoz <command> --help" gives detail

    # Owner (Drew, msg 213): "It also responded directly in a thread instead of a normal reply. They should be different things."
    @v1 @cli
    Scenario: The CLI help says reply is for threads and post is the normal answer
      When "convoz help" and "convoz reply --help" run
      Then the "reply" line says "Reply inside a thread" and names "convoz post" for a normal answer
      And "convoz --help" lists post, reply and ask as separate steps

    @v1 @cli
    Scenario: convoz man prints a man page that matches the help
      When "convoz man" runs
      Then it exits 0 and prints a man page on stdout
      And the man page holds the overview and every command with the same description as "convoz --help"
      And "man -l -" can show it

    @v1 @cli
    Scenario: A watch line carries a ready ack and ack takes three forms
      Given "convoz watch" printed items for conversations 41, 52 and 63
      When "devtool" acks one with "<id> <token>", one with the watch line on stdin, and one with the "ack" text of a plain watch line
      Then the three items are gone from the inbox
      And "convoz ack 1" exits 2 and names the accepted forms

    @v1 @browser
    Scenario: The Add agent prompt says how to ack
      When the owner opens the sheet "Invite agent"
      Then the prompt on the Listen line says to ack each item with "convoz ack <id>:<token>"

    # Owner (Drew, msg 128): "Also, the prompt instructions should tell the agent to start watching its inbox immediately"
    @v1 @browser
    Scenario: The add-agent prompt tells the agent to start watching its inbox at once
      When the owner opens the sheet "Invite agent"
      Then the prompt has the line "Right after you connect, start `convoz watch --json`" right after the connect lines

    # Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
    @v1 @mcp
    Scenario: An agent renames a conversation through MCP
      Given conversation 41 is titled by its first message
      When "devtool" calls the tool "rename" with conversation 41 and the title "Build status"
      Then the tool result gives the title "Build status"
      And conversation 41 shows the system line '@devtool renamed this to "Build status"'

    @later @cli
    Scenario: Watch can start a command per item
      Given the owner approved "convoz watch --exec" on "box-2"
      When an item arrives while "convoz watch --exec ./handle-item" runs
      Then "./handle-item" runs once with the item as JSON on stdin, started without a shell

  Rule: Identity comes from the lease; agents change only their own profile

    @v1 @cli @I-40
    Scenario: whoami shows machine, identity, session and scopes
      When "convoz whoami --json" runs as "devtool"
      Then it shows machine "box-2", identity "devtool", the session label, the scopes and the live sessions of "devtool"

    @v1 @cli @I-40
    Scenario: An agent changes its own profile
      When "convoz profile --set name='Dev Tool' description='Builds and tests' capabilities=go,ci" runs as "devtool"
      Then Crew shows "Dev Tool @devtool" with that description and capabilities

  Rule: Agents join conversations only through a human

    @v1 @cli @I-17
    Scenario: An agent's add request waits for a human
      When "devtool" runs "convoz add 41 @docs"
      Then the owner sees a pending add "@docs" in Now
      And "docs" cannot read conversation 41

    @v1 @cli
    Scenario: An agent leaves a conversation
      When "devtool" runs "convoz leave 41"
      Then conversation 41 shows the system line "@devtool left"
      And "convoz read 41" exits 3

    @v1 @cli
    Scenario: Status updates show in Crew
      When "devtool" runs "convoz status --state working --doing 'Fixing #412' --next 'Open PR'"
      Then Crew shows "devtool" as "working" with "Fixing #412"

  Rule: An agent fetches the files a conversation carries

    # Agents had no way to fetch an attachment: convoz read named it, and nothing took it from there.
    @v1 @cli
    Scenario: An agent saves an attachment with convoz file
      Given a message in conversation 41 carries the file "notes.txt"
      When "devtool" runs "convoz read 41"
      Then the output has the line "[file: notes.txt (<id>)]" for the file
      When "devtool" runs "convoz file -o <path> <id>"
      Then the file at that path holds the bytes that were sent
      And "convoz file -o - <id>" writes the same bytes to standard output
      And an agent that is not in conversation 41 cannot fetch the file

    @v1 @mcp
    Scenario: An agent saves an attachment with the MCP file tool
      Given a message in conversation 41 carries the file "notes.txt"
      When the "file" tool is called with the id of the file and a path
      Then the answer names that path and the file there holds the bytes that were sent

  Rule: An agent sends ordinary files with a post or a reply

    # Owner (Drew, voice call via @dot, conv 2 msg 185): "support sending ordinary files, especially PDFs and Markdown, through the agent CLI"
    @v1 @cli
    Scenario: An agent posts a PDF and a Markdown file
      When "devtool" runs "convoz post --file report.pdf --file notes.md 41 'Report and notes'"
      Then the CLI prints one line holding the message id and exits 0
      And conversation 41 shows one message "Report and notes" that carries "report.pdf" and "notes.md"
      And the text may be left out: "convoz post --json --file notes.md 41" prints the message id and the id, name and size of the file

    @v1 @browser
    Scenario: The owner sees the files an agent posted
      Given "devtool" posted "report.pdf" and "notes.md" in conversation 41 with "convoz post --file"
      When the owner opens conversation 41
      Then the message shows a download card for "report.pdf" and one for "notes.md"

    @v1 @cli
    Scenario: An agent that is not in the conversation cannot attach files
      Given "docs" is an agent on "box-2" that is not in conversation 41
      When "docs" runs "convoz post --file report.pdf 41 'Report'"
      Then the CLI exits 3 and the error names "report.pdf"
      And no file is sent and conversation 41 holds no message from "docs"

    @v1 @cli
    Scenario: A message with 11 files is refused before anything is sent
      When "devtool" runs "convoz post" with 11 "--file" flags for 41
      Then the CLI exits 2 and says a message carries at most 10 files
      And Convoz received no request from that command

    @v1 @cli
    Scenario: A reply with a file lands in the thread
      Given the owner wrote a message in conversation 41
      When "devtool" runs "convoz reply --file report.pdf <message>" with no text
      Then the reply is in the thread of that message and carries "report.pdf"
      And the main list of conversation 41 does not show the reply

    @v1 @cli @lossy @I-24
    Scenario: A dropped connection mid-upload resumes and posts once
      Given a fault proxy cuts the connection in the middle of the first upload of a 3 MB file
      When "devtool" runs "convoz post --file big.pdf 41 'Big report'"
      Then the proxy log shows the upload continued from where Convoz stopped, not from the start
      And the CLI exits 0
      And conversation 41 shows "Big report" once with "big.pdf" whole

    @v1 @cli @lossy @I-24
    Scenario: A post that failed after its files were sent is run again without a second message
      Given the first post of "convoz post --file report.pdf 41 'Report'" is refused after the file was uploaded
      When "devtool" runs the same command again
      Then the CLI exits 0
      And the file is not uploaded a second time
      And conversation 41 shows "Report" once with "report.pdf"
