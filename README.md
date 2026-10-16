# Convoz

One place to talk with your agents and make their decisions.

- **Conversations:** you plus 1..N agents. @mention an agent to add it. Slack-style reply threads.
- **Now:** a single queue that holds only decisions (asks). Every ask has a question, a recommended option, at least one alternative, and why for each. Answer, dismiss or snooze.
- **Mini apps:** agents can attach a small app to a message: Tier 1 built-in components (chart, table, picker, form, …) or a Tier 2 sandboxed bundle.
- **Agents:** one `convoz` binary (alias `cvz`) is the server, the CLI and the MCP server. A machine logs in once with a device flow you approve on your phone. Each identity gets an inbox; Claude sessions pick up work, `brief` and `handoff`.
- **Phone first,** self-hosted, tailnet only.

## Status

S0 (the skeleton) and S1a (owner auth and the tailnet wall) are built: the `convoz` binary with `serve`, `admin bootstrap-link` and `version`; the encrypted SQLite store with migrations and a pre-migration backup; the key hierarchy (KEK file, wrapped DEK keyring); the owner's passkeys, recovery codes, device sessions and step-up; the wall (`--host`, loopback or unix socket only, funnel check, admin socket); a bare owner console for sign-in and onboarding; 32 end-to-end scenarios and the CI gates (module boundaries, red first / green at head). Machines, sessions and crew (S1b) and the rest of the product are design only.

### Build and test

Needs Go (see `apps/convoz/go.mod`), Node 24+, pnpm and Python 3.

```sh
pnpm install --frozen-lockfile
pnpm --filter @convoz/e2e exec playwright install chromium   # once; the browser scenarios use it
pnpm build:go    # apps/convoz/bin/convoz (release) and bin/convoz-test (-tags testhooks)
pnpm e2e         # every Gherkin scenario against the real binary
pnpm parity      # every v1 scenario has one passing binding
pnpm proof       # after pnpm e2e: e2e/report/proof.html, each scenario's commands, HTTP calls, output and exit status, leak-scanned
```

- `CONVOZ_BIN` picks the binary under test (default `apps/convoz/bin/convoz-test`, the testhooks build).
- `GO_BIN` picks the Go tool for the e2e suite and the scripts (default: `go` on `PATH`).
- SQL lives in `apps/convoz/internal/server/<module>/queries/*.sql`, one sqlc package per module. After a change run `make -C apps/convoz sqlc`; the generated code is committed and CI checks it with `go tool sqlc diff`. sqlc is pinned by the `tool` line in `apps/convoz/go.mod`.
- `make -C apps/convoz lint-boundaries` checks the module boundaries: Go imports and table ownership (design §4.3).
- Run a local server: `convoz serve --data-dir D --kek-file F --host localhost --tailscale off --admin-socket D/admin.sock`, then `convoz admin bootstrap-link --admin-socket D/admin.sock` and open the link it prints.

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
