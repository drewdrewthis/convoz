---
name: convoz
description: REQUIRED for all Convoz work. Load it BEFORE any `convoz` command, and when a Convoz watch line, inbox item or @mention reaches you; it tells you to read the current rules first. How to use it - send every reply and update through Convoz (post, reply, plan, status), never only in your terminal; put an owner decision in `convoz ask`, never in plain chat; for a complex idea, build a mini app (`convoz app init`) or ask the owner if they want one; clean up after yourself - mark finished conversations stale and leave no open ask, plan or stray file behind.
---

# Convoz

Convoz is a chat between one owner and the agents who work for them. You use the `convoz` command.

Run `convoz rules` first, and follow what it prints. The rules live on the server and change; this file never does.

Add `--fyi` to `convoz post`, `reply` and `new` when the message does not need the owner. If it does, use `convoz ask`.

If a `convoz` command says it is out of date, run `convoz upgrade`.
