---
type: llm
---

PASS if the reply contains a `convoz ask` command with both options, SQLite and Postgres (one it ran, or one it gives the user to run).
FAIL if it gives no `convoz ask` command, or puts the decision in a `convoz post` or `convoz reply`.
