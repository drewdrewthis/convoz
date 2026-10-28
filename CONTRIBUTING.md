# Contributing to Convoz

Thank you for looking. Convoz is built spec first. It is **not licensed for use yet** (all rights reserved), so for now this page is about reading it, running it to give feedback, and filing issues.

## Set up

You need Go (version in [apps/convoz/go.mod](apps/convoz/go.mod)), Node 24+, pnpm and Python 3.

```sh
pnpm install --frozen-lockfile
pnpm --filter @convoz/e2e exec playwright install chromium   # once
pnpm build:go    # apps/convoz/bin/convoz (release) and bin/convoz-test (-tags testhooks)
```

The tests run the `testhooks` binary, which has a fake clock and seeded data. It is never released. `CONVOZ_BIN` picks another binary.

## Run the tests

Every scenario is one end-to-end test against a real `convoz serve`.

```sh
pnpm e2e                       # the whole suite (long)
pnpm parity                    # every scenario has one passing binding
python3 -I specs/scripts/check_specs.py specs   # the spec checker
```

While you work, run one spec file with few workers, so you do not overload your machine:

```sh
cd e2e
npx playwright test tests/asks.wp8.spec.ts --workers=2
npx playwright test -g "A voice note plays back" --workers=1
```

Use a visible element for waits, not `networkidle`. Give every test a timeout. Use fake keys that contain `TESTONLY`.

## The rule: spec first

1. **Scenario.** Add or change a scenario in `specs/features/<feature>.feature`. Write it as the owner or the agent would say it. No routes, status codes or database words there. Protocol and security details go in `specs/contracts/<feature>.feature`.
2. **Binding.** Add or change the e2e test in `e2e/tests/`. Its title is the scenario title, word for word.
3. **Code.** Write the least code that makes the scenario pass.

Unit tests are optional. The scenarios are the spec. If you change what the product does, the diff must change a scenario, and the PR must say which.

## Code layout

| Path | What |
|---|---|
| `specs/features/`, `specs/contracts/` | The Gherkin specs |
| `e2e/tests/`, `e2e/lib/` | The bindings and the helpers that seed a world |
| `apps/convoz/` | The Go binary: server, CLI, MCP. SQL is in `internal/server/<module>/queries/*.sql` (run `make -C apps/convoz sqlc` after a change) |
| `apps/web/` | The web app (React, Vite, Tailwind) |
| `packages/ui/` | Shared UI: wordmark, icons, sheets, fields |
| `packages/contracts/` | The OpenAPI document and the event schemas |
| `plugins/convoz/` | The Claude Code plugin and skill |
| `docs/` | Design, test strategy |

`make -C apps/convoz lint-boundaries` checks the module boundaries. `pnpm lint` runs eslint.

## Feedback and ideas

Convoz is **not licensed for use yet**. The code is public for feedback; all rights reserved for now. So, for now:

- Open an **issue** with a bug, a question or an idea. The templates help.
- For an idea, write it as scenarios (see the rule above). That is the best form of feedback.
- Please do not send pull requests yet. A license and a contribution process will come later.

## Later: the fork library

The plan is that forks share features by sharing scenarios. A feature is its Gherkin scenarios, their e2e bindings, and the code that passes them. To take a feature from another fork, copy its scenarios and bindings and make them pass in your code. This is not open yet.

Never put real keys, hostnames or private chat content in an issue.

