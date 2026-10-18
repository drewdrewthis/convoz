# Convoz — user stories

Source of truth: design draft 9 (2026-10-16), which folds in the DA must-fixes M1–M8, the messages and apps spec (`docs/messages-apps-spec.md`, AC-M1…AC-M15) and the contradiction picks C-1…C-10.
Each story links to its feature, the invariants (I-n, draft 9 §8) and the ACs (AC-n, draft 9 §19) it covers.
Scenarios that prove a story carry the same `@I-n`, `@AC-n`, `@AC-Mn`, `@Mn` and `@C-n` tags, so `coverage.md` is generated, not hand-kept.

Version: **v1** = in the first release (slices S0–S12, S-A, S-U). **later** = after v1 (S-10b push actions, S-15 invites and members, delete my data, `watch --exec`, SSE follow).

## How the specs are tested

- **Two kinds of file, one feature name.** `specs/features/<f>.feature` holds the **user-facing** scenarios: what Drew or an agent sees and does, in their words. `specs/contracts/<f>.feature` holds the **contract** scenarios for the same feature: status codes, headers, races, data-file scans, DB probes and CI gates. The checker rejects protocol words in a user-facing scenario. Read the user-facing file first; the contract file pins the implementation.
- **Every scenario is end to end.** It runs against the real `convoz` binary (`convoz serve`) with a real SQLite file in a fresh `mktemp -d` data dir. No mocks of our own code.
- **Driver tags** say what exercises the scenario: `@browser` (Playwright; `@phone` adds the 390×844 phone profile), `@cli` (the `convoz` binary as argv, never through a shell), `@mcp` (an MCP client on `convoz mcp` stdio), `@api` (plain HTTP).
- **Observable from outside.** Steps assert what a user sees, what the CLI or MCP returns, HTTP responses, or files on disk.
- **`@invariant`** marks a rule that lives inside the server (a trigger, a race fence, a scrub). The scenario still observes it from outside: a second claim returns nothing, a byte scan of the data file finds no seeded string. Byte scans use the encryption-off **test build**, which is never shipped.
- **`@lossy`** runs on the lossy profile (400 ms RTT, 2% loss, 400 kbps) with `tc netem` in a user + network namespace, or the stall proxy when netem is not available on CI (the report says which).
- **`@needs-owner`** needs Drew's phone or a live tailnet machine. These are run by hand from a runbook and are not in CI.
- **Fake data only.** Tokens contain `TESTONLY`; seeded strings start with `ZQX-`. Time-based scenarios use the test build's clock control.
- **Bounded.** Every run has a timeout. Nothing is killed by name or pattern.
- **Version tags** `@v1` / `@later` decide what CI runs for the release.
- Check: `python3 -I specs/scripts/check_specs.py specs --write-coverage` parses every file, lints it (tags, the user/contract split) and rewrites `coverage.md`.
- **Changing a scenario** is allowed in any PR. CI lists every added, changed and removed scenario in the PR summary (design draft 9 §4.4). There is no lock and no spec review.

## Owner (Drew)

| ID | Story | Ver. | Feature | Invariants | ACs |
|---|---|---|---|---|---|
| US-01 | As the owner I want to set Convoz up with passkeys from a link made on the server box, with recovery codes and a second passkey, so that only I get in and I can never lock myself out. | v1 | onboarding | I-1 I-26 | AC-2 |
| US-02 | As the owner I want one Now screen with every ask, pending agent add and machine request, so that I clear what waits on me in a few taps. | v1 | now | I-13 I-15 I-17 I-36 | AC-8 |
| US-03 | As the owner I want to answer an ask with its recommendation, an alternative or my own words in one tap, so that the agent gets a clear and final decision. | v1 | asks, now | I-10 I-11 I-12 I-15 I-24 | AC-4 AC-13 |
| US-04 | As the owner I want to snooze an open ask or dismiss it and get it back when I choose, with a history of who did what, so that Now holds only what I can act on today. | v1 | now, asks | I-12 I-13 | AC-29 |
| US-05 | As the owner I want to start and name conversations and bring an agent in by typing its @handle, so that each piece of work has one place with the right agents. | v1 | conversations, composer | I-18 I-20 | AC-13 |
| US-06 | As the owner I want agents to only request adds that I approve, so that no agent can pull another agent into my conversations. | v1 | now, conversations, security | I-17 | AC-26 |
| US-07 | As the owner I want a removed agent to be cut off at once, with its asks closed, so that removal means removal. | v1 | conversations, inbox, asks | I-7 I-19 | AC-6 |
| US-08 | As the owner I want threads that count as unread only when I am involved, so that busy conversations stay readable. | v1 | threads | I-8 I-14 | — |
| US-09 | As the owner I want a rail that I order and that activity never reshuffles, with bold rows for unread work and quiet conversations folded into Older, so that things stay where I put them. | v1 | rail | I-14 I-21 | AC-13 |
| US-10 | As the owner I want to star conversations, pin messages and mute noise, so that the important things stay in reach. | v1 | pins-stars | I-21 I-22 | — |
| US-11 | As the owner I want to find any message, ask, file or link fast, newest first, with filters, so that I get back to a decision without scrolling. | v1 | search | I-6 | AC-13 |
| US-12 | As the owner I want a push only for what needs me, private on the lock screen, so that my phone is useful and not noisy. | v1 | notifications | I-28 | AC-7 |
| US-13 | As the owner I want settings that apply at once on the right device, with a theme that never flashes, so that the app behaves the way I want. | v1 | settings | I-29 | AC-11 |
| US-14 | As the owner I want to send voice notes that agents can read as text, so that I can give direction on the move. | v1 | voice, inbox | I-27 I-31 I-44 I-49 | AC-20 AC-M11 |
| US-15 | As the owner I want agents to send small apps (charts, tables, pickers, forms) that can never send anything as me without my tap, so that I can decide in place, safely. | v1 | apps-host, security | I-16 I-46 I-50 | AC-25 AC-M5…AC-M10 |
| US-16 | As the owner I want a new machine to show me a code that I approve with a passkey, so that only machines I chose can speak for my agents. | v1 | machine-login, now | I-26 I-33 I-36 | AC-8 |
| US-17 | As the owner I want one Crew directory of identities, machines and live sessions, where I can disable or revoke anything at once, so that I always know who said what and can cut anyone off. | v1 | crew, security | I-2 I-3 I-37 I-38 | AC-14 |
| US-18 | As the owner I want to reveal or replace a lost machine key with a passkey and an audit trail, so that a rebuilt machine loses no agent state. | v1 | machine-login, security | I-38 I-39 | AC-14 AC-15 |
| US-19 | As the owner I want the tailnet to be a real wall, so that nothing reaches Convoz from outside it. | v1 | security | I-41 | AC-24 |
| US-20 | As the owner I want files, markdown and avatars from agents handled so that they cannot run or leak, so that an agent mistake stays harmless. | v1 | security | I-31 I-32 I-44 I-45 | AC-25 |
| US-21 | As the owner I want a runaway agent loop to pause the conversation and agents held to budgets, so that agents cannot flood me. | v1 | messages-types, conversations | I-16 I-30 | AC-5 |
| US-22 | As the owner on mobile data I want Convoz to stay fast and lose or double nothing, so that I can trust it from anywhere. | v1 | poor-network, composer | I-23 I-24 I-31 | AC-10 AC-20 |
| US-23 | As the owner I want the data encrypted on disk, backups I can restore, and deletes and purges that leave no trace, so that a stolen disk or backup leaks nothing. | v1 | ops, messages-types | I-27 I-34 I-49 | AC-3 AC-12 AC-M12 |
| US-24 | As the owner I want every change to be all-or-nothing and safe to retry, with thin events, so that clients and agents can trust what they sync. | v1 | platform | I-4 I-5 I-9 I-23 I-24 I-48 | AC-22 |
| US-25 | As the owner I want CI to refuse work that breaks the module boundaries, budgets or accessibility, so that agents driving the build cannot lower the bar. | v1 | quality-gates | — | AC-1 AC-9 AC-16 AC-17 |
| US-26 | Removed (pickup). Owner said: "Nothing claims conversations. I need to tag." | removed | — | — | — |
| US-27 | As the owner I want to answer an ask from the lock screen, off by default, so that I can decide without opening the app. | later | notifications | I-35 | — |

## Agent session (one Claude session acting as one identity)

| ID | Story | Ver. | Feature | Invariants | ACs | Amend. |
|---|---|---|---|---|---|---|
| US-30 | As an agent session I want to start a short lease as my identity with a one-line prompt that holds no secret, so that I can join without a human pasting a key. | v1 | sessions, cli-mcp | I-37 I-40 I-42 | — | M5 |
| US-31 | As an agent session I want one brief of who I am, what is unread, my asks and the last handoff, in a fixed budget and with no side effects, so that I can pick up the work without being told again. | v1 | brief-handoff | I-6 I-7 | AC-19 | M2 M7 |
| US-32 | As an agent session I want an inbox with one item per conversation that I claim and ack with a token, that goes first to the session already working there, so that two sessions never handle the same item and a lost response loses nothing. | v1 | inbox | I-19 I-43 | AC-6 AC-18 AC-20 AC-27 AC-28 | M1 M2 M3 M4 M8 C-1 C-10 |
| US-33 | As an agent session I want to leave handoff notes for my next session, so that context survives the end of a session. | v1 | brief-handoff | I-24 | — | — |
| US-34 | As an agent session I want to post, reply and ask structured questions, so that the owner can follow and decide. | v1 | messages-types, asks, cli-mcp | I-11 I-16 I-18 I-40 | AC-5 | — |
| US-35 | As an agent session I want to read and search only what I may see, so that I can look things up without overreaching. | v1 | brief-handoff, search | I-6 I-7 | — | — |
| US-36 | As an agent session on a poor link I want retries that never duplicate and exit codes that tell me what went wrong, so that my scripts are reliable. | v1 | cli-mcp | I-24 | AC-21 | — |
| US-37 | As an agent session in Claude Code I want Convoz as self-describing MCP tools set up by one command, sharing one lease across my tools, Bash calls and subagents, so that I use it like any other tool. | v1 | cli-mcp, sessions | I-37 I-42 | AC-27 | M5 |
| US-42 | As an agent session I want to build, check and post small apps with a schema I can validate before I post, so that the owner can decide in place and my typos fail loudly. | v1 | apps-host | I-50 | AC-M2 AC-M3 AC-M4 | — |
| US-43 | As an agent session I want the owner's picks and form answers from my apps as inbox items, so that I act on them like any other reply. | v1 | apps-host, inbox | I-43 I-46 | AC-M6 | — |
| US-38 | As an agent session I want to set my own profile and status, never my handle, so that the owner knows who I am and what I am doing. | v1 | cli-mcp, crew | I-3 I-32 I-40 | — | — |
| US-39 | Removed (pickup). Owner said: "Nothing claims conversations. I need to tag." | removed | — | — | — | — |
| US-40 | As an agent session I want to request that another agent be added, or leave, so that the right crew is in each conversation. | v1 | cli-mcp, now | I-17 | — | — |
| US-41 | As a daemon agent I want to follow my inbox as a stream and run a command per item, so that long-running workers react at once. | later | inbox, cli-mcp | — | — | cut from v1 |

## Machine (a host that runs agents)

| ID | Story | Ver. | Feature | Invariants | ACs | Amend. |
|---|---|---|---|---|---|---|
| US-50 | As a machine I want to log in once with a device-flow code, survive a lost response, and keep my key in a private file, so that every agent on me can start sessions and no key ever enters a prompt. | v1 | machine-login | I-25 I-36 I-42 | AC-8 AC-27 | M6 |
| US-51 | As a machine I want to run many identities and sessions at once within clear caps, so that countless agents share one key safely. | v1 | sessions | I-30 I-33 I-37 | — | M5 M8 |
| US-52 | As a machine the owner trusts I want to create new identities when allowed, so that new agents can start without a trip to the app. | v1 | sessions | I-3 | — | — |
| US-53 | As a rebuilt machine I want my key back by Reveal or Regenerate, so that my agents keep their history and inboxes. | v1 | machine-login | I-38 | AC-15 | M7 |

## Member human (later, after invites in S-15)

| ID | Story | Ver. | Feature | Invariants | ACs |
|---|---|---|---|---|---|
| US-60 | As a member I want to join by a one-time invite and see only the conversations I am in, so that the owner can share some work, not all. | later | crew, conversations, search, platform | I-6 I-7 I-23 | — |
| US-61 | As a member I want my own stars, pins, mutes and snoozes, so that my view does not change the owner's. | later | pins-stars, asks | I-13 I-22 | — |
| US-62 | As a member I want to delete my data so that nothing of mine stays readable. (AC-23 moved to later with members, C-7; v1 proves the owner's purge.) | later | ops, crew | I-3 I-49 | AC-23 |
| US-63 | As a member I want workspace settings left to the owner, so that one person sets the rules. | later | settings | I-29 | — |

## Kept, updated and dropped from the draft-6 spec (`specs/features/convoz.feature`, 32 scenarios)

| Draft-6 scenario | Now |
|---|---|
| Agent message reaches Drew's open browser fast | Kept → conversations ("…fast"), poor-network (p95 ≤ 2 s on lossy). `feed post` → `convoz post`. |
| Message shows on Drew's phone over Tailscale | Kept → poor-network, `@needs-owner`. |
| Drew's reply is one line in the watch stream · double submit · newlines escaped | Kept → cli-mcp. `feed watch` → `convoz watch --json`, one JSON line per inbox item. |
| The server cursor moves only on an explicit since | Dropped: superseded by inbox claim / ack with a claim token (M1, M3). |
| (draft 8 spec) A fresh login that replaces the key | Dropped with the DA cut: Regenerate replaces a lost key (machine-login). |
| (draft 8 spec) Conversations cut from a brief come back in the next brief | Reworded: the brief has no side effects, so a cut conversation stays listed until the agent reads it; `--page 2` shows the next 10. |
| Button click delivered as a reply · undeclared action rejected · double click one reply | Updated → asks: a choice the ask did not offer is refused; a double tap answers once. Free-form actions are gone; asks have a recommendation and alternatives. |
| An ask is answered by a threaded reply · an unthreaded message answers every earlier ask · a message elsewhere does not answer | Dropped: only the answer command moves an ask (draft 8 §8.1). New scenario: "A plain message does not answer an ask". |
| Clicking a declared action answers · Done removes · snooze · unsnooze · count in every tab | Updated → now (Done → Dismiss). |
| Every API route answers 401 without credentials | Updated → security, new route list. |
| The page itself answers 401 without a session | Dropped: the PWA shell is public and offline-capable; the API is not. |
| Login sets a strict session cookie | Updated → onboarding: after a passkey, cookie `__Host-convoz_sid`. |
| Foreign Origin rejected · unlisted Host rejected · off the tailnet | Kept → security (missing Origin also rejected; unknown Host → 421). |
| A rich message cannot reach the network | Updated → apps-host (Tier-2 frame). |
| Rich body caps | Updated → messages-types (body 16 KB, app 64 KB, 10 attachments, 5 URLs) and asks (≤4 alternatives). |
| Two agents race to claim an open question · non-open cannot be claimed · non-member cannot claim | Removed with pickup. Owner said: "Nothing claims conversations. I need to tag." |
| Unknown or revoked token rejected | Updated → security: a revoked machine key. |
| An agent cannot post under another name · into a conversation it is not in | Kept → messages-types (an extra `author` field is now a 400). |
| Only the owner adds agents, and the token is shown once | Dropped: Add agent makes no key; the machine key comes once through the device flow (machine-login) or Reveal (security). |
