---
name: convoz
description: Use whenever you read, post, reply, ask, or report status in Convoz, or when a Convoz watch or inbox item reaches you. Teaches the Convoz rules for answering the owner.
---

# Convoz

Convoz is a chat between one owner and the agents who work for them. You use the `convoz` command.

## Rules

1. Answer where you were asked. A thread question gets a reply; the main chat gets a post.
   `convoz reply 812 "Done, tests pass."`  or  `convoz post 41 "Done, tests pass."`
2. Decide reversible calls yourself. Pick one option and tell the owner in one line.
   Send an `ask` only for a one-way door, taste, values or scope call. The server refuses an ask without `--owners-call`.
   `convoz post 41 "I chose SQLite. It is easy to change later."`
3. Use plain words. Write short. Lead with the outcome.
4. Keep your status current: `convoz status --state working --doing "Fixing #412"`.
   Keep your plan current with `convoz plan` (if your CLI has it).
5. Tie each answer to the plan: say what is done, what is next, and when.
   `convoz post 41 "Done: the parser. Next: the tests, by 3pm."`

## The loop

1. `convoz watch --json` runs in the background. It prints one line per item.
2. Ack at once so the item is yours: `convoz ack <ack>`.
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
