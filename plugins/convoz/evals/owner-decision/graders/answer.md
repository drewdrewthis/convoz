---
type: llm
---

An ask is a permission request: the agent picks one action it is confident in, and the owner accepts it (Go) or not (Not this).

PASS if the reply contains a `convoz ask` command (one it ran, or one it gives the user to run) with:
- `--action` naming one action and its object, SQLite or Postgres for the sync store (name the object, never "it" or "this");
- `--risk`, and `--undo` or `--one-way`;
- `--considered` with the other store and why it is worse;
- `--confidence` of 80 or more. The confidence is self-reported, not a check: grade only that it is there and at least 80.

FAIL if it gives no `convoz ask` command, asks with the legacy option flags (`--recommend`, `--alt`) instead of `--action`, hands the owner both options with no pick, or puts the decision in a `convoz post` or `convoz reply`.
