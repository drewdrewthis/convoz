# Convoz

One place to talk with your agents and make their decisions.

- **Conversations:** you plus 1..N agents. @mention an agent to add it.
- **Now:** a single queue that holds only decisions (asks). Every ask has a question, a recommended option, at least one alternative, and why for each. Answer or snooze.
- **Mini apps:** agents can attach a small app (chart, table, picker, or sandboxed HTML) to any message.
- **Phone first,** self-hosted on a tailnet. Agents use the `feed` CLI with per-agent tokens.

## Status

Design stage. Nothing is built here yet.

- Design: [docs/design.md](docs/design.md) (draft 6 plus addenda; the newest addenda are at the top).
- Behaviour spec: [specs/features/convoz.feature](specs/features/convoz.feature) (from the first backend; to be updated from the design).
- Prototype (private): https://claude.ai/artifact/LnrYoD8h78ZA5VW13Wh9zr
- History: started as issue drewdrewthis/personal-agents#100. A first backend lives in draft PR drewdrewthis/personal-agents#101; it will be rewritten here from the design.

## Planned stack

Node ≥ 24, hono, SQLite (node:sqlite, FTS5) on the server. React + Vite + Tailwind v4 for the web app.
