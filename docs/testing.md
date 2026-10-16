# Convoz test strategy: Gherkin, end to end

Version 3, as adopted by design draft 9 §4.4. It replaces v1 and v2. Owner: "just e2e tests running against gherkin ... the only specs that actually matter for agentic driven dev", "we want gherkin driven e2e tests. the rest are optional", and "I want to tell you the spec from a BDD user perspective, and then the rest are test that couple/match implementation details".

Changes from v2: the user-facing / contract split (§1, §14); invariants and ACs are proven by tagged scenarios, not by one scenario titled with each id (§3); scenario changes are flagged in the PR summary instead of locked behind a spec review (§10); slice table updated for draft 9 (§11).

## 1. Principle

**Gherkin scenarios are the only required specs. Every scenario runs end to end** against a real `convoz serve`: the real Go binary, a real SQLite file in a fresh `mktemp -d` dir, real HTTP and SSE. A driver outside the process acts and asserts:

| Tag | Driver |
|---|---|
| `@browser` | Playwright, desktop; `@phone` adds 390x844 |
| `@cli` | the real `convoz` binary, spawned by argv |
| `@mcp` | an MCP client against `convoz mcp` |
| `@api` | plain HTTP/SSE client |

Unit and component tests are optional dev aids: allowed, never required, never a gate. The Go test names in the design (§8 invariants, §16 slices) are optional regression aids in exactly this sense.

**Two kinds of feature file, both end to end.**
- `specs/features/<f>.feature`: **user-facing** scenarios. What Drew or an agent sees and does, in their words: screens, CLI output and exit codes, MCP tool results, pushes. No routes, status codes, headers, data-file scans, database words or benchmarks; no `@invariant`. The checker enforces this.
- `specs/contracts/<f>.feature`: **contract** scenarios for the same feature. Status codes, headers, race fences, byte scans, DB probes, CI gates. They pin implementation details, so they are the ones expected to change when the implementation changes.
- Write the user-facing scenario first; add a contract scenario only for what a user cannot see.

Kept from v1: every test and job has a timeout; fake tokens only (always containing `TESTONLY`); scratch from `mktemp -d`; no shell, argv lists only; a test stops only a child it started, through its own handle, never by name or pattern.

## 2. Prior art

Source: LangWatch `TESTING_PHILOSOPHY.md` and ADR-010 with its 2026-09-06 amendment.

**Transfers:** the parity checker with verbatim `@scenario "<title>"` bindings; unknown bindings fail CI; `@unimplemented` as a tracked promise; behaviour not implementation; no "should"; one invariant per scenario; regressions as `@regression` scenarios; spec first; use-proof in the PR; the four outside-in suites (browser, SDK, CLI, MCP) as our four drivers.

**The lesson that drives this:** "Green pieces do not make a working product." LangWatch had every unit test green while the booted product could not sign in.

**Rejected:** ADR-010's "keep e2e to 5-10 tests". LangWatch e2e needs Postgres, ClickHouse, Redis, workers and several Node apps: minutes to boot, shared state, no cheap clean start. Convoz is one ~20 MB Go binary plus one SQLite file. It boots well under a second, a fresh data dir costs nothing, and no service is shared. Isolation is free, so the cost argument is gone while the seam-bug argument stays.

## 3. The parity checker (the gate)

`just parity` parses `specs/**/*.feature` and the test trees.

1. Every scenario has a driver tag and a verbatim `@scenario "<title>"` binding in a test of that driver. A `@cli` scenario bound in a browser spec fails.
2. A binding naming no scenario fails.
3. `@unimplemented` (with issue link) passes the checker but fails slice-done and release.
4. After the run it reads the JUnit report: each bound scenario must have run and passed. A skip, an unnamed `test.fail`, or an empty test fails. A skip is not a pass.
5. No deny-list; Convoz starts clean.
6. Each invariant (I-n), design AC (AC-n) and message/app AC (AC-Mn) is proven by ≥1 bound scenario tagged with its id; titles name the behaviour, not the id. `specs/scripts/check_specs.py specs --write-coverage` regenerates `specs/coverage.md`, which must show no v1 gap. This replaces the v1 invariant and scenario gates.
7. The checker also enforces the split (§1) and the tag rules: one of `@v1`/`@later`, at least one driver tag, `@phone` only with `@browser`, ids in range.

## 4. Speed and reliability

**Target: full suite at most 10 min wall per PR; one scenario in under 5 s.**

Size today: 489 scenarios (298 user-facing, 191 contract; an outline counts once). Estimate, to be measured in slice 0: about 350 non-browser at ~1.5 s and 140 browser at ~6 s: about 23 CPU-minutes, so 2 to 3 min on 8 workers over 3 shards.

### 4.1 Isolation

- **Default: fresh server per scenario.** New `mktemp -d` data dir, listen on `127.0.0.1:0`, the server writes its bound address to a ready file. No fixed ports.
- **Fallback, only if measured faster: one server per worker with a per-test tenant reset** via the admin endpoint (section 5). Never share a tenant between tests.
- Parallel workers equal to cores; no order dependence.
- Shards split by scenario hash, balanced from a duration file.
- Browser only where the UI is the behaviour: one browser per worker, one context per test.
- No sleeps. Wait on events: SSE frame, ready file, DOM state, exit code.

### 4.2 Poor network (`@lossy`)

The default wrapper is a Go TCP **stall proxy** in front of the server, usable by any driver. Profiles: `fast3g`, `lossy` (400 ms RTT, 2% loss, 400 kbps, 300-1500 ms stalls, ~2% resets), `blackhole-then-recover`. A self-test fails a profile that does not delay or drop. `tc netem` is an optional nightly cross-check.

## 5. Determinism without leaking hooks into production

A Go **build tag `testhooks`** is the only place for the fake clock, seeded ids and data, fake push, and fault injection. Tagged files define the admin routes (`/__test/clock`, `seed`, `reset`, `fault`) and swap the `platform` clock, ids and push client. Untagged files hold no-op stubs. Routes also need `CONVOZ_TEST_ADMIN=1` and bind to loopback or a Unix socket only.

**The rule that stops it shipping:** the release workflow takes no tags input and builds with no `-tags`. A required release-guard step fails the release if `go version -m` lists `testhooks`, the binary contains `/__test/`, or a boot with `CONVOZ_TEST_ADMIN=1` answers anything but 404 on `/__test/reset`. Lint bans `time.Now` and `time.Sleep` outside `platform/clock`.

**Named gap:** e2e runs the `testhooks` binary. About 15 core journeys tagged `@release-binary` run on the exact release artifact with the real clock before tag. Tagged files add hooks only, never product logic.

## 6. Driver decision tree

Stop at the first match.

1. **The UI is the behaviour** (layout, focus, gestures, offline shell, service worker, theme, a11y, phone) -> `@browser`.
2. **Agent experience is the behaviour** -> `@cli` for the shell path, `@mcp` for the tool path.
3. **Protocol or wire contract** (status codes, SSE framing, long poll, auth, 426, idempotency, authz matrix) -> `@api`.
4. **Business rules** (ask machine, inbox, unread, mentions) -> the cheapest driver that can state them, usually `@api` or `@cli`.

One behaviour, one driver. The only repeat allowed is a thin "same rule via CLI and UI" pair where the contract matters; the title says so.

## 7. What e2e cannot prove cheaply: five exceptions

Each is bound to a scenario by `@scenario`, so the parity gate still covers it. Tags: `@probe @race @fuzz @bench @fault`. A sixth needs a written justification in the feature file and owner sign-off. Each observes through the binary where it can.

| Id | Exception | Outside-in angle |
|---|---|---|
| X-1 | **DB trigger and constraint probes**: owner uniqueness, kind immutability, no-delete, seal, forward-only cursors, composite FKs, event immutability. One table-driven file | Routes never issue the forbidden write, so the test opens the live SQLite file on a second connection and attempts it. Nightly negative control: remove one trigger, its probe goes red |
| X-2 | **Races and fences**: inbox claims (I-43), ask CAS | Two or more real `convoz` processes started together; assert final rows and exit codes; server built with `-race` |
| X-3 | **Markdown TS vs Go differential fuzz** (I-18, I-45) | `fast-check` corpus replayed through the server over `@api` and a Playwright page; compare. Fixed seed on PR, random nightly; failing seeds become scenarios |
| X-4 | **Perf benchmarks and soak** (section 12 budgets) | Drive the real binary over HTTP with the 1M fixture. Nightly on the pinned VM class; PR runs a small fixture with `benchstat` at 20% |
| X-5 | **Fault injection**: ENOSPC, fsync error, crash before SSE write | The fault endpoint arms the VFS; the harness kills only its own child via its handle, restarts, asserts recovery over `@api` |

Now ordinary scenarios: migration from frozen old DBs, backup and restore, scrub, 426 for old clients, security items. Static checks stay as lint, not specs: `go vet`, `staticcheck`, `govulncheck`, codegen drift, `oasdiff breaking`, secret-shape lint, `size-limit`.

## 8. Flake policy

- **No auto-retry**: Playwright `retries: 0`, nothing elsewhere.
- A flake gets an issue, an owner and `@quarantine` within one business day. Quarantine runs nightly, cap 5 (above that merges stop); older than 14 days: fix or delete. `@race` and `@fault` are never quarantined.
- On failure keep the Playwright trace and HAR, screenshot, server log, and a copy of the data dir. Teardown is the runner's job.

## 9. `@needs-owner` runbooks

Unchanged from v1 section 5: `docs/owner-checks/<id>.md`, evidence in `evidence/<release>/<id>.md`, `just owner-checks` lists due checks, the pre-release gate fails if a due check has no pass. Such a scenario needs its runbook instead of an automated binding.

## 10. The agentic-dev loop

1. **Spec first.** Scenarios are written or edited before code. Anyone may add, change or remove a scenario in any PR. CI lists every added, changed and removed scenario (file and title, user-facing or contract) in the PR summary so the owner sees it. There is no hard lock and no spec review gate (owner: "a spec review? not sure it super matters").
2. **Red.** Scenarios land with a failing bound test in a test-only commit. CI runs the slice's scenarios on it (must fail) and on head (must pass). This is v1 AC-1.
3. **Implement** until the bound scenario passes. Inner loop: `just e2e "<title>"` runs one scenario.
4. **Parity gate** on the PR: bindings, no unknowns, zero `@unimplemented` in the slice, JUnit green.
5. **Use-proof is automatic.** Each run saves a final screenshot per `@browser` scenario and stdout plus exit code per `@cli` and `@mcp` scenario. The proof is `pnpm proof`, which writes `e2e/report/proof.html` after a leak scan; it is published as a screenshot in the PR.
6. **Bug fixes** land with a `@regression` scenario that fails without the fix.

## 11. Slice to scenarios-that-must-pass

Done = every listed scenario is bound, was red first, is green; parity passes; earlier rows stay green.

| Slice | Must pass (driver) |
|---|---|
| S0 | Boot on fresh dir; refuse newer DB; migrate frozen old DB (`@api`); release-guard clean; X-1 for I-1/2/5/23; X-5 failed commit leaves no event or FTS row (I-4) |
| S1 | Device-flow login (lost-response pickup, M6), session leases (re-mint, M5), tailnet wall; SEC-1..4; I-1..3, 25, 26, 33, 36..42; AC-2, 8, 14, 15, 24, 27 (b, c) |
| S2 | Rail (Older view), conversations, threads, unread, mentions, edits and deletes, projection (`@browser`, `@api`); I-6..9, 14..21, 24, 45, 47, 48; X-3; AC-5, 13, 26, M1, M13..M15; X-4 rail at 1M nightly |
| S3 | Inbox: one conversation item, held items, expire at 5, claim tokens, merge, extend, session preference, removal notice (`@cli`); X-2 I-43; AC-6, 18, 22, 27 (a), 28; slow SSE client reset; two-context sync, gap resync |
| S4 | Ask lifecycle, history, snooze on open asks, presets (`@cli`, `@browser`); I-10..13; X-2 ask CAS; AC-4, 29 |
| S-A | Brief (budgets, paging, no side effects), `convoz setup`, MCP list, call, error shape, shared lease per Claude session (`@mcp`, `@cli`); AC-19, 21; retry with one `client_id`; owner: real Claude Code |
| S5, S9 | I-21, 22, 29 (`@api`) |
| S6 | Resumable upload under `@lossy` (AC-20c); voice transcripts to agents and search; I-27, 31, 32, 44; AC-25 files, AC-M11 |
| S7 | I-46, I-50; app validate/build/post, pickers and forms, sandboxed frame, frame route (`@browser`, `@cli`, `@api`); AC-25 apps, AC-M2..M10 |
| S8 | Search; deleted text not found (AC-M12); X-4 search at 1M nightly |
| S10 | I-28; AC-7; fake push gets padded payload; owner: iOS push |
| S11 | Unfurl blocks private IPs, redirects, DNS rebinding (`@api`) |
| S12 | I-49 (owner purge byte scan); AC-3, 12; backup and restore; KEK rotation; export; negative control |
| S-U1..5 | Each screen desktop and `@phone`; AC-10, 11, 17 (axe step), 20; offline send; service-worker update; owner: Add to Home Screen, iOS offline, DERP |
| S-10b | I-35; owner: lock-screen answer |
| S-15 | Invite; member and guest matrix over the route table (`@api`); delete my data (AC-23, C-7) |

## 12. What changed from v1

**Removed as required:** layer pyramid, coverage floors, component suites, Ladle diffs, pixel snapshots, general property suites.
**Replaced:** invariant and scenario gates become one parity checker; contract, migration, backup, scrub and security layers become scenarios.
**Kept:** bounds, fake tokens, flake policy, `@needs-owner`, negative control, perf budgets, stall proxy.
**Shrunk:** property and fuzz targets become X-2 and X-3.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Slow feedback** | Single-scenario and by-tag runs; sharding; browser only where the UI is the behaviour; measured per-worker server reuse; dev-aid unit tests allowed in the inner loop |
| **Failure locality**: a red e2e does not name the line | One invariant per scenario, so the title names the contract; server log, DB copy, trace and HAR kept; agents read them |
| **Flakiness** | Fake clock; event waits; fresh state; no retries; capped quarantine with owner |
| **Test build differs from release** | Hooks-only tagged files; `@release-binary` set; release-guard |
| **Combinatorial internals get one scenario each** | X-2, X-3; failing seeds become scenarios |
| **Agents weaken scenarios to go green** | Every scenario change is listed in the PR summary (§10); skips fail the gate; the owner reads the list |
| **Suite growth breaks the cap** | Duration file; alarm at 7 min; prune duplicates |

## 14. Layout and tags

| Path | What |
|---|---|
| `specs/features/*.feature` | user-facing scenarios (§1) |
| `specs/contracts/*.feature` | contract scenarios; Feature names end with "(contracts)" |
| `specs/stories.md` | user stories with links to features, invariants and ACs |
| `specs/coverage.md` | generated: counts per feature, gaps, and a matrix per id family |
| `specs/scripts/check_specs.py` | parser, linter (tags, split) and coverage generator; `python3 -I specs/scripts/check_specs.py specs --write-coverage` |
| `docs/owner-checks/<id>.md` | runbooks for `@needs-owner` scenarios (§9) |

Traceability tags: `@I-n` (design §8), `@AC-n` (design §19), `@AC-Mn` (`docs/messages-apps-spec.md` §10), `@Mn` (DA must-fixes on draft 8), `@C-n` (contradiction picks, design §17). Driver tags: `@browser` (`@phone`), `@cli`, `@mcp`, `@api`. Others: `@lossy`, `@invariant` (contracts only), `@needs-owner`, `@v1`/`@later`, and the §7 exception tags.
