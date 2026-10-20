# Source: Owner (Drew, conv 30 msg 1057): "What's the deal here, have we shipped this yet?" Answer: the `claude -p` wrapper works (4 answers in
# 4-13 s) but is a stopgap; `convoz run` is its core version.
# Promise to Drew (conv 30, reply 953): "1. Per-agent tool allow-list in its config (`--allow 'Bash(gh issue view:*)'`), with read-only as the
# default. 2. The server will hold the lock, not the box: while `convoz run` serves a handle, any other `convoz watch` for that handle is refused
# with "@docs is served by convoz run on <machine>". 3. Session size: ... a fresh session ... keeping a short summary line."
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.
# Generated commands are argv lists; nothing runs through a shell. The `claude` command of the last scenario is a stub on PATH.

Feature: One command serves an agent's inbox with a short-lived process per item
  As the person who runs an agent
  I want `convoz run` to start one small process for each inbox item and never leave the agent without a watcher
  So that an agent needs no terminal open all day and still answers within seconds

  Background:
    Given a fresh Convoz server with owner "drew"
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41

  Rule: Each item gets its own process, and an item is finished only after that process succeeded

    @v1 @cli
    Scenario: convoz run answers an item with a fresh process and acks it
      Given "convoz run --as devtool -- <script>" runs, where the script replies to the item it is given
      When the owner posts "@devtool is the build green?" in conversation 41
      Then conversation 41 shows one reply from "devtool" within 10 seconds
      And the script got the item on stdin and its conversation, message and item in its environment
      And the inbox of "devtool" is empty

    # Owner said (conv 30 msg 953 promise): the agent "restarts its watch itself"; a failed item must not be lost and must not be answered twice.
    @v1 @cli
    Scenario: A failing command is retried once, then the thread says it could not answer
      Given "convoz run --as devtool -- <script>" runs, where the script fails on every item
      When the owner posts "@devtool deploy it" in conversation 41
      Then conversation 41 shows "I couldn't answer this" from "devtool" once
      And the inbox of "devtool" is empty
      And when a script replies to an item and then fails, the thread shows that one reply and no second one

  Rule: The server lets one runner serve an agent

    @v1 @cli
    Scenario: A second watcher is refused while convoz run serves the agent
      Given "convoz run --as devtool -- <script>" runs on "box-2"
      When "convoz watch --as devtool" runs from another session
      Then it prints "@devtool is served by convoz run on box-2" and exits 3
      And "convoz inbox --peek" and "convoz post" for "devtool" still work
      And a watch that is already open when "convoz run" starts makes the run exit 3 with "@devtool already has a convoz watch open"
      And 30 seconds after the runner stopped, "convoz watch --as devtool" works again

    @v1 @cli
    Scenario: A second convoz run for the same agent on the same machine is refused
      Given "convoz run --as devtool -- <script>" runs on "box-2"
      When "convoz run --as devtool -- <script>" runs again on "box-2"
      Then it exits 1 with "already running (pid" and the first run keeps serving

  Rule: Claude mode gives the child a normal agent's tools

    @v1 @cli
    Scenario: Claude mode builds a claude command with a normal agent's tools and keeps one session
      Given a stub "claude" command on PATH that records its argv and replies to the item
      And "convoz run --as devtool --fresh-after 2" runs
      When the owner posts three questions to "devtool" one after another
      Then the stub was given a normal agent's tools, a spend limit and the "dontAsk" mode every time
      And the stub got no deny-list
      And the first call starts a session and the second resumes it
      And the third call starts a new session whose prompt holds the summary of the first, and the summary is kept as a handoff note

    # Owner said (msg 366): "Maybe the message schema should require a true/false field that says if it requires an action/decision from the user -- this will differentiate regular messages from actual blocking requests. We can probably do a lot of powerful stuff with the schema and validation"
    @v1 @cli
    Scenario: Claude mode tells the child to post with --fyi
      Given a stub "claude" command on PATH that records its argv and replies to the item
      And "convoz run --as devtool" runs
      When the owner posts a question to "devtool"
      Then the prompt the stub was given tells it to answer with "convoz reply --fyi" or "convoz post --fyi"
