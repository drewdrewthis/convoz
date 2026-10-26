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
    Scenario: The ask tool refuses an ask without a reason it is the owner's call
      When the "ask" tool is called with a question, a recommendation and an alternative but no owners_call
      Then the tool fails and tells the agent to decide this itself
      And the owner sees no ask in Now

    @v1 @mcp
    Scenario: The ask tool takes a draft to review and needs no owner's call
      When the "ask" tool is called with a question and a draft with the text of a reply, the message it answers and who sent it
      Then the owner sees a draft ask in Now with the call "Your call · in-your-name: It goes out in your name."
      And when the owner sends an edited text, the agent reads send true with that text, and with Don't send it reads send false and no text

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

    # Owner (Drew, conv 19 msg 544): "is it really clear via the watch which conversation/thread/context I've messaged you from?"
    # Owner (msg 561): "do you have to get the whole thread each time? the first / last is probably enough --"
    @v1 @cli
    Scenario: A watch line says which thread a message is in and what it answers
      Given "convoz watch --json" runs as "devtool"
      And the owner started a thread under "Can step 1 ship on its own?"
      When the owner replies in that thread with "@devtool Which tests cover step 1?"
      Then the line has "thread_topic" "Can step 1 ship on its own?" and "before" from "drew" saying the same
      When the agent acks it and the owner replies with a short "@devtool yes"
      Then the line has the same "thread_topic" and "before" from "drew" saying "@devtool Which tests cover step 1?"

    # Prod, 2026-10-19: owner messages reached @claude-convoz 7 to 13 minutes late, only when its watch restarted. Another
    # loop of the same session (a watch left running, a poll whose answer was lost) had claimed them, and every later poll
    # of the live watch left the session's claims out.
    @v1 @cli @lossy
    Scenario: A watch gets every item, even when two arrive together or a poll is cut
      Given "convoz watch --json" runs as "devtool"
      And its link loses the answer of one poll without an error
      And another watch of the same session runs, and nobody reads what it prints
      And the stream printed one line for the owner's first message
      When the owner's second message comes in the poll whose answer is lost
      And the owner posts in conversations 41 and 42 at the same moment
      Then the stream prints one line for each of the owner's messages within 3 seconds

    @v1 @cli
    Scenario: Watch finishes the item without an ack, and an ack still works
      Given "convoz watch --json" runs as "devtool"
      And the owner posts "Is the build green?" in conversation 41
      And the stream printed one line for it
      Then "convoz inbox --peek" shows no item for conversation 41 (owner msg 821: no ack needed)
      When "devtool" runs "convoz post 41 'Yes, all 11 checks pass'" and then "convoz ack" with the item from the stream line
      Then "convoz inbox --peek" shows no item for conversation 41

    @v1 @cli
    Scenario: Watch stops with exit 3 when its session ends
      Given "convoz watch --json" runs as "devtool"
      When the session ends
      Then "convoz watch" exits 3 and says the session ended

    # From @langwatch-technician (conv 19 msg 378): "Claude Code tells me about a background command only when it exits. `convoz watch` never exits, so nothing reached me... the invite and brief say 'keep `convoz watch` running in the background'. For a Claude Code agent that advice is a trap... 1. Add `convoz watch --once` (exit after the first item)"
    # Superseded as advice (conv 19 msg 580, @langwatch-technician): "both reasons for `--once` are now gone... every agent here can use the same way: keep `convoz watch --json` running and read each line as it comes. I suggest you teach only that, and drop `--once`." Owner decision, msg 583: no doc, skill, brief or invite prompt teaches `--once`. It stays a CLI behaviour for scripts, which these two scenarios pin.
    @v1 @cli
    Scenario: convoz watch --once prints the waiting item and exits
      Given the owner posted "Is the build green?" in conversation 41 for "devtool"
      When "devtool" runs "convoz watch --json --once"
      Then it prints one JSON line for that message and exits 0
      And "convoz inbox --peek" still shows the item until the agent acks it

    @v1 @cli
    Scenario: convoz watch --once waits for the next item, then exits
      Given "devtool" runs "convoz watch --json --once" and nothing is waiting
      When the owner posts "@devtool yes" in conversation 41
      Then the command prints one JSON line for that message within 3 seconds and exits 0
      When the agent acks the item
      Then "convoz watch --json --once --timeout 2s" with nothing waiting prints nothing and exits 3

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
      Then the prompt has the line "Keep `convoz watch --json` running in the background and read each line as it arrives" right after the connect lines

    # Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
    @v1 @mcp
    Scenario: An agent renames a conversation through MCP
      Given conversation 41 is titled by its first message
      When "devtool" calls the tool "rename" with conversation 41 and the title "Build status"
      Then the tool result gives the title "Build status"
      And conversation 41 shows the system line '@devtool renamed this to "Build status"'

    # Owner goal, conv 308 msg 5755: an agent edits its own sent message from the CLI.
    @v1 @cli
    Scenario: An agent edits its own message with convoz edit
      Given "devtool" posted "Build is gren" in conversation 41 with "docs"
      When "devtool" runs "convoz edit <id> -" with "Build is green, @docs please check" on standard input
      Then the CLI exits 0
      And the owner reads "Build is green, @docs please check" with an edited time
      And "docs" gets no inbox item and the owner's unread count does not change

    @v1 @cli
    Scenario: An agent cannot edit another's message with convoz edit
      Given the owner posted "Ship it" in conversation 41
      When "devtool" runs "convoz edit <id> 'Hold it'"
      Then the CLI exits 3 and says only the author may do that
      And the message still reads "Ship it"

    @later @cli
    Scenario: Watch can start a command per item
      Given the owner approved "convoz watch --exec" on "box-2"
      When an item arrives while "convoz watch --exec ./handle-item" runs
      Then "./handle-item" runs once with the item as JSON on stdin, started without a shell

  # Owner said (msg 366): "Maybe the message schema should require a true/false field that says if it requires an action/decision from the user -- this will differentiate regular messages from actual blocking requests. We can probably do a lot of powerful stuff with the schema and validation"
  Rule: A post says whether it needs the owner; a message that does is an ask

    @v1 @cli
    Scenario: A post with --fyi says it does not need the owner
      When "devtool" runs "convoz post --fyi 41 'Build is green'"
      Then the CLI prints one line holding the message id and exits 0
      And the CLI prints nothing else

    @v1 @cli
    Scenario: A post without --fyi still goes out with a hint
      When "devtool" runs "convoz post 41 'Build is green'"
      Then the CLI prints one line holding the message id and exits 0
      And the CLI also says to add --fyi when the message does not need the owner, and to use "convoz ask" when it does

    @v1 @cli
    Scenario: A post that says it needs the owner is refused and points to convoz ask
      When "devtool" runs "convoz post --needs-you 41 'Ship it?'"
      Then the CLI exits 2 and points to "convoz ask"
      And conversation 41 shows no message from "devtool"

    @v1 @cli
    Scenario: A reply and a new conversation take --fyi the same way
      Given the owner posted "Status?" in conversation 41
      When "devtool" runs "convoz reply --fyi" on that message with "Green" and "convoz new --fyi" with a title and a first message
      Then both exit 0 and print one line holding an id
      And "convoz reply --needs-you" and "convoz new --needs-you" exit 2 and point to "convoz ask"

    @v1 @mcp
    Scenario: The MCP post, reply and new tools need the needs_you field
      When a client lists the tools of "convoz mcp --as devtool"
      Then "post", "reply" and "new" each list "needs_you" as a required yes or no field
      And a "post" call with needs_you false posts the message
      And a "post" call with needs_you true is refused with the "convoz ask" pointer

    @v1 @cli
    Scenario: The rules, the skill and the help tell an agent to use --fyi for news and ask for a decision
      When "devtool" runs "convoz rules", "convoz help" and "convoz post --help"
      Then each exits 0 and names "--fyi"
      And the rules and the help name "convoz ask" for a message that needs the owner

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

  Rule: The skill teaches an agent the Convoz rules
    # Owner (msg 257): "I think we also need to have a think about how to teach agents about convoz. Maybe the cli isn't enough? Maybe we should ship a skill? mcp?"

    @v1 @cli
    Scenario: convoz skill install writes a skill that teaches the Convoz rules
      When "devtool" runs "convoz skill install --dir <folder>"
      Then the CLI exits 0 and prints the path of SKILL.md, and adds no hooks unless --hooks is given
      # Owner said (msg 791): "we also almost certainly want to be able to keep skills up to date"
      And SKILL.md has the name "convoz" and points to "convoz rules"
      And running it again prints "updated"

    # Owner said (msgs 557, 791): the skill went stale. It is now a stable pointer; the rules live on the server and `convoz rules` prints them.
    @v1 @cli
    Scenario: convoz rules prints the server's rules
      When "devtool" runs "convoz rules"
      Then the CLI exits 0 and prints the rules text of the server
      And the installed skill is a short pointer that tells the agent to run "convoz rules" first
      And the two skill files have the same body

    @v1 @cli @mcp
    Scenario: The brief and the MCP instructions carry the same rules
      When "devtool" runs "convoz brief" and a client starts "convoz mcp --as devtool"
      Then the brief carries the rules text of the server
      And the MCP instructions carry the same rules text

    @v1 @cli
    Scenario: An agent watching gets a voice note's transcript as text
      Given "convoz watch --json" runs as "devtool"
      And the transcription engine answers "ship the filters on Thursday"
      When the owner sends a voice note in conversation 41
      Then the stream line has the text "Voice note 0:03: ship the filters on Thursday"

    # Owner, conv 12 msg 281: "something happens on the agent's actually running thing on their server -- something grabs it and it presents a decision, or it needs an approval, or it gets logged out, or runs out of credits."
    @v1 @cli
    Scenario: A stuck agent says why through its Claude Code hook
      When Claude Code calls the Notification hook for "devtool" with "Claude needs your permission to use Bash"
      Then the hook exits 0 and Crew shows "devtool" as blocked with "Needs approval on its host: Claude needs your permission to use Bash"
