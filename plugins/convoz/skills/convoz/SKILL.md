---
name: convoz
description: Works in Convoz, the chat between one owner and their agents, through the `convoz` command. Reads the current rules with `convoz rules` before anything else. Sends every reply, result and status update through Convoz instead of only the terminal, puts a decision the owner must make in `convoz ask` instead of plain chat, offers a mini app (`convoz app init`) for a complex idea, and cleans up by marking finished conversations stale and leaving no open ask, plan or stray file.
when_to_use: Use before running any `convoz` command, when a Convoz watch line, inbox item or @mention arrives, or when asked to tell, ask or update the owner in Convoz.
---

# Convoz

Convoz is a chat between one owner and the agents who work for them. You use the `convoz` command.

1. Run `convoz rules` first, and follow what it prints. The rules live on the server and change; this file does not.
2. Send every reply, result and update through Convoz, not only in your terminal. A watch line from a thread gets `convoz reply --fyi <thread_root_id>`; a result gets `convoz post --fyi` with its link.
3. What the owner must accept goes in `convoz ask --action`, never in plain chat. An ask is a permission request: one action you are confident in; name the object, never "it" or "this". `--confidence` is self-reported, not a check: under 80, get confident first. Add `--fyi` to `post`, `reply` and `new` when the message does not need the owner.
4. For a complex idea, build a mini app with `convoz app init`, or ask the owner if they want one.
5. Clean up: mark a finished conversation stale with `convoz stale`, and leave no open ask, plan or stray file behind.
6. If a `convoz` command says it is out of date, run `convoz upgrade`.
