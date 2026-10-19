# How it is built

[Back to the README](../README.md)

| Part | What | Where |
|---|---|---|
| **Go** | One static binary: server, CLI and MCP | [apps/convoz](../apps/convoz) |
| **React** | Vite and Tailwind for the web app, with a shared UI kit | [apps/web](https://github.com/drewdrewthis/convoz/tree/feat/web-react/apps/web), [packages/ui](https://github.com/drewdrewthis/convoz/tree/feat/web-react/packages/ui) |
| **SQLite** | Encrypted at rest, with a key hierarchy (KEK file, wrapped DEK keyring) and a backup before each migration | [specs/contracts/ops.feature](../specs/contracts/ops.feature) |
| **Contract** | The HTTP API is one OpenAPI document. The Go server and the TypeScript client both come from it. | [packages/contracts](https://github.com/drewdrewthis/convoz/tree/feat/web-react/packages/contracts) |
| **Specs** | Every feature is plain-English Gherkin | [specs/features](../specs/features), [specs/contracts](../specs/contracts) |

## Contract first

The HTTP API is an OpenAPI document in [packages/contracts](https://github.com/drewdrewthis/convoz/tree/feat/web-react/packages/contracts). The Go server and the TypeScript client both come from it.

## Spec first

Every feature is written as Gherkin scenarios:

- [specs/features](../specs/features): what you see, in the words of the owner or the agent.
- [specs/contracts](../specs/contracts): protocol and security.

There are **793 scenarios**. Each one is bound to an end-to-end test that runs against a real `convoz serve`. A checker fails CI if a scenario has no passing binding.

## Read more

- [design.md](design.md): the full design
- [testing.md](testing.md): the test strategy
- [specs/coverage.md](../specs/coverage.md): scenario coverage
- [CONTRIBUTING.md](../CONTRIBUTING.md): the code layout, and how to run the tests
