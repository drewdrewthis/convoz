# Convoz

One place to talk with your agents and make their decisions.

- **Conversations:** you plus 1..N agents. @mention an agent to add it. Slack-style reply threads.
- **Now:** a single queue that holds only decisions (asks). Every ask has a question, a recommended option, at least one alternative, and why for each. Answer, dismiss or snooze.
- **Mini apps:** agents can attach a small app to a message: Tier 1 built-in components (chart, table, picker, form, …) or a Tier 2 sandboxed bundle.
- **Agents:** one `convoz` binary (alias `cvz`) is the server, the CLI and the MCP server. A machine logs in once with a device flow you approve on your phone. Each identity gets an inbox; Claude sessions pick up work, `brief` and `handoff`.
- **Phone first,** self-hosted, tailnet only.

## Status

Design stage. Nothing is built yet.

- Design: [docs/design.md](docs/design.md) (draft 9). Open questions with default answers are in §17; build slices are in §16.
- Testing: [docs/testing.md](docs/testing.md). The Gherkin scenarios are the spec, and every scenario runs end to end against a real `convoz serve`. Unit and component tests are optional aids for regressions and debugging.
- Behaviour spec: [specs/features/](specs/features/) (user-facing) and [specs/contracts/](specs/contracts/) (protocol, security, invariants). Stories: [specs/stories.md](specs/stories.md). Coverage: [specs/coverage.md](specs/coverage.md). Check with `python3 -I specs/scripts/check_specs.py specs`.
- Messages and apps: [docs/messages-apps-spec.md](docs/messages-apps-spec.md), with JSON Schemas in [schemas/](schemas/) (`node schemas/validate.cjs <node_modules dir> schemas`, needs ajv 8).
- Brand: [assets/brand/](assets/brand/) (logo lockups, marks, app icons).
- Prototype (private): https://claude.ai/artifact/LnrYoD8h78ZA5VW13Wh9zr
- History: started as issue drewdrewthis/personal-agents#100. A first Node backend in draft PR drewdrewthis/personal-agents#101 is superseded by this design.

## Planned stack

- Server: Go, SQLite via `ncruces/go-sqlite3` (encrypted; FTS5), transactional outbox and thin events.
- Web: React + Vite + Tailwind v4 PWA.
- Repo: pnpm + Turborepo + `go.work` monorepo; OpenAPI and JSON Schema contracts.
- Deploy: one binary on 127.0.0.1 behind `tailscale serve`, as its own Unix user.
