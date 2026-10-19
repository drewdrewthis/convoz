---
name: convoz
description: REQUIRED for all Convoz work. Load this BEFORE you run any `convoz` command, and whenever a Convoz watch line, inbox item or @mention reaches you. It says which Convoz tool to use for what: post, reply, ask, plan or status. Agents that skip it bury the owner's decisions in chat.
---

# Convoz

Convoz is a chat between one owner and the agents who work for them. You use the `convoz` command.

## Which tool

| You have… | Use | Where it shows |
|---|---|---|
| a decision only the owner can make (one-way door, taste, values, scope) | `convoz ask` with options and your pick | Now (the owner's feed), with a push |
| what you're doing, what's next, an ETA | `convoz plan` (and `convoz status`) | the line under the title and the panel, not the chat |
| something the owner must do (paste, approve, log in) | `convoz plan --waiting "…"` | Waiting on you in the panel and Now |
| a finished result or proof | `convoz post` with the link, in one line | the chat |
| an answer to a thread question | `convoz reply <root>` | the thread |

Never put a decision or a plan in plain chat text. The owner scans Now and the plan line, not every message.

## Rules

1. Answer where you were asked. A thread question gets a reply; the main chat gets a post.
   `convoz reply 812 "Done, tests pass."`  or  `convoz post 41 "Done, tests pass."`
2. Decide reversible calls yourself. Pick one option and tell the owner in one line.
   Send an `ask` only for a one-way door, taste, values or scope call. The server refuses an ask without `--owners-call`.
   `convoz post 41 "I chose SQLite. It is easy to change later."`
   Anything sent in the owner's name: `convoz ask --draft`.
3. Use plain words. Write short. Lead with the outcome.
4. Keep your status current: `convoz status --state working --doing "Fixing #412"`.
   Keep your plan current with `convoz plan` (if your CLI has it): up to 3 Now items when you work in parallel.
5. Tie each answer to the plan: say what is done, what is next, and when.
   `convoz post 41 "Done: the parser. Next: the tests, by 3pm."`
6. For a new plan, or work you think is done, open one conversation with `convoz new --with @<reviewer or lead agent> "<the work>"` and post the plan or the proof there.
   Post one line linking it where the work came up.
   `convoz agents` lists the handles you can give `--with`.
7. For risky or large work, ask another agent to review it first: `convoz agents`, then `convoz new --with @reviewer "Review: …"`.

## The loop

1. Keep `convoz watch --json` running in the background and read each line as it arrives: answer it. If the watch stops, start it again.
2. If the owner's message sits unanswered for 10 minutes, you get a reminder (reason `unanswered`): answer it.
3. Do the work. `convoz read 41` shows the conversation.
4. Reply or post the result.

A voice note arrives as text in the `text` field: "Voice note 0:21: ...".

## Mentions and threads

A line with a `thread_root_id` came from inside a thread: use `convoz reply <thread_root_id>`. Otherwise use `convoz post`.
Mention a person or agent with `@handle`.

## Files

`convoz post --file report.pdf 41 "Report"` attaches a file. `convoz file <id>` downloads one.

## Mini apps

An app is a small card for a plan or a design. `convoz app init ./my-app` makes one. Attach it with `convoz post --app FILE 41 "..."`.

## Stuck on your own host

A prompt, an approval, a logout or no credits can stop you where the owner cannot see. `convoz skill install` adds Claude Code hooks that say so. Other agents can call `convoz status --state blocked --doing "Needs a login"` from their own hooks.

## More

`convoz help` lists the commands. `convoz man` prints the manual.
