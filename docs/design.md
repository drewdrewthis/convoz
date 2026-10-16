# Agent chat backend — architecture design (draft 6: conversations + reply threads)

Draft 6 (Drew): the top-level unit is a CONVERSATION with 1..N participants (1 agent = DM-like, several = group chat). Reply THREADS are Slack-style, spun off a message: `messages.thread_root_id` + `messages.reply_count/last_reply_at` on the root, `thread_follows(root_id)` for the owner's Threads view. A reply checks `canSee` on its conversation; "also send to conversation" writes a second visible copy-link. Unfurls and apps are stored as before but rendered collapsed by default. Below, read "thread" in §4–§7 as "conversation"; table `threads` → `conversations`, `participants.thread_id` → `conversation_id`.

Draft 6 addendum (Drew, rail order): rail order is manual and owner-only. `conversations.rail_rank TEXT` (fractional index, so a move is one row update) within each section (starred / not). `PATCH /api/conversations/:id {rail_rank, starred?}` in one `tx()`. New conversations get a rank above the current top. Activity never changes rank. The "today vs Older" split is a view filter on `last_activity_at`, not a reorder.

Draft 6 addendum (Drew, pins): message-level stars are renamed "pins" (owner-only, per message incl. asks). Conversations keep stars. Schema: `stars(conversation_id, created_at)` for conversations; `pins(message_id, created_at)` for messages (replaces `stars.kind='message'`). Search: `is:starred` = conversations, `is:pinned` = messages/asks. Routes: `PUT/DELETE /api/messages/:id/pin`.

Draft 6 addendum (Drew, no Threads view): the cross-conversation "Threads you are in" view is dropped. Side threads stay. Unread thread replies count toward the conversation's unread count and bold state (the rail is the single place to see new activity). No threads-list endpoint; per-thread unread comes from the existing per-conversation read cursor plus the root's reply metadata.

Draft 6 addendum (Drew, apps in messages): any agent message (incl. thread replies), not only asks, may carry an optional `app` (`{tier: 1, kit, props}` or `{tier: 2, html}`; same limits, sandbox and CSP as ask apps). Stored on the message row (`app_json`, ≤64 KB, validated). App → host postMessage results become an owner message (`kind=text`, `via_app=1`) in the same conversation/thread, posted through the normal owner send path (one `tx()`). Search: `is:app`. Message kinds stay `text` and `ask`; the app is an attachment, not a kind.

Draft 6 addendum (Drew, ask structure): every ask requires `question`, `recommended {label, why}`, and `alternatives[] (≥1) {label, why}`. `POST /api/asks` rejects with 400 if any part is missing or empty (why ≤280 chars each). The reply records which option was chosen (`recommended` | alternative index | custom text). The invite prompt and `feed ask` CLI (`--recommend "<label>" --why "<..>" --alt "<label>" --alt-why "<..>"`) require all parts.

Draft 6 addendum (Drew, message formatting): messages carry `format in ('markdown','markdownv2','plain')`, default `markdown` (CommonMark + GFM). `markdownv2` = Telegram MarkdownV2 (spoiler, underline, backslash escapes). Server stores the raw text as sent and validates `format`; rendering is client-side with a no-HTML renderer (raw HTML shown as text; links limited to http/https/mailto). FTS indexes a plain-text projection (markup stripped). CLI: `feed post --format markdownv2`. Agents get both formats described in the invite prompt.

Draft 6 addendum (Drew, priority): no priority levels (no P0–P3) and no owner "important" marker. Agents may set `urgent` on an ask (boolean, as now); Now sorts urgent first, then newest. Owner triage is only: answer now, or snooze. Revisit (fact-based urgency: `due_at`, `blocks`) only if urgent inflation becomes a real problem.

Draft 6 addendum (Drew, stars + avatars): no conversation pin and no conversation "done" (drop `pinned`, `done_at`). Owner stars: `stars(kind in ('conversation','message'), target_id, created_at)`, owner only. Agents may register an optional SVG avatar (`agents.avatar_svg`, ≤4 KB): server-side allowlist sanitize (shapes, paths, fills, gradients only; no script, foreignObject, event attrs, href/xlink, external refs, CSS url()), stored sanitized, served from `/api/agents/:id/avatar.svg` with `Content-Type: image/svg+xml`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`; UI renders it only via `<img>`, never inlined.

Draft 6 addendum (Drew, new conversation + agent inbox): "New" creates an empty conversation at once (`POST /api/conversations` with no participants; title NULL → shown "New conversation", auto-set from the first message, owner can rename). Sending a message with @mentions adds the mentioned registered agents in the same `tx()` (owner adds are immediate, R3-2). `GET /api/identities` lists registered agents for the @ picker. Agent inbox (NEW, needs a slice): `GET /api/inbox` for an agent session returns the conversations it participates in with unread counts since its cursor, mentions of it, and open asks addressed to it; `feed inbox` CLI reads it; adding an agent puts the conversation in its inbox from `joined_message_id`. Empty conversations with no messages are garbage-collected after 24 h. Owner can remove (boot) any participant: `DELETE /api/conversations/:id/participants/:agent` (owner only), same `tx()` writes a system message, releases the agent's claims, closes its open asks there (`state=closed, reason=removed`), and drops the conversation from its inbox; canSee stops at once (no history access after removal). Undo = re-add with `joined_message_id` = original (owner choice).

Draft 6 addendum (Drew, message kinds): a conversation holds two kinds of message: `text` (incl. voice/attachments) and `ask` (a feed item; Now is a cross-conversation view of open asks, each linking to its message). Status is NOT a message: it belongs to the agent (`agent_status`, per R3-6), shown in the conversation's right sidebar and the Agents list; no posting status into a conversation. Quick reply from Now posts a normal `text` message into the ask's conversation.

Draft 6 addendum (Drew, frontend stack): React + Vite + Tailwind v4 for the owner UI ("the mini apps should probably be built with React ... so it makes sense"). Tier 1 app kits = React components in the main bundle (no iframe). Tier 2 custom apps = sandboxed iframe whose HTML the agent supplies; a small React runtime + kit library may be offered inside the frame, served from the frame origin.

Draft 6 addendum (Drew, voice): the owner can record and send voice. Stored as an upload (`kind=audio`, opus/webm, ≤5 min, size cap) on a message with `body` = transcript. Agents read the transcript text; audio is for the owner. Transcription runs server side (engine TBD, needs Drew's call on local vs API). Now UI: Snoozed / Answered today folds sit collapsed above open asks (UI only, no schema change).

Draft 5 = draft 4 + the third and final review round (tags [R3-n]). Verdict: proceed.

Status: draft 4. Drafts 1–3 were stress-tested in two rounds (devil's advocate with measurements on node:sqlite; security review). Draft 4 applies Drew's model change:
- "just threads with N contributors" — no DMs, no channels, no sessions in the UI.
- Sessions are backend-only runtime leases; agents are stable identities.
- Tokens are opaque (no JWT).

Every earlier must-fix that still applies is kept and tagged [DA n] / [SEC Mn] / [R2-n]. Items made moot by the model change are listed in §18.
Serves: prototype v22 (https://claude.ai/artifact/LnrYoD8h78ZA5VW13Wh9zr).

## 0. Envelope and constraints

- One owner (Drew). ~10–20 stable agents. ≤200 agent process starts/day (sessions), ~50 live. ≤50k messages/day, ≤500 asks/day, ≤10 GB blobs.
- One box, one Node 24 process, `node:sqlite` 3.50.4. Measured ~500 write tx/s with fsync. No Redis/queue.
- Tailnet only via `tailscale serve`; bind 127.0.0.1; Host allow-list (421).
- Service as its own Unix user; data dir 0700, DB/blobs 0600; owner token via systemd `LoadCredential`. [SEC M12] (Deploy change → owner-approved step later.)
- Migrations: `PRAGMA user_version`, numbered, forward-only, refuse to boot on a newer version.
- All times are integer ms UTC in storage. Snooze presets computed by the server.

## 1. Core shape

- Each mutation = ONE synchronous transaction: domain rows + event row(s). `tx(fn)` throws if `fn` returns a thenable (an `await` inside BEGIN IMMEDIATE was measured to merge another request's write into the tx). Async work happens before/after, never inside. [DA 4]
- `events.seq` is the single order; the hub reads committed events after commit.
- Messages are append-only, except owner purge (§15).
- Durable events only for durable state changes. Status `doing`/progress, typing and app data are live-only pushes + a latest-value row. [DA 6]

## 2. Concepts

| Concept | User sees it? | What it is |
|---|---|---|
| Owner | — | Drew. Sees and can do everything. |
| Agent | Yes | Stable identity (assistant, devtool, orchardist…). Name, role, avatar, live status. One long-lived key. |
| Thread | Yes | The only conversation kind. Title, participants (agents), state, pinned/muted, optional link (issue/PR). |
| Ask | Yes | A question with options, posted in a thread; Now gathers open asks. |
| Session | No | A runtime lease: one agent process. Token, host, expiry, the thread it started for. Debug/audit only. |

- A former DM = a thread with one agent (pin it to make a "home").
- A former channel = a long-lived thread several agents post into.
- A former #ask question = a thread with no agent participant ("unassigned").

## 3. Identity, keys, sessions

### Tokens: opaque, not JWT
- One server with a DB, and revocation must be instant. A random 256-bit token, stored as SHA-256, looked up per request (µs in SQLite), revokes instantly with no key management or deny list. JWT adds signing keys and a deny list for no gain here.
- Prefixes for secret scanners: `fdk_` (agent key), `fds_` (session token), `fdo_` (owner).

### Owner [SEC M10, M11]
- Logs in once per device with the owner token → `sessions` row (owner devices only) + cookie `__Host-feed_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`), 30 d sliding, 90 d absolute; `last_seen` flushed ≤1/min.
- CSRF: every cookie-auth non-GET needs exact `Origin`, `Content-Type: application/json`, `X-Feed: 1`. No CORS.
- Step-up (owner token within 5 min): minting an invite, revoking an agent, sign-out-all, purge.
- Logout = POST: revoke row, close that device's streams, `Clear-Site-Data`.
- `/api/login` rate-limited with lockout. The owner Bearer works for the CLI only.

### Agents: invite = the prompt (Drew)
- Invite from a thread's "+ Add" or globally. It mints an enrollment code (128-bit, one-time, 15 min, hash stored, `target_thread` optional). The prompt carries it.
- `feed enroll` (code via stdin/env, not argv) + identity object → creates the AGENT, returns its key once. The CLI stores the key at `~/.secrets/feed/<agent>.key` (0600), never in the prompt/transcript. If `target_thread` is set, the agent joins that thread in the same tx.
- Name guards [SEC M3, M4; DA 13]:
  - Reserved names: `drew owner system all here everyone`.
  - Names are never reused; regex `^[a-z][a-z0-9-]{1,31}$`.
  - One uniform error; enroll rate-limited.
  - The owner gets a "new agent connected: X" Now item to confirm or revoke.
  - Map / null-prototype lookups.
- Re-issue key (owner, step-up) and `feed rotate`: mint a new key, replace the hash, close the old key's streams. No cascade. [R2-4]
- Revoke agent (owner, step-up): one tx — revoke key, end all its sessions, release claims, emit `agent_revoked`; the hub closes all its connections. [DA 7]

### Sessions (backend only)
- An agent process calls `POST /api/sessions {client_id, thread_id?, host}` with its key → a session token (12 h, renewed by use, max 7 d). The same `client_id` within 10 min returns the same session (retry-safe). [DA 13]
- A message is authored by the AGENT; `messages.session_id` is metadata for audit/debug only.
- "Live" = session `last_seen` within 15 min (in-memory, flushed ≤1/min); the 12 h token expiry is only the hard cap. A process that dies stops being live within 15 min. [R3-4]
- The 60 s ticker ends sessions that are expired or not live; nothing is shown to the user. Claims are NOT tied to one session (§7). [DA 7]
- Mint rate: ≤30 sessions/h per agent, besides the ≤20 live cap.
- Answers and history belong to the thread, so the next session of the agent picks them up. This replaces "deliver to parent" (no parents exist). [DA 8 superseded]
- Every request checks: key not revoked, session not expired/ended. Limit: ≤20 live sessions per agent.
- "Started by @orchardist" on a thread is a note (`threads.created_by`), not a permission. No spawn scope, no delegated tokens.

### Identity object
- Strict schema, unknown keys rejected: `name`, `role` (^[A-Za-z0-9 .,/()+_-]{0,80}$), `host` (≤80), `avatar` (letter + palette index). No URLs, no control/bidi/zero-width chars.
- A message-level identity `name` must equal the key's agent → else 403 (D-8).
- Profile changes ≤1/h, kept in `profile_history`, owner-visible event.

### Honest limit
- All agents on the box run as one Unix user, so one agent can read another's key file. Keys stop mistakes and outside misuse and give attribution; they don't isolate a compromised agent. Real isolation (one Unix user per agent, or keys in 1Password with per-agent access) is a later step.

## 4. Threads and participants

- `POST /api/threads {title?, text?, participants?:[agent], link?, client_id}`. Owner or any agent can create one. The title defaults to the first ≤60 chars of the first message.
- Access: ONE function `canSee(principal, thread, message_id | seq)` for reads, writes, live delivery and replay [R2-2]:
  - owner → every thread;
  - agent → a current participant, for messages with id ≥ its `joined_message_id` (live events by seq ≥ `joined_seq`);
  - any CONFIRMED agent → an UNASSIGNED thread (no agent participant): read its first message + metadata and list it, so it can claim. Ends when claimed. [R3-1]
- The creator (owner or agent) is a participant automatically.
- Adding [R3-2]:
  - Owner: @tag in the owner's own message, or "+ Add", adds at once (system line "Added @x").
  - Agent: only an explicit `POST /api/threads/:id/participants` (or `/add @x` command) creates a PENDING add, shown in the thread and in Now as "@a wants to add @b · Approve · Decline". A plain `@x` in agent text only notifies existing participants; tags in quotes/code never add.
  - Unconfirmed agents can't add or be added.
  - Loop breaker: after 20 agent messages in a row with no owner message, agent posts get 429 and the thread shows "Paused · agents talking to each other · Resume".
- History on add: `joined_message_id` = the id of the message that did the add (inclusive), so the added agent sees why. The owner may tick "share history" (`joined_message_id` = 0). Re-adding after a leave resets it. [R3-3]
- Removing: the owner removes anyone; an agent can `leave`. Same tx releases that agent's claim and open asks in the thread; its streams for the thread close at once.
- Mentions are parsed server-side only.
- State: `active` | `done`. Owner or a participant marks done; a new non-system message reopens it.
- Activity: `threads.last_activity_at` and `open_ask_count` are updated in the same tx as messages/asks; index `(state, last_activity_at)`. Older = `state='done' OR (last_activity_at < now-14d AND open_ask_count=0)`. [R3-7]
- Per-owner flags: `pinned_at`, `muted_at` on the thread row (single owner).
- Agent thread cap: ≤20 threads created per agent per day; ≤200 active threads where it is the creator.

## 5. Data model (migration 1)

```
agents(name PK, role, host, avatar, key_hash UNIQUE, created_at, created_via_device,
       revoked_at NULL, last_used_at, confirmed_at NULL)
profile_history(name, field, old, new, at)
enrollments(code_hash PK, created_at, expires_at, used_at NULL, used_by NULL, target_thread NULL, created_via_device)
devices(id_hash PK, created_at, last_seen, expires_at, absolute_expires_at, label, revoked_at NULL)   -- owner logins
sessions(id PK, agent, token_hash UNIQUE, client_id, host, thread_id NULL, created_at, last_seen,
         expires_at, max_expires_at, ended_at NULL, end_reason NULL, UNIQUE(agent, client_id))
threads(id INTEGER PRIMARY KEY, title, created_by, created_at, state active|done, done_at NULL, link NULL,
        last_message_id, last_activity_at, open_ask_count, paused_at NULL, pinned_at NULL, muted_at NULL)
        -- INDEX (state, last_activity_at) [R3-7]
participants(thread_id, agent, added_by, added_at, status active|pending, joined_message_id, joined_seq,
             PK(thread_id, agent))   -- pending = agent-requested add awaiting owner [R3-2, R3-3]
read_state(thread_id PK, last_read_message_id)                                           -- owner only [DA 14]
messages(id PK AUTOINCREMENT, thread_id, author, session_id NULL, kind text|ask|system|app,
         text, body_json, reply_to NULL, answers_ask NULL, client_id, created_at, purged_at NULL,
         UNIQUE(author, client_id))
mentions(message_id, agent, PK(message_id, agent))
asks(message_id PK, thread_id, asked_by_session, acked_at NULL, options_json, recommended_option NULL, reason NULL, allow_reply, app_id NULL,
     urgency, status open|answered|dismissed|snoozed, snooze_until NULL, answer_option NULL,
     answer_text NULL, answer_message_id NULL, updated_at)
claims(thread_id PK, agent, session_id, claimed_at, claim_version, lease_until)          -- unassigned threads
agent_status(name PK, state, doing, since, progress_json, next, links_json, app_id, updated_at)
apps(id PK, author, thread_id, kind ask|status|attachment, code, code_sha256, data_json, data_version, created_at)
uploads(id PK, uploader, blob_sha256, filename, mime_sniffed, size, width, height, created_at, message_id NULL)
blobs(sha256 PK, size, created_at)
unfurls(url_hash PK, url, status pending|ok|unavailable, attempts, site, title, description,
        kind generic|github_pr|github_issue, meta_json, fetched_at, refresh_after)
message_refs(message_id, thread_id, kind link|file|image|app|ask, ref, created_at)
messages_fts USING fts5(text, content='messages', content_rowid='id', prefix='2 3',
                        tokenize='unicode61 remove_diacritics 2')    -- insert, delete AND update triggers [R2-1]
threads_fts USING fts5(title, content='threads', content_rowid='id', prefix='2 3')   -- + insert/update/delete triggers
events(seq PK AUTOINCREMENT, type, thread_id NULL, subject, payload_json, created_at)
cursors(session_id PK, epoch, last_seq)   -- per session [R3-5]
settings(key PK, value)     -- log_epoch, pruned_through, unfurl allowlist
audit(at, actor, action, target, detail)
```

## 6. Asks

- Create in a thread: `{question, options:[{id,label}] 2–4, recommended, reason?, allow_reply, app_id?, urgency}`. `app_id` must have the same author and thread. [DA 15] ≤20 open asks per agent.
- Answer: `POST /api/asks/:id/answer {option_id, text?, client_id}` (option + optional edited text). [DA 9] Reply-only `{text}` when `allow_reply`.
- One answer: `UPDATE asks SET status='answered' … WHERE message_id=? AND status IN ('open','snoozed')`; changes()==0 → 409 with the winning answer. Text answer written as a message with `answers_ask` in the same tx.
- v1's `answerAsksBefore` is dropped; answering is explicit. [DA 9]
- Dismiss / undismiss / snooze `{preset}` / unsnooze. Same-state = 200 no-op. Snooze wake = real transition via the v1 timer. [DA 10]
- Delivery: `ask_answered` (payload carries `option_id`, `answer_text`) goes to the asking session first (`asks.asked_by_session`), and is visible to all agent participants of the thread. [R3-5]
- If that session is gone, the answer waits: `GET /api/me/state` returns the agent's answered asks with `acked_at IS NULL`; `POST /api/asks/:id/ack` sets `acked_at`. Exactly one session acks it.
- Cursors are keyed by SESSION (`cursors(session_id PK, epoch, last_seq)`), so one session can't consume another's events. [R3-5]

## 7. Unassigned threads (replaces #ask and the claim flow)

- A thread with no agent participant shows "Unassigned" (derived).
- `POST /api/threads/:id/claim` by an agent: conditional insert into `claims` + adds it as a participant + returns `claim_version`; second claimer → 409.
- The claim holder is the AGENT; `claims.session_id` is just the current holder session. A new session of the same agent takes over with `claim_version` (the version goes up). [R3-4]
- The reaper releases a claim only when NO session of that agent has been live for 15 min, then sends `lease_lost`. Mutations on claimed work carry `claim_version`. [DA 11]
- Tasks/kanban later = a view over threads: Unassigned → Claimed → Needs you (derived: open ask) → Done.

## 8. Agent status

- `PUT /api/status` (own row). Live push to the owner. A durable `agent_state_changed` event ONLY when `state` changes. Status is NOT written into threads (it would reopen done threads and flood activity); it shows on the agent's dot, card, Info Status tab and Now. [R3-6]
- `offline` derived: no live session for 15 min.
- Status app: `apps` kind status. `PATCH /api/apps/:id/data {data, if_version}`, author-only; the live push carries `{app_id, data_version}`.

## 9. Mini-apps [SEC M5, M6, M7]

"Talk to me in apps" (Drew): every ask should carry an app that shows its context (chart, map, image compare, diff, calendar, table). Two tiers:

- Tier 1, built-in app kits (the default, expected on every ask):
  - `{kit: chart|map|compare|diff|timeline|table|image|markdown, data}`.
  - Rendered by OUR trusted UI code from a validated JSON schema per kit. No agent code runs.
  - Fast, themed, accessible, and safe by construction.
  - Agents only produce data, so most context needs no custom code.
- Tier 2, custom code (the escape hatch): a sandboxed iframe, as below. Only when no kit fits.
- An ask without an app is allowed but discouraged: the CLI warns, and the UI shows a plain text card.
- Map kit: offline vector outlines shipped with the UI (world/regions) plus points/areas from the agent. Street-level tiles would need an owner-only tile proxy (later; the frame stays `connect-src 'none'`).
- Images in kits reference uploads (§10) by `upload_id`, never URLs.
- Kit data ≤256 KB, schema-validated on write (unknown keys rejected, strings length-capped, numbers finite).

Custom-code apps:
- `POST /api/apps {kind, thread_id, code ≤64 KB, data ≤256 KB}`.
- `GET /app-frame/:id`: auth + `canSee`; `Sec-Fetch-Dest: iframe`. CSP header:
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
  plus `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `nosniff`.
- iframe: `sandbox="allow-scripts"`, `allow=""`, `referrerpolicy="no-referrer"`; height 80–600 px; parent-drawn label "App from @name".
- Bridge assumes a hostile frame:
  - Messages accepted only when `event.source === frame.contentWindow`.
  - Accepted message types: `ready`, `resize{h}`, `select{option_id}`, with caps.
  - `select` only highlights an option; the parent's own button sends the answer, and only on a real click.

## 10. Attachments

Unchanged from draft 3:
- `POST /api/uploads`:
  - Streaming upload with sha256, 25 MB abort, timeouts, concurrency limits.
  - A `statfs` free-space floor (10%), and 507 on a full disk.
  - Magic-byte sniffing. Inline display only for png/jpeg/gif/webp. Bounded header parse, >50 Mpx not inline.
  - Content-addressed storage, with a per-sha lock covering rename+insert and GC. [DA 12]
- Bind with `UPDATE … WHERE uploader=? AND message_id IS NULL`, changes()==1.
- Serve `GET /api/files/:upload_id` only:
  - Auth plus `canSee` on the bound thread.
  - Headers: `nosniff`, `CSP: sandbox`, CORP same-origin, RFC 5987 filename, `private, immutable` (not overwritten by the global no-store).

## 11. Link unfurls [SEC M8, M9]

Unchanged from draft 3:
- Modes: `allowlist` (default: github.com + owner-listed domains) or `off`.
- Fetching: undici `Agent` with `connect.lookup` pinning, global-unicast-only allow rule plus the full deny list, every resolved address checked, `resolve4/6`.
- Hops and caps: ports 80/443, `redirect:'manual'` max 3 hops with every hop re-checked, one 5 s abort, `Accept-Encoding: identity`, 512 KB, `text/html` only.
- Parsing and GitHub: htmlparser2; GitHub via the API with regex-built URLs and a fine-grained read-only token.
- Who sees it: unfurl data goes to the OWNER only, and errors are a generic `unavailable`.
- Worker: concurrency 2, `attempts` cap of 3, one event per referencing message.

## 12. Read state, Now, Shared, search

- Owner unread: `read_state.last_read_message_id` vs `threads.last_message_id`; `POST /api/threads/:id/read {message_id}` only moves forward.
- `GET /api/now`: open asks (urgent, then newest) with thread title, summary counts, snoozed, dismissed/answered today, `as_of_seq`.
- Thread list: `GET /api/threads?view=pinned|active|older` — sorted by `last_message_id` desc; Older = done, or idle >14 d with no open ask.
- Shared: `GET /api/threads/:id/refs?kind=&q=` (LIKE over one thread's refs).
- Global search (owner), "super fast":
  - Targets: ≤16 ms to first results; ≤50 ms p95 server time at 1M messages (measured in slice 8 before the UI relies on it).
  - Agents, threads and recent items are searched in the client from data it already holds (no round trip). Thread titles also go through `threads_fts` for Older.
  - Messages: `messages_fts` (prefix indexes), bm25 then recency, LIMIT 20, `snippet()`. Input is quoted per token.
  - Filters: `from:@x` → author, `in:` → thread title, `is:ask`, `is:done`, `has:file|link` via `message_refs(kind)`.
  - One request per keystroke; the client aborts the previous one; at most one in flight per principal. A plain GET with no writes.

## 13. Realtime delivery [DA 1–3, SEC M13]

- Owner: SSE. Agents: long-poll.
- Cursor = `epoch:seq`. Random `log_epoch`; `pruned_through` in settings. Reset when the epoch differs, since < pruned_through, or since > max seq.
- Returned cursor = highest seq SCANNED: if rows < LIMIT then `MAX(seq)` in the same sync block, else the last row's seq; rows dropped by `canSee` still advance it. [DA 1, R2-6]
- Hub: index thread → waiters; a write wakes only matching waiters.
- Snapshots (`/api/now`, `/api/threads`, messages, `GET /api/me/state` for agents: my threads, my open/answered asks, my claims) return `as_of_seq`.
- On (re)connect: subscribe first, then a `live_snapshot` frame (all `agent_status` rows + app `data_version`s). [R2-3]
- Delivery re-checks `canSee` and token validity per event; replay uses the same filter. Revoke, removal, logout and session end close the affected streams.
- Limits: ≤3 streams/long-polls per principal, a global cap, 25 s heartbeat, backpressure via `desiredSize`.
- Retention 14 d, pruned in ~5k-row batches. [DA 5]

## 14. Limits and abuse

- Per agent: messages 1/s sustained (burst 20, 5k/day); uploads 60/h; URLs 30/min; asks 20 open, 60/h; threads 20/day; adds 30/h; sessions 20 live; profile 1/h.
- Per IP/principal: login, enroll, stream connects, search.
- Caps: text ≤16 KB, body ≤64 KB, ≤4 options, ≤10 attachments, ≤5 URLs, ≤20 participants per thread.
- Owner writes go first: agent budgets are checked before `BEGIN`.
- Rendering: textContent only; links http/https only, `noopener noreferrer`, host shown; global `Referrer-Policy: no-referrer`.

## 15. Operations

- Backups: `node:sqlite` `backup()` + blob copy; the job writes a fresh `log_epoch` into each snapshot. Restore drill documented. [DA 5, R2-7]
- Purge (owner, step-up): scrubs text/body, FTS row (update trigger), event payloads, unreferenced blobs; audit row.
- `/healthz` says only "ok"; details in owner-only `/api/admin/health`.
- JSON request logs (no bodies, no tokens). Graceful shutdown: close SSE with `retry`, checkpoint WAL.

## 16. Migration from v1 (PR #101, unmerged)

- v1 has no production data (PR #101 unmerged, never deployed): NO data migration. The code and tests are rewritten; the DB starts fresh. [R3]
- v1 `/api/conversations*` routes → `/api/threads*`. The CLI changes in the same slice. v1 tests are rewritten, not kept green, from slice 2 on (PR is unmerged; no external users).

## 17. Build slices (each: failing tests → code → live proof)

0. Foundations: migrations, `tx` thenable guard, ms storage, events table written in-tx, `threads` + `participants` tables (no read change).
1. Threads + cursors (merged, since `canSee` needs participants) [R3]: threads, adds (owner direct, agent pending), leave/remove, loop breaker, done/Older columns, pin/mute, read_state; `epoch:seq`, highest-scanned, resets, waiter index, `as_of_seq`, `canSee`; v1 conversations replaced; CLI.
2. (merged into 1)
3. Identity: owner devices + CSRF + step-up; invites (+ target thread), enroll, agent keys, confirm-on-connect; sessions as leases + expiry ticker; revoke/re-issue.
4. Asks v2 + unassigned threads + claims/leases.
5. Status (live-only + state-change events).
6. Apps.
7. Uploads + files.
8. Refs, Now, search (with the 1M-message benchmark).
9. Unfurls (own security test suite).
10. Ops: backup, prune, purge, health, audit.
11. UI (Svelte) against these contracts.
12. Tasks view over threads.

Deploy-side items (service user, `LoadCredential`, modes) need Drew's go-ahead.

## 18. Removed by the threads-only model

- DMs, lazy DM creation, channel create/naming rules, the #ask channel.
- Spawn scope, delegated sessions, parent cascades, the "memberships ∩ parent's" rule, root-ancestor quota keys, parent delivery of answers.
- Session names, suffixing, reserved `session`-kind identities, the Sessions rail group.

## 19. Decisions

Settled by Drew:
- Threads only.
- @tag adds.
- Invite = the prompt.
- No sessions in the UI.

Own calls, open for Drew to override:
- Agents can only REQUEST adds; you approve in one tap (Now + thread). Your own @tags add at once. (Review round 3 showed free agent adds allowed injected adds and agent loops.)
- Added agents see history from the message that added them; you can tick "share history".
- Loop breaker: 20 agent messages in a row without you → paused.
- Status changes don't appear in threads, only on the agent.
- Pin and mute replace DM "homes" and channels.
- Threads go to Older when done or idle >14 d.
- Opaque keys (no JWT); keys stored in `~/.secrets/feed/`.
- Unfurls: `allowlist` default.
- Tasks after the UI.
- Service runs as its own Unix user (deploy change later).
