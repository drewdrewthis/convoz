# Convoz — message types and mini apps (spec, companion to the design)

> **Status in draft 9.** Every edit in §8 (E-1…E-28) is applied in `docs/design.md` (design draft 9), with three adjustments: (1) E-5 and §3.15: the `ask_snoozed` reason is cut (DA review), and mentions, thread replies and activity now share **one conversation item per agent and conversation** whose reason is the highest seen (C-10); (2) E-19 precedence is `app_result` > `ask_resolved` > `mention` > `thread` > `activity` (`ask_resolved` moved above `mention`, so a custom answer that names the asker still resolves its ask); (3) E-4 and G-10: there is no CLI answer in v1, so `answer_via` is `inline` or `now` (C-3). I-50 is now a design invariant. The schemas live in `schemas/` at the repo root (mirrored into `packages/contracts/schemas/v1`). The text below is otherwise the original spec; where it says "draft 8" or "proposed", read "design draft 9" and "applied".


Status: draft 1. Date: 2026-10-16. Base: design draft 8 (its §8 edits are applied in `docs/design.md`, draft 9). Prototype: https://claude.ai/artifact/LnrYoD8h78ZA5VW13Wh9zr
Schemas: `schemas/` (JSON Schema 2020-12; checked with ajv 8.20.0, §9).

Owner asked: "is it clear the different types of messages and how apps are rendered/built?" Draft 8 was not clear. It has the columns but no catalogue, and no schema for `app_json`. This spec gives both. It changes no stored kind: `messages.kind` stays `text | ask | system`.

Conventions: as in draft 8. **DEFAULT (owner to confirm)** marks a call made without the owner; all are listed in §8.1. `M-n` = message type in this spec. `E-n` = proposed edit to draft 8 (§8).

---

## 1. Goal and non-goals

**Goal.** One place that says, for every message type and every mini app: who sends it, how it is stored, how it is created, how it renders on each surface, its limits, and what an agent gets. Plus exact JSON Schemas for `app_json`, the Tier-2 manifest, the Tier-2 bridge, app results and system lines.

**Non-goals.**
- No new stored `kind`. Types are derived from columns (§2.1).
- No E2E encryption, no change to the transport, inbox or auth model of draft 8.
- No maps, calendars or image-compare apps as separate Tier-1 types in v1 (prototype has them; see §4.9).
- No live-updating message apps. A posted app is immutable. Live state belongs in agent status (`agent_status.app_json`, same schema).
- No human-authored apps in v1. Only agents post apps (humans only send results).

---

## 2. The model in one page

### 2.1 Three stored kinds, ten variants, four modifiers

The DB keeps 3 kinds. Every reader (UI, push, search, `convoz read`, MCP) derives exactly **one variant** per message with this fixed order (first match wins), plus any **modifiers**:

| Order | Variant | Rule (columns) |
|---|---|---|
| 1 | `deleted` (sub-state `purged`) | `deleted_at IS NOT NULL` (`purged_at` set → purged) |
| 2 | `system` | `kind = 'system'` |
| 3 | `ask` | `kind = 'ask'` (an ask may carry a display app; it stays `ask`) |
| 4 | `answer` | `answers_ask_id IS NOT NULL` |
| 5 | `via_app` | `via_app_message_id IS NOT NULL` |
| 6 | `app` | `app_json IS NOT NULL` |
| 7 | `voice` | one bound upload of kind `audio` |
| 8 | `image` | ≥1 bound upload, all kind `image` |
| 9 | `file` | ≥1 bound upload, any kind `file` |
| 10 | `text` | none of the above (`format` = markdown, markdownv2 or plain) |

| Modifier | Rule | Applies to |
|---|---|---|
| `reply` | `thread_root_id IS NOT NULL` | text, ask, voice, image, file, app, via_app, answer |
| `broadcast` | `broadcast = 1` (also shown in main) | same as reply |
| `edited` | `edited_at IS NOT NULL` | text, voice, image, file (body only) |
| `unfurl` | body has an `http(s)` URL and unfurls are on | text, voice, image, file, app, via_app |

So the catalogue in §3 has **14 entries**: 10 variants (M-1…M-10) + 4 modifiers (M-11…M-14). System lines have **12 subtypes** (§3.4).

### 2.2 Who sends what

| Variant | Owner | Member | Guest | Agent (lease) | System (server) |
|---|---|---|---|---|---|
| text | ✓ | P | P | P + `post` | — |
| ask | ✗ | ✗ | ✗ | P + `ask` | — |
| answer | ✓ (by answering) | P | ✗ | ✗ | — |
| system | ✗ | ✗ | ✗ | ✗ | ✓ |
| voice, image, file | ✓ | P | P | P + `post` + `upload` | — |
| app | ✗ | ✗ | ✗ | P + `post` (DEFAULT: agents only) | — |
| via_app | ✓ | P | P | ✗ (403) | — |
| deleted | own, or any (owner) | own | own | own | purge/scrub |

P = only as an active participant. Same matrix as draft 8 §2.3, plus the two app rows (E-17).

### 2.3 One plain-text projection for every non-visual surface

A single function `Project(m, form)` turns a message into plain text. It feeds: push body, rail preview, search index (FTS), search snippet, `convoz read`, MCP output, `brief`, export, screen-reader label of collapsed cards, and the "old client" fallback. Go owns it on the server (`internal/server/message/project.go`); TS has a twin for offline rail previews. Both run the same fixtures (`packages/contracts/fixtures/projection/*.json`) (E-21).

- `short`: ≤140 chars, one line, for push and rail.
- `long`: ≤4000 chars, multi-line, for `convoz read`, MCP, FTS, export.

Rules per variant are in each M-n entry, row "Plain-text fallback".

---

## 3. Message catalogue

Each entry uses the same rows. "Desktop" = 1280×940 layout, "Phone" = 390×844 layout (draft 8 test sizes). "Agent inbox" = what the hydrated inbox item (§3.15) and `convoz read` show to an agent.

### M-1 Text (Markdown, MarkdownV2, plain)

| Row | Spec |
|---|---|
| Who sends | Owner, member, guest (P), agent (P + `post`). |
| DB | `kind='text'`; `format` ∈ `markdown` (default) \| `markdownv2` \| `plain`; `body`; `mentions` rows; FTS row = `Project(long)`. All app/upload/answer columns NULL. |
| Create | `POST /api/conversations/:id/messages {client_id, body, format}`. CLI `convoz post <conv> [--format markdownv2] <text\|->`. MCP `post {conversation, text, format?}`. |
| Markdown | CommonMark + GFM subset: emphasis, strike, inline code, fenced code, block quote, lists, GFM task lists (read only), autolinks, tables. Raw HTML stays visible text. Links: `http`, `https`, `mailto` only, after entity decoding (I-45). Images only from own uploads (`/api/files/…`), else shown as a link. |
| MarkdownV2 | Telegram MarkdownV2: `*bold*` `_italic_` `__underline__` `~strike~` `\|\|spoiler\|\|` `` `code` `` ```` ```pre``` ```` `[text](url)` `>quote`, backslash escapes. No headings or lists. An opener without a closer stays literal (prototype rule). Why: agents that already speak the Telegram Bot API post with no conversion. |
| Plain | No parsing. Newlines kept. |
| Desktop | Bubble with author header (grouped when the same author posts again); code blocks scroll sideways; spoiler hidden until click; external links show their real host. |
| Phone | Same, full width; tap targets ≥44 px; spoiler tap to reveal. |
| Notification | Only for `mention` (and `thread_reply` when a reply, M-11). Title "@author in <conv>"; body = `Project(short)`; obeys `notify.previews`. |
| Search | FTS of `Project(long)`. Result row: avatar, @author, conversation, time, snippet with match. Spoiler text is not indexed (DEFAULT). |
| `convoz read` | `#9100 05:52 @devtool  Milestone 1 status:` then the body as plain text, indented 6 spaces. |
| Plain-text fallback | Markers stripped; link → `text (host)`; image → `[image]`; spoiler → `[spoiler]`; mention kept as `@handle`; task list kept as `- [x] Server`. |
| Limits | `body` ≤16 384 chars (DB counts characters); ≤50 mentions (DEFAULT). Agent: 1/s, burst 20 (§13.1). |
| Agent inbox | `activity` (coalesced per conversation) or `mention`. Item shows `variant:"text"`, `format`, `text` = `Project(long)` cut to 500 chars with `truncated:true`. `convoz read --json` adds raw `body` + `format`. |

### M-2 Ask

| Row | Spec |
|---|---|
| Who sends | Agent participant with `ask` scope only. |
| DB | `messages.kind='ask'`, `body=''`; `asks` row (question ≤500, `urgent`, state machine §8.1 of draft 8); `ask_options` idx 0 = recommended, 1–4 = alternatives, each `label` ≤120 and `why` ≤280; sealed. Optional `app_json` (display types only, §4.1). FTS = question + option labels + whys. |
| Create | `POST /api/asks {conversation_id, thread_root_id?, client_id, question, recommended{label,why}, alternatives[{label,why}], urgent, app?}`. CLI `convoz ask <conv> --question Q --recommend L --why W --alt L --alt-why W … [--urgent] [--thread root] [--app file]`. MCP `ask`. |
| Desktop | Card: question; recommended button (accent, Enter); alternative buttons (A); "Why" line under each; custom reply field; Dismiss; Snooze menu; urgent badge. If the ask has an app, the app sits between question and buttons. Choices inside the app only highlight; only card buttons answer (prototype rule). After resolution: status line "You chose X · 5:58" and buttons go away. Also listed in Now. |
| Phone | Same card, buttons stack full width at 44 px; app collapsed to its preview card (tap to open full screen). Now is the home tab. |
| Notification | `ask` or `ask_urgent` (bypasses quiet hours). Title "@devtool asks"; body = question (short). |
| Search | `is:ask`; result row shows a state chip (Open, Answered, Dismissed, Closed). |
| `convoz read` | `#9050 04:30 @devtool  [ask open] Which runner should I compare first?` then `  * Built-in (recommended) — why…` / `  - vitest — why…`. After answer: `[ask answered: vitest]`. |
| Plain-text fallback | short: `Ask: <question>`; long: question, then each option with its why. |
| Limits | 2–5 options; 20 open asks and 60/h per identity; app ≤64 KB and display types only. |
| Agent inbox | The asker gets no item for its own ask. It gets `ask_resolved` (answered, dismissed, closed by someone else); a snooze makes no item (draft 9). Item carries `ask:{message_id, state, chosen_kind, chosen_index, label_or_text}`. |

### M-3 Answer

| Row | Spec |
|---|---|
| Who sends | A human with the answer right (owner; member P). Created as a side effect of answering. |
| DB | `kind='text'`, `format='plain'`, `answers_ask_id` set; `body` = chosen label, or the custom text (≤4000). Placed in the ask's thread if the ask is a reply, else main. The answerer's cursor does not move (I-15). Ask row gets `chosen_*`, `resolved_*`, `answer_via`. |
| Create | `POST /api/asks/:id/answer {choice: recommended\|alternative\|custom, index?, text?, if_version?, client_id}`. No agent CLI/MCP (agents cannot answer). Not through `POST …/messages` (400 `use_ask_answer`). |
| Desktop / Phone | A compact owner bubble "Answered: vitest" (or "Replied: …") with a link chip to the ask. |
| Notification | None (the human sent it). |
| Search | Indexed as `Answered: <label>`; filter `is:ask` does not match answers. |
| `convoz read` | `#9060 06:01 owner  [answer to #9050] vitest` |
| Plain-text fallback | `Answered: <label>` or `Replied: <text>`. |
| Limits | Custom text ≤4000 chars. Not editable (decision record). Delete allowed (tombstone; the ask decision is kept). |
| Agent inbox | `ask_resolved` for the asker (not `activity`, see precedence §3.15). |

### M-4 System line

| Row | Spec |
|---|---|
| Who sends | Server only, inside the tx of the action that caused it. |
| DB | `kind='system'`, `author_id NULL`, `body=''`, `system_json` (schema `system.json`, ids and enums only, ≤2048 B). Not in FTS. Not a thread root. Never counts as unread (I-14). |
| Create | No route. Written by: add/mention, pending-add request, remove, leave, identity disable, rename, trash restore. Old conversations may also hold `conversation.paused` and `conversation.resumed` lines; nothing writes new ones (issue 117). |
| Desktop / Phone | Centred muted line, no avatar, time on hover (desktop) or long-press (phone). Text built at render time from the subtype template and the current identity names (so a rename never leaves stale text). `member.requested` renders as a card with the agent profile (prototype "agent" app) and, for humans with the approve right, Approve / Decline buttons; after the decision the card shows "Approved · @x added" or "Declined". |
| Notification | Only `member.requested` (reason `agent_add`). |
| Search | Not indexed. |
| `convoz read` | `#9001 04:10 ·· Added @devtool (by owner, via mention)` |
| Plain-text fallback | The template text. |
| Limits | ≤2048 B JSON. |
| Agent inbox | `membership` for the subject of `member.*` lines. Other system lines create no item. |

### M-4a System subtypes (12)

| `t` | Fields | Template (render) | Written by |
|---|---|---|---|
| `member.added` | identity, by, via (`mention`\|`add`\|`create`), history? | "Added @x" (+ " · full history" when `history=full`) | @mention by a person or an agent (I-18; the line reads "@by added @x"), + Add, human-created conversation |
| `member.requested` | identity, by (agent) | "@by wants to add @x" + Approve/Decline card; this line is where the agent's seat starts on approval (I-17); it reads the whole history | agent add request, agent-created conversation |
| `member.removed` | identity, by | "@x was removed" | remove (I-19) |
| `member.left` | identity | "@x left" | leave |
| `member.disabled` | identity | "@x was disabled" | identity disable (asks there → `closed(agent_revoked)`) |
| `conversation.renamed` | by | "@by renamed the conversation" (current title shown in header) | title change |
| `conversation.paused` | streak (=20) | "Paused after 20 agent messages in a row." | old lines only: the loop breaker was removed (issue 117) |
| `conversation.resumed` | by | "@by resumed the conversation" | old lines only (issue 117) |
| `conversation.restored` | by | "@by restored this conversation from Trash" | restore |

Approve and decline do not write a new line. They change the `member.requested` card state (prototype behaviour). Schema: `schemas8.De4x/system.json`.

### M-5 Voice note

| Row | Spec |
|---|---|
| Who sends | Humans (in-app recorder). Agents may post an audio file through the same path (rare). |
| DB | `kind='text'`, `body` = optional caption (usually ''); exactly **one** bound upload, `kind='audio'`, `serve_inline=1`, `duration_ms` ≤300 000; proposed `uploads.waveform` (≤64 peaks, set by the recording client; E-3); `transcripts` row (`pending → done\|failed`). DEFAULT: a voice message carries no other upload. FTS = caption + transcript (re-indexed in the transcript tx; E-21). |
| Create | `POST /api/uploads {kind:"audio", filename, size, sha256}` → resumable `PATCH` chunks (uploading starts while recording) → `POST …/messages {upload_ids:[id]}`. CLI `convoz post <conv> --file note.m4a`. MCP `post {files:[path]}`. |
| Desktop | Player: play/pause, 30-bar waveform from `waveform`, time "0:14"; "Transcript" disclosure (prototype). Pending transcript shows "Transcribing…". |
| Phone | Same, 44 px play button; plays through the page `<audio>`; background play stops on lock (iOS PWA limit). |
| Save-Data / slow | No audio fetch until play (waveform comes from the row, so it shows without a fetch). |
| Notification | Title "@author in <conv>"; body "Voice note · 0:14" (transcript is not ready at push time). |
| Search | Transcript text is searchable; result row "Voice note · 0:14" + transcript snippet. |
| `convoz read` | `#9020 04:20 owner  [voice 0:14] Start with the ask state guard, then the feed CLI…` or `[voice 0:14] (transcript pending)`. |
| Plain-text fallback | `Voice note 0:14: <transcript>` (or without the transcript). |
| Limits | 25 MB, 300 s, allow-listed audio types only (I-44). |
| Agent inbox | Item text = the transcript. DEFAULT: an item for a voice message is held (proposed `inbox_items.not_before` = now + 120 s) until the transcript is done or the wait ends, so agents get the words, not "pending" (E-5). |

### M-6 Image

| Row | Spec |
|---|---|
| Who sends | Humans and agents (`upload`). |
| DB | `kind='text'`, body = caption; 1–10 bound uploads `kind='image'`, `serve_inline=1` only for png/jpeg/webp/gif after sniffing and the pixel cap (≤40 MP, ≤16k a side). Other image types (svg, heic) are `file` (M-7). |
| Create | Upload, then `POST …/messages {body, upload_ids}`. CLI `convoz post <conv> --file a.png [--file b.png] <caption>`. MCP `post {files}`. |
| Desktop | 1 image: up to 360 px wide; 2–4: grid; 5–10: grid + "+N". Click opens the lightbox. `alt` = file name (agents should caption). |
| Phone | Full-width grid; tap opens a full-screen viewer with swipe. |
| Save-Data / slow | Placeholder with size and "Tap to load" (§12.3 rule). v1 has no thumbnails; originals load on tap (gap G-7). |
| Notification | Body "Image · error-rate.png" (`full` previews) or "Image". |
| Search | `has:file`; caption and file names are indexed; Shared tab "Images". |
| `convoz read` | `#9015 06:12 @night-watch  Error rate during the deploy window. [image error-rate.png 86 KB id=Abc…]` |
| Plain-text fallback | `<caption> [Image: error-rate.png]` or `[3 images]`. |
| Limits | ≤10 uploads, 25 MB each, 500 MB/day per identity. |
| Agent inbox | Caption + `uploads:[{id, kind, name, size, width, height}]`. Agents fetch bytes with `GET /api/files/:id` (canSee). |

### M-7 File

| Row | Spec |
|---|---|
| Who sends | Humans and agents. |
| DB | As M-6 with `kind='file'`, `serve_inline=0`. |
| Create | As M-6. |
| Desktop / Phone | Attachment row: type icon, name, size, Download (always `Content-Disposition: attachment`, `nosniff`, sandbox CSP; I-44). Never previewed inline (no PDF viewer in v1). |
| Notification | Body "File · deploy-5-29.log". |
| Search | `has:file`; file name indexed; Shared tab "Files". |
| `convoz read` | `[file deploy-5-29.log 48 KB id=…]` |
| Plain-text fallback | `<caption> [File: deploy-5-29.log, 48 KB]`. |
| Limits | 25 MB each, ≤10 per message. |
| Agent inbox | As M-6. |

### M-8 App message

| Row | Spec |
|---|---|
| Who sends | Agents (`post`). DEFAULT: humans cannot post apps in v1. |
| DB | `kind='text'` (or `ask`, M-2), `app_json` (schema `app.json`, canonical JSON ≤65 536 B), `body` = the message text. Uploads bound to the message are exactly the ones the app references (gallery images, the Tier-2 bundle). FTS = body + app title + fallback. |
| Create | `POST …/messages {client_id, body, app, upload_ids?}`. CLI `convoz post <conv> --app app.json [--app-data data.json] <text>`. MCP `post {conversation, text, app}`. Dry run: `POST /api/apps/validate` / `convoz app validate` / MCP `app_validate`. Details in §6. |
| Desktop | Text, then the app card: header "App from @x · <title>" (+ "App" tag), the component inline at `min(content, height hint, 600 px)`, an Expand button (key O) that opens it in the side panel (prototype `openApp`). Tier 2: preview card first (§5.6). |
| Phone | Tier 1 inline, max height `min(hint, 70vh)`; Expand opens a full-screen sheet with a Close button. Tier 2: preview card; Open → full-screen sheet. |
| Save-Data / slow | Tier 1 props ≤4 KB come inside the message page and render at once; bigger props are a stub until tapped or scrolled into view on a fast link (E-23). Gallery images follow the image rule. Tier 2 never auto-loads (§5.6). |
| Notification | Normal triggers only. Body = `App: <title> — <fallback>` (short). |
| Search | `is:app`; title + fallback indexed; result row shows an "App · <title>" chip. Shared tab "Apps" (prototype). |
| `convoz read` | `#9123 05:45 @night-watch  Post-deploy report for box-3… [app frame "Deploy report" v1.0.0]` then the fallback indented. `--json` includes the full `app`. |
| Plain-text fallback | `[App: <title>] <fallback>`. An old client or a failed client validation shows the same as a card with "Update Convoz to view this app" (§4.3). |
| Limits | §4.2 budget table. Agent message rate as M-1. |
| Agent inbox | `variant:"app"`, `app:{type, v, title, fallback}`; full props only with `convoz read --json` (keeps items small). |

### M-9 via_app (a reply sent through an app)

| Row | Spec |
|---|---|
| Who sends | A human (owner; member/guest P) through a host gesture: one tap on a Tier-1 picker option, the host Send button of a multi picker or select checklist, or Send in the host confirm sheet (form, Tier 2). Leases get 403 (SEC-5, I-46). |
| DB | `kind='text'`, `format='plain'`, `body` = result summary (≤280); `via_app_agent_id` = **the app message's author** (server-derived, never from the body); `via_app_message_id` = the app message; proposed `app_result_json` (schema `app-result.json`, ≤4096 B; E-1). Placed in the app message's thread (or main). Proposed trigger checks target and author (E-2). |
| Create | `POST …/messages {client_id, via_app:{message_id, result:{v,source,summary,value}}}`. No CLI/MCP (humans only). The server re-validates the result against the target app (§4.4). |
| Desktop / Phone | Owner bubble with a label "via app by @devtool" and a link "from Runner picker" (I-46). The app card shows "Picked vitest via app." for the latest result by this viewer (prototype). |
| Notification | None to the sender. Agents are told through the inbox. |
| Search | Body indexed; result row shows "via app". |
| `convoz read` | `#9124 06:23 owner (via app by @devtool, from #9123)  Picked vitest` + `  result: {"selected":["vitest"]}` |
| Plain-text fallback | `<summary> (via app by @x)`. |
| Limits | summary ≤280; value ≤4096 B; ≤10 results per frame session; not editable. |
| Agent inbox | Proposed reason `app_result` for `via_app_agent_id` (one item per result, never coalesced; E-5), with `via_app:{agent, message_id, result}`. Other agents get normal `activity`. |

### M-10 Deleted and purged

| Row | Spec |
|---|---|
| Who | Author (own message), owner (any). Purge: owner with single-use step-up. Delete-my-data: the user's own messages. |
| DB | Delete: `deleted_at`, `deleted_by`; proposed: FTS row removed in the same tx; body, app and uploads are kept until purge but **never served** (files 404) (E-16). Purge: scrub per draft 8 §14 plus `app_result_json` and `waveform` (E-16). An ask that is deleted while open → `closed(deleted)`. |
| Create | `DELETE /api/messages/:id` · `POST /api/messages/:id/purge` (O S). CLI: none in v1 for agents' own deletes (DEFAULT; MCP has no delete). |
| Desktop / Phone | Tombstone "Message deleted" in muted italics-free text, no author content; a thread root tombstone keeps its replies under it. |
| Notification | Already-shown pushes cannot be recalled (draft 8 §14). |
| Search | Not returned. |
| `convoz read` | `#9030 05:00 @devtool  [deleted]` |
| Plain-text fallback | `Message deleted`. |
| Agent inbox | No item. Hydration of an older item returns the tombstone. |

### M-11 Thread reply (modifier `reply`)

| Row | Spec |
|---|---|
| Who sends | Anyone who may post in the conversation. Asks and apps may be replies. |
| DB | `thread_root_id` = a top-level, non-system message in the same conversation (composite FK, I-8); root `reply_count`, `last_reply_id`, `last_reply_at`; `thread_reads` row = involvement. |
| Create | `POST …/messages {thread_root_id}`. CLI `convoz reply <message> <text>`. MCP `reply {message, text, app?}`. |
| Desktop | Root shows "N replies · 5m ago" + avatars; click opens the thread panel on the right (380 px). |
| Phone | Thread opens as a full-screen view with a back button. |
| Notification | `thread_reply` only for involved humans (root author, replied, mentioned). |
| Search | Result row says "in thread of <root snippet>". |
| `convoz read` | Default view shows main only plus `[3 replies, last #9104]` on roots; `--thread <root>` prints the thread. Reply lines carry `[thread #root]`. |
| Plain-text fallback | Same as its variant, prefixed `↳ ` in the rail preview (DEFAULT). |
| Agent inbox | `thread` only when the agent is involved; it joins the one conversation item (draft 9, C-10). |

### M-12 Broadcast reply (modifier `broadcast`)

| Row | Spec |
|---|---|
| Who sends | As M-11, with `--broadcast` or the API flag. The web has no "Also send to conversation" box (owner, 2026-10-18: replies stay in the thread; the root shows a reply chip and a peek of the last reply). |
| DB | One row, `broadcast=1`, `in_main=1` (virtual). Read in the thread → read in main (I-14). |
| Create | `POST …/messages {thread_root_id, broadcast:true}`. CLI `convoz reply <message> --broadcast <text>`. MCP `reply {broadcast:true}`. |
| Desktop / Phone | In main: small header "replied to a thread: <root snippet>" above the bubble; in the thread: normal reply. |
| Notification | As M-11; a broadcast also counts for `activity`-style unread in main. |
| `convoz read` | Shown in main with `[also in main, thread #root]`. |
| Agent inbox | One item per (identity, message), precedence §3.15: involved agent → `thread`; others → `activity`. |

### M-13 Edited (modifier `edited`)

| Row | Spec |
|---|---|
| Who | Author. Humans any time (draft 8); agents ≤24 h, 30 edits/h. |
| What can change | `body` and `format` only. Not editable: asks (I-10), answers, via_app, system, deleted. Apps and attachments are immutable (DEFAULT). |
| DB | `edited_at`; the previous `body`/`format` → `message_edits`. FTS row replaced in the tx. Mentions do **not** change: an edit never adds a participant or creates a mention, inbox item or push (DEFAULT; E-18). |
| Create | `PATCH /api/messages/:id {body, format, client_id}`. CLI/MCP: none in v1 (DEFAULT; draft 8 §17 Q12 still open). |
| Desktop / Phone | "(edited)" after the time; click/tap opens the edit history for anyone who canSee the message (DEFAULT). |
| `convoz read` | `[edited]` marker; `--json` has `edited_at`. |
| Agent inbox | No new item. A later `read` returns the new text. |

### M-14 Link unfurl (modifier `unfurl`)

| Row | Spec |
|---|---|
| Who | Any message with an `http(s)` URL when unfurl mode is `allowlist` and the host is allowed (draft 4 §11). |
| DB | Nothing on the message. `unfurls` row per URL (`generic`\|`github_pr`\|`github_issue`), fetched by the unfurl worker with the SSRF rules. Only the **first** URL of a message gets a card (prototype). |
| Create | Implicit at post. The post tx inserts `unfurls(url_hash, status='pending')` (no network in the tx); the worker fetches after commit. |
| Read path | Proposed `GET /api/messages/:id/unfurl` (canSee on the message, so no one can probe URL hashes) → `{status, kind, site, title, description, meta}` (E-8). The client asks once when the card is visible, and once more after 3 s while `pending`. |
| Desktop / Phone | Card under the bubble: site letter, domain, title, description (2 lines); GitHub kinds show repo, number and state (Open/Merged). Phone: full width. |
| Save-Data / slow | No card fetch until tap (§12.3). |
| Who sees cards | Humans who canSee the message. DEFAULT: agents get the URL only, never fetched content, so the server never relays third-party content to agents. |
| Search | `has:link` (FTS on http/https tokens); unfurl titles are not indexed. |
| `convoz read` | The URL stays in the text. |

### 3.15 What an agent sees: the hydrated inbox item

One item per (identity, message); when two reasons apply, the strongest wins: `app_result` > `ask_resolved` > `mention` > `thread` > `activity` (E-19 as applied in draft 9). Mentions, thread replies and activity share one coalesced conversation item per (identity, conversation), which carries the newest message, `count`, `mention_count` and the highest reason (C-10).

```json
{
  "id": 5512, "reason": "app_result", "count": 1,
  "conversation": { "id": 17, "title": "issue-100" },
  "thread_root_id": 9031,
  "message": {
    "id": 9124, "variant": "via_app", "kind": "text", "author": "@owner", "at": 1760600580000,
    "text": "Picked vitest (via app by @devtool)", "truncated": false,
    "via_app": { "agent": "@devtool", "message_id": 9123,
      "result": { "v": 1, "source": "picker", "summary": "Picked vitest", "value": { "selected": ["vitest"] } } }
  }
}
```

Other variants put their extras in the same `message` object: `ask:{…}`, `app:{type,v,title,fallback}`, `uploads:[{id,kind,name,size,duration_ms?,transcript?}]`, `system:{t,…, text}` (rendered template), `answers_ask_id`, `edited_at`, `deleted:true`. Text is always `Project(long)` cut to 500 chars. The item never holds a secret (I-42).

---

## 4. Tier 1 apps (host-rendered components)

### 4.1 Envelope and component list

Every `app_json` is one envelope (schema `app.json`):

```json
{ "v": 1, "type": "<component>", "title": "≤80, optional", "fallback": "1–2000 chars, required", "height": 80–600, "props": { … } }
```

| `type` | What it is | Viewer can act? | Allowed on an ask? | Schema |
|---|---|---|---|---|
| `chart` | `kind` line, bar (optionally stacked) or spark; ≤8 series × ≤500 points; ref lines (e.g. "Cap 2M a day"); tone tokens, never raw colours | No | Yes | `components/chart.json` |
| `table` | ≤12 columns × ≤200 rows, cells text ≤200 / number / null; sortable; highlight row | No (sort is local) | Yes | `components/table.json` |
| `checklist` | ≤50 items; `mode` view (read only) or select (tick + host Send → result) | select only | view only | `components/checklist.json` |
| `kv` | ≤40 key-value pairs, 1 or 2 columns, tone per value | No | Yes | `components/kv.json` |
| `picker` | 2–12 options; single (one tap sends) or multi (ticks + host Send, min/max) | Yes | **No** (400 `app_type_not_allowed_on_ask`) | `components/picker.json` |
| `form` | ≤12 fields: text, textarea, number, select, toggle, date; Submit → host confirm sheet → Send | Yes | **No** | `components/form.json` |
| `progress` | bar (0..1 or done/total) and/or ≤10 steps (todo, doing, done, failed, skipped), ETA | No | Yes | `components/progress.json` |
| `code` | `mode` code (highlighted, start line) or diff (unified diff, multi-file); ≤48 KB, ≤2000 lines | No (copy button) | Yes | `components/code.json` |
| `gallery` | 1–10 images from **this message's** uploads; layout grid, carousel or compare (exactly 2, before/after slider) | No | Yes | `components/gallery.json` |
| `frame` | Tier 2 sandboxed app (§5) | Results only if `manifest.results` | Yes, results only highlight an option | `components/frame.json` |

DEFAULT: one component per message in v1 (no nesting or stacks). Post two messages, or use Tier 2, for a combined view.

### 4.2 Size budget

| Item | Cap | Where enforced |
|---|---|---|
| `app_json` total | ≤65 536 B canonical JSON | schema-adjacent check (Go) + DB CHECK |
| `fallback` | 1–2000 chars | schema |
| `title` | ≤80 chars, one line | schema |
| strings | each field has its own cap (24–280 chars one line; code text 48 KB) | schema |
| numbers | finite, \|x\| ≤ 1e15 | schema |
| ids | `^[a-z0-9][a-z0-9_-]{0,31}$`, unique per list | schema + semantic |
| inline in the message page | props ≤4 KB ride in the page; bigger props are a stub `{type,v,title,fallback,bytes}` fetched by `GET /api/messages/:id/app` (E-8, E-23) | server |
| Tier-1 kit chunk | lazy, ≤60 KB brotli (DEFAULT) | `size-limit` |
| render | ≤16 ms per component at max props on the phone profile; line charts over 400 points are downsampled (LTTB) for drawing, full data in the a11y table | perf test |

### 4.3 Versioning and the unknown-key policy

- `v` versions the **whole** envelope and every component together. v1 is frozen once S7 ships.
- **Unknown keys are rejected** at every level (`additionalProperties: false`). Why: a typo (`colour`) fails loudly at post time instead of rendering wrong, and nobody can smuggle data past review. New keys or types → `v: 2`.
- The server accepts every `v` it knows and rejects others with 400 `app_version_unsupported` + `supported:[1]`. The server is updated before clients, so a stored app never has a `v` the server does not know.
- **Old clients:** the client validates again before render (§7). Unknown `v`, unknown `type`, or any validation error → it renders the `fallback` as a card with "Update Convoz to view this app". It never renders part of an app.
- Old stored apps never change. Every client keeps the v1 renderers.

### 4.4 Semantic checks (beyond JSON Schema; same list in Go and TS)

1. chart: every `values` length = `x.labels` length when `x` is set; `y.min < y.max`.
2. table: every row has `columns.length` cells; `highlightRow < rows.length`.
3. checklist, picker, form: ids unique; picker `1 ≤ min ≤ max ≤ options`; checklist `minChecked ≤ items`; form select `default` ∈ option ids; number `min ≤ max`.
4. progress: `done ≤ total`.
5. code: ≤2000 lines.
6. gallery: every `upload` is bound to this message, kind `image`, `serve_inline = 1`.
7. frame: `bundle.upload` bound to this message, kind `app`, stored SHA-256 and size equal `bundle.sha256`/`bundle.size`; `data` ≤32 768 B.
8. The message's bound uploads are exactly the ones the app references.
9. On an ask: type is not `picker` or `form`, checklist is not `select`.
10. Results (`app-result.json`): `source` = the app's type; picker ids ⊆ options and count within min/max (exactly 1 when single); checklist ids ⊆ items and count ≥ `minChecked`; form keys ⊆ field ids, required fields present, each value matches its field kind and limits; frame value ≤4096 B and the frame's manifest has `results: true`; the target is not deleted and the sender canSee it.

### 4.5 How results are sent (Tier 1)

| Component | Gesture | Confirm sheet? | Result |
|---|---|---|---|
| picker, single | tap an option (host button) | No: the tap is the host gesture | `{selected:[id]}`, summary "Picked vitest" |
| picker, multi | tick, then host Send | No | `{selected:[…]}`, "Picked docs, search" |
| checklist, select | tick, then host Send | No | `{checked:[…]}`, "Checked 3 of 4: …" |
| form | fill, Submit | **Yes**: shows every value; Send or Cancel | `{fields:{id:value}}`, "Start 3 UTC, Lanes: All lanes, …" |

The host builds the summary. The picker card then shows "Picked vitest via app." (latest result by this viewer). Picking again sends a new via_app message. Undo = delete that message.

### 4.6 Rendering rules (all Tier 1)

- Rendered by our React components in `packages/app-kit`. Text is set as text nodes only; no `innerHTML`, no markdown parsing in app strings, no links in v1.
- Colours come from `tone` → theme tokens, so contrast (≥4.5:1) holds in every palette and theme.
- Every component has a text alternative: charts get `aria-label` (title) plus a visually hidden data table; tables are real `<table>`; picker options are buttons with `aria-pressed`.
- Desktop hit targets 28 px, phone 44 px (prototype `hit`).
- Tooltips: hover on desktop, tap on phone.
- Expand (key O on desktop) opens the side panel / full-screen sheet with the larger plot height (prototype `full` mode: `min(52vh, 420px)`).

### 4.7 Worked example (Tier 1): picker (prototype seed a2)

```bash
cat > pick.json <<'EOF'
{"v":1,"type":"picker","title":"Runner picker",
 "fallback":"Which runner should I compare first? Options: Built-in, vitest, jest. Reply with one.",
 "height":120,
 "props":{"prompt":"Which runner should I compare first?",
          "options":[{"id":"builtin","label":"Built-in"},{"id":"vitest","label":"vitest"},{"id":"jest","label":"jest"}]}}
EOF
convoz reply 9031 --app pick.json "Which runner should I compare first?"
```

The owner taps "vitest". The server stores message 9124 (`via_app`, body "Picked vitest", result `{"selected":["vitest"]}`) and gives `@devtool` an `app_result` inbox item (§3.15). The same JSON is `examples/valid.json` → `picker-single-prototype-a2`; it passes ajv.

### 4.8 Worked example (Tier 1): chart (prototype seed a1)

`examples/valid.json` → `chart-bar-prototype-a1`: bar chart, 7 days, 2 series with tones `accent`/`muted`, one `warn` ref line "Cap 2M a day". Post: `convoz post 17 --app chart.json "Tokens per day for the last week, docs lane against the rest."`

### 4.9 Prototype kinds and where they go

| Prototype `rich` | v1 home |
|---|---|
| chart, spark | `chart` (`kind` bar/line/spark) |
| table | `table` |
| picker | `picker` |
| diff | `code` (`mode: diff`) |
| compare | `gallery` (`layout: compare`) |
| frame | `frame` (Tier 2) |
| agent | not an app: the `member.requested` system card (M-4) |
| draft | a `code` block or plain markdown fenced block (copy button) |
| map, calendar | Tier 2 in v1 (no offline map data in the kit); Tier-1 candidates for v2 |
| `- [x]` task list in a message | Markdown (read only); use `checklist` for interaction |

---

## 5. Tier 2 apps (sandboxed custom apps)

### 5.1 What it is

A single self-contained HTML document that the agent builds and uploads. The host shows it in a sandboxed iframe that has no network, no storage and no way to post as the owner. It talks to the host only over one `MessageChannel` port.

### 5.2 How an agent builds one

Source directory:

```
deploy-report/
  convoz.app.json   # manifest source: name, version, icon, height, results, permissions: []
  index.html        # entry; may load ./*.js, ./*.css, ./img/* by relative path
```

`convoz app build ./deploy-report`:

1. Reads `convoz.app.json`; fills `bridge: 1` and `kit: <embedded app-kit version>`; validates against `manifest.json`.
2. Bundles `index.html` and its relative scripts and styles into **one file** (DEFAULT: the CLI embeds esbuild's Go API: bundle, minify, target es2020; no npm needed). Relative images and fonts become `data:` URIs.
3. Inlines the **app-kit frame runtime** (≤40 KB gz, embedded in the CLI by `go:embed` from `packages/app-kit/dist/frame-runtime.js`) as the first script. It defines `window.convoz` (§5.5) and CSS variables `--cvz-*` from the theme tokens.
4. Rejects (exit 2, `app_bundle_*` codes with file:line): any absolute URL in `src`, `href`, `url()`, `import` or `fetch(` (`app_bundle_external_ref`); `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv="refresh">`, `<link rel=prefetch|preconnect|dns-prefetch|preload>`, `<form action>`; bundle >512 KB (`app_bundle_too_large`). Warns on `<input type="password">`.
5. Writes `dist/app.html` and `dist/app.json` (the envelope, authoring form: `props.bundle = {"file": "app.html"}`, `props.manifest`, `title` = manifest name, a placeholder `fallback` the agent must replace) and prints size and SHA-256.

`convoz post <conv> --app dist/app.json [--app-data data.json] [--app-fallback "…"] [--app-title "…"] <text>`:

1. Validates the authoring form locally (same schemas, embedded).
2. Uploads `app.html` as `POST /api/uploads {kind:"app", filename:"app.html", size, sha256}` (resumable).
3. Rewrites `bundle` to the wire form `{upload, sha256, size}`, sets `props.data`, validates the wire form, posts with `upload_ids:[bundle id]`.

The server rejects the authoring form (`examples/invalid.json` → `frame-authoring-form-sent-to-server`).

### 5.3 Manifest (schema `manifest.json`)

| Key | Rule |
|---|---|
| `name` | ≤40 chars, one line |
| `version` | semver `x.y.z`, the agent's own version |
| `description` | ≤140 |
| `icon` | one of: app, chart, table, map, calendar, report, form, list, code, image, gauge, tool (host icons; no agent images) |
| `height` | `initial`, `min`, `max`, each 80–600 |
| `results` | true if the app may send a result (preview says "This app can send a reply for you") |
| `permissions` | must be `[]` in v1 |
| `bridge` | 1 |
| `kit` | semver of the inlined runtime |

### 5.4 The frame

- Element: `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" loading="lazy" title="<title> (sandboxed)" src="/api/apps/<message_id>/frame?h=<sha256>">`. No `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads`.
- Served by proposed `GET /api/apps/:message_id/frame?h=<sha256>` (E-8): cookie auth only (a lease gets 403); canSee on the message; not deleted; app type `frame`; `h` = stored hash; `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: same-origin`, else 400/403. It returns the bundle bytes with:
  - `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, max-age=31536000, immutable`.
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'` (+ `webrtc 'block'` where supported).
- Why a route and not `srcdoc`: a `srcdoc` frame inherits the host page's CSP, so the host would need `'unsafe-inline'` for scripts. The route gives the frame its own CSP, keeps the host CSP strict, and makes the document cacheable by hash. The host CSP needs `frame-src 'self'`.
- No network, no storage: `connect-src 'none'`; the opaque origin has no cookies, `localStorage` or IndexedDB.
- **Honest limit (new threat):** a frame can still navigate **itself** to an outside URL (CSP cannot block self-navigation) and DNS-prefetch may leak on some browsers. So a malicious app could leak what the owner types **into that frame**. Mitigations: the host tears the frame down on a second `load` event (navigation) and shows "This app tried to leave and was closed"; `convoz app build` rejects prefetch hints; the preview says "Do not type secrets into apps"; forms that need input should be Tier-1 `form` (host-rendered). The frame never gets any data the agent did not already have (E-11, E-25).
- Service worker: cache-first for `/api/apps/*/frame?h=` (immutable), LRU ≤20 MB (E-24).

### 5.5 MessageChannel protocol (schema `bridge.json`)

Handshake: on the first `load`, the host creates a `MessageChannel`, keeps `port1`, and sends `{t:"convoz.connect", v:1, versions:[1]}` with `port2` by `iframe.contentWindow.postMessage(msg, "*", [port2])` (`"*"` because the frame origin is opaque). The runtime keeps the first port it gets and ignores every later window message. The host never listens to window `message` events for apps; only messages on that frame's own `port1` count. One port per frame, so a frame cannot speak for another.

| Direction | `t` | Fields | Host / runtime behaviour |
|---|---|---|---|
| host → frame | `convoz.connect` | v, versions | via window, carries the port |
| frame → host | `ready` | v, kit | must arrive ≤5 s after load, else "App did not start" + fallback |
| host → frame | `init` | v, app {messageId, title, canResult, onAsk}, data (≤32 KB), env {theme, tokens (10 hex colours), locale, reducedMotion, saveData, platform, width} | sent once after `ready` |
| host → frame | `data` | v, data? and/or env? | theme change, width change; `data` for status-panel apps |
| frame → host | `resize` | v, height 1–20000 | host clamps to manifest min/max and 80–600 (phone also ≤70vh); ≤10/s |
| frame → host | `result` | v, id (nonce), summary (≤280), value (≤4096 B) | dropped if `canResult=false`. On an ask (`onAsk`), `{option:0..4}` only highlights that ask button. Else opens the **host confirm sheet** (§5.7) |
| host → frame | `ack` | v, id, status `sent`\|`cancelled`\|`rejected`\|`not_allowed`, reason? | outcome of a result |
| frame → host | `error` | v, code `render`\|`data`\|`unsupported`\|`internal`, message ≤200 | host shows the fallback under a small "App error" note |

Abuse rules: any message >8192 B, of an unknown `t`, failing its schema, or above 20/s is dropped and counted; 3 drops close the frame. ≤1 result in flight (sheet open); ≤10 results per frame session.

Runtime API inside the frame (`window.convoz`, from app-kit): `onInit(fn)`, `onData(fn)`, `fit()` (resize to document height), `resize(h)`, `result({summary, value}) → Promise<status>`, `error(code, message)`, `kit.render(el, {type, props})` (Tier-1 components inside the frame, on `preact/compat`).

### 5.6 Lifecycle

1. **Preview card (always first).** Host-only, no network: manifest icon and name + version, `title`, "App from @x", first 2 lines of `fallback`, bundle size ("61 KB"), "This app can send a reply for you" when `results`, and an **Open app** button. Screen readers read the full fallback.
2. **Lazy load on tap.** Tier-2 frames never auto-load, on any network (DEFAULT). On Save-Data or a slow link the button reads "Open app · 61 KB" and nothing is prefetched.
3. Desktop: the frame opens inline at `manifest.height.initial` (or `height`), with Expand to the side panel. Phone: Open goes straight to a full-screen sheet.
4. Handshake → `ready` → `init` → `resize`.
5. Teardown: Close, scrolling more than 2 screens away, or a 4th live frame (≤3 live frames). Reopening starts fresh (no storage).
6. Navigation (second `load`) → teardown + notice (§5.4).

### 5.7 Host confirm sheet (I-46)

A host-rendered modal outside the frame: header "Send as you, via app by @devtool"; the `summary` as plain text; the `value` flattened to ≤20 "key: value" rows (plain text, truncated); the thread it goes to; buttons **Send** (focus) and **Cancel**. Only a trusted click or Enter on Send (`event.isTrusted`, the sheet visible ≥500 ms to stop click-jacking) posts the via_app message. Then `ack` goes back to the frame.

### 5.8 Updates, versioning, old clients

| Case | Rule |
|---|---|
| New version of an app | Build again (`manifest.version` up) and post a **new message**. Bundles are immutable by hash; old messages keep their old bundle. |
| Envelope / component change | `v: 2` (§4.3). |
| Bridge protocol change | `bridge: 2`. The host keeps v1 for good (it is small). `connect.versions` lists what the host speaks; a frame whose `bridge` the host does not speak gets the fallback card. |
| app-kit runtime update | New builds inline the new runtime. Old bundles keep their own copy, so nothing breaks. |
| Old client meets a frame | It validates the envelope; if it cannot, it shows the fallback card. A client that knows `frame` but not `bridge: N` shows the fallback card. |
| Old CLI | Server answers 400 `app_version_unsupported` with `supported`; the CLI says "update convoz". |

### 5.9 Worked example (Tier 2): deploy report (prototype seed a3)

`deploy-report/convoz.app.json`:

```json
{"name":"Deploy report","version":"1.0.0","icon":"report","height":{"initial":130,"min":80,"max":400},"results":true,"permissions":[]}
```

`deploy-report/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 12px; font: 13px/1.45 system-ui, sans-serif; background: var(--cvz-raised); color: var(--cvz-text) }
  td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--cvz-line) }
</style>
<table id="t"></table>
<button id="rb">Roll back box-3 again</button>
<script>
  convoz.onInit(({ data }) => {
    const t = document.getElementById("t");
    for (const row of data.rows) {
      const tr = t.insertRow();
      for (const cell of row) tr.insertCell().textContent = cell;
    }
    convoz.fit();
  });
  document.getElementById("rb").onclick = () =>
    convoz.result({ summary: "Roll back box-3 again", value: { action: "rollback", host: "box-3" } });
</script>
```

```bash
convoz app build ./deploy-report        # → dist/app.html 61 440 B, sha256 9f2c…; dist/app.json
convoz post 17 --app deploy-report/dist/app.json --app-data rows.json \
  --app-fallback "Post-deploy report for box-3. box-3: rolled back at 5:52 AM. Error rate: 0.3%, flat for 20 min. Checks: 12 of 12 pass." \
  "Post-deploy report for box-3. All checks are green after the rollback."
```

The wire `app_json` is `examples/valid.json` → `frame-prototype-a3` (passes ajv). The owner taps Open, then the button; the confirm sheet shows "Roll back box-3 again" and `action: rollback`, `host: box-3`; Send posts a via_app message; `@night-watch` gets an `app_result` item.

---

## 6. Authoring surface for agents

| Need | CLI | MCP tool | HTTP |
|---|---|---|---|
| Post an app | `convoz post <conv> --app f.json [--app-data d.json] [--app-fallback T] [--app-title T] <text>` | `post {conversation, text, app}` | `POST /api/conversations/:id/messages {app, upload_ids}` |
| Reply with an app | `convoz reply <msg> [--broadcast] --app f.json <text>` | `reply {message, text, app}` | same + `thread_root_id` |
| Ask with a display app | `convoz ask … --app f.json` | `ask {…, app}` | `POST /api/asks {…, app}` |
| Validate only | `convoz app validate f.json` (local, then server dry run) | `app_validate {app}` | proposed `POST /api/apps/validate {app}` → 200 or 400 (E-8) |
| Scaffold Tier 2 | `convoz app init <dir>` (writes the two source files) | — | — |
| Build Tier 2 | `convoz app build <dir> [--out dir]` | `app_build {dir}` → {app_json_path, size, sha256, warnings} | — |

The MCP `post`/`reply`/`ask` tool input schemas `$ref` `app.json`, so Claude Code sees the exact shape. Tool output never has a secret (I-42).

**Validation errors returned to the agent.** HTTP 400:

```json
{"error":{"code":"app_invalid","message":"app_json does not match app.v1",
  "schema":"https://schemas.convoz.dev/v1/app.json",
  "details":[{"path":"/props/options","rule":"minItems","message":"must have at least 2 items"},
             {"path":"/props/colour","rule":"additionalProperties","message":"unknown key; v1 allows: prompt, options, multi, min, max, submitLabel"}]}}
```

≤20 details, JSON-pointer paths, no echo of the submitted values. CLI prints the same as lines and exits 2; nothing is sent.

| Code | When |
|---|---|
| `app_invalid` | schema failure |
| `app_semantic` | a §4.4 check failed (detail names the rule, e.g. `lengths_mismatch`, `duplicate_id`) |
| `app_too_large` | canonical JSON >65 536 B, or frame `data` >32 768 B |
| `app_version_unsupported` | `v` not known (+ `supported`) |
| `app_type_not_allowed_on_ask` | picker, form or select checklist on an ask |
| `app_upload_not_bound` / `app_upload_wrong_kind` | gallery or bundle refs |
| `app_bundle_hash_mismatch` | stored SHA-256 or size ≠ manifest values |
| `app_bundle_too_large` / `app_bundle_external_ref` / `app_bundle_forbidden_tag` | CLI build checks (server re-checks size and UTF-8 HTML) |
| `app_result_invalid` / `app_result_not_allowed` | via_app result fails §4.4 #10, or the target has no result path |

---

## 7. Rendering pipeline and what Go and TS share

```
agent CLI/MCP ──validate (embedded schemas)──► POST ──► server: strict decode → size → JSON Schema → semantic checks → canonicalize
                                                         └─ tx: message row (+uploads bind, FTS of Project(long), inbox items, event)
client: page/SSE (props inline ≤4 KB, else stub) ──► validate again (ajv standalone) ──► app-kit renderer │ fallback card
Tier 2: preview card ──tap──► GET frame (CSP) ──► port handshake ──► init ──► result ──► host confirm sheet ──► POST via_app
```

| Step | Where | What |
|---|---|---|
| Parse | server `internal/server/appkit` | Strict JSON decode (unknown fields rejected, duplicate keys rejected), ≤65 536 B raw before parse. |
| Validate (server) | `appkit.Check` before `BEGIN` (no lock held) | `santhosh-tekuri/jsonschema` compiled once at boot from the embedded schemas, then the §4.4 Go checks. Canonical compact JSON is stored. |
| Validate (client) | `packages/app-kit` | ajv **standalone** validators generated at build time (no `eval`, fits a strict CSP), then the same §4.4 checks in TS. Failure → fallback card, never a partial render. |
| Sanitise | client | There is nothing to sanitise into HTML: Tier 1 sets text nodes only, tones map to tokens, images come only from own uploads. Markdown bodies go through `packages/markdown` (render tree, no HTML; I-45). Tier 2 is isolated by sandbox + CSP, not by sanitising. |
| Project | server Go (`message.Project`) + TS twin | plain-text projection (§2.3). |

**`packages/contracts` (single source of truth):**

- `schemas/v1/` = the files in `schemas8.De4x/` (`common`, `app`, `components/*`, `manifest`, `bridge`, `app-result`, `system`).
- Generated: Go structs (`go-jsonschema`) → `packages/contracts/gen/go/app`; TS types (`json-schema-to-typescript`) and ajv standalone validators → `packages/contracts/gen/ts/app`. Drift gate as in draft 8 §4.3.
- Fixtures: `fixtures/app/valid/*.json`, `fixtures/app/invalid/*.json` (each with the expected error code and path), `fixtures/projection/*.json`. Go and TS tests both run every fixture; the CLI embeds the same schemas (`go:embed`) so local and server results agree.
- Portability rule: patterns use only RE2-safe syntax; control characters are written as JSON `\u` escapes (decoded to literal characters before the regex compiles), never as regex `\u` escapes.

---

## 8. Gaps and contradictions with draft 8, as proposed edits (not applied)

Each edit gives the section, the old text (verbatim) and the new text.

**E-1. §7 `messages` DDL — store the app result.** (Gap: the structured result an agent needs has no column.)
- Old: `  via_app_message_id INTEGER,                                  -- the app message the result came from`
- New: `  via_app_message_id INTEGER,                                  -- the app message the result came from` + new line `  app_result_json TEXT CHECK (app_result_json IS NULL OR (json_valid(app_result_json) AND length(app_result_json) <= 4096)),  -- app-result.v1` + new table CHECK `CHECK (app_result_json IS NULL OR via_app_message_id IS NOT NULL),`

**E-2. §7 `messages` — enforce the via_app target in the DB.** (Gap: nothing checks that the target is an app or that the sender is human.)
- Old: `  BEGIN SELECT RAISE(ABORT,'message structure is immutable'); END;           -- DA-8`
- New: same line, then:
  `CREATE TRIGGER messages_via_app_valid BEFORE INSERT ON messages WHEN NEW.via_app_message_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'via_app needs a human sender and an app message by that agent') WHERE NOT EXISTS (SELECT 1 FROM humans h WHERE h.identity_id = NEW.author_id) OR NOT EXISTS (SELECT 1 FROM messages a WHERE a.id = NEW.via_app_message_id AND a.app_json IS NOT NULL AND a.author_id = NEW.via_app_agent_id AND a.deleted_at IS NULL); END;  -- I-46`

**E-3. §7 `uploads` — Tier-2 bundles and voice waveforms.** (Gap: no place for a bundle; prototype waveform has no data.)
- Old: `  kind         TEXT NOT NULL CHECK (kind IN ('audio','image','file')),`
- New: `  kind         TEXT NOT NULL CHECK (kind IN ('audio','image','file','app')),   -- app = Tier-2 bundle, served only by GET /api/apps/:id/frame`
- Old: `  duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 300000),`
- New: same line + `  waveform     BLOB CHECK (waveform IS NULL OR (kind = 'audio' AND length(waveform) <= 64)),   -- 64 peaks 0..255 from the recorder`

**E-4. §7 `asks.answer_via` — name clash with mini apps.** ('app' here means "in the conversation", not a mini app.)
- Old: `  answer_via   TEXT CHECK (answer_via IN ('app','now','cli')),`
- New: `  answer_via   TEXT CHECK (answer_via IN ('inline','now','cli')),`

**E-5. §7 `inbox_items` — app results and voice hold.**
- Old: `  reason TEXT NOT NULL CHECK (reason IN ('mention','activity','thread','ask_resolved','ask_snoozed','membership')),`
- New: `  reason TEXT NOT NULL CHECK (reason IN ('mention','activity','thread','ask_resolved','ask_snoozed','membership','app_result')),`
- Old: `  claim_until INTEGER,`
- New: `  claim_until INTEGER,` + `  not_before  INTEGER,                                   -- voice: held until the transcript is done or 120 s pass`

**E-6. §7 Notes — system lines and the search filter name.** (Contradiction: §7 says `has:app`, §13 and the prototype say `is:app`.)
- Old: ``- `message_refs` is gone: the Shared tab reads `uploads_conv`; `has:link` is an FTS match on `http`/`https` tokens; `has:app` is `app_json IS NOT NULL` on the conversation range.``
- New: ``- `message_refs` is gone: the Shared tab reads `uploads_conv`; `has:link` is an FTS match on `http`/`https` tokens; `is:app` is `app_json IS NOT NULL` on the conversation range.`` + new bullet ``- `system_json` follows `system.v1` (12 subtypes; messages-apps spec §3 M-4a). `app_json` follows `app.v1`, `app_result_json` follows `app-result.v1` (packages/contracts/schemas/v1).``

**E-7. §3.8 MCP tools.**
- Old: ``- The MCP tools describe themselves (name, one-line purpose, JSON schema): `whoami`, `brief`, `inbox`, `claim`, `ack`, `read`, `search`, `post`, `reply`, `ask`, `status`, `handoff`, `profile`. Tool output never contains a key or lease (I-42).``
- New: ``- The MCP tools describe themselves (name, one-line purpose, JSON schema): `whoami`, `brief`, `inbox`, `claim`, `ack`, `read`, `search`, `post`, `reply`, `ask`, `status`, `handoff`, `profile`, `app_validate`, `app_build`. `post`, `reply` and `ask` take `app` (schema `app.v1`). Tool output never contains a key or lease (I-42).``

**E-8. §13 API — define `via_app`, add four routes.** (Gap: `result_token` is never defined, and the server cannot verify a client gesture anyway.)
- Old: ``| `POST /api/conversations/:id/messages` | H/L `post` | {client_id, body, format, thread_root_id?, broadcast?, upload_ids?, app?, via_app?:{message_id, result_token}} | I-8 I-9 I-16 I-18 I-24 I-31 I-46 |``
- New: ``| `POST /api/conversations/:id/messages` | H/L `post` | {client_id, body, format, thread_root_id?, broadcast?, upload_ids?, app? (L only), via_app?:{message_id, result} (H only)} | I-8 I-9 I-16 I-18 I-24 I-31 I-46 I-50 |`` + rows:
  ``| `POST /api/apps/validate` | H/L | {app} → 200 {bytes} \| 400 app_* | I-50 |``
  ``| `GET /api/messages/:id/app` | H/L | full app_json when the page held a stub | I-6 |``
  ``| `GET /api/apps/:message_id/frame?h=` | H (cookie only) | Tier-2 bundle with the frame CSP | I-46 I-50 |``
  ``| `GET /api/messages/:id/unfurl` | H | unfurl card for the first URL (canSee) | I-6 |``

**E-9. §13.1 caps.**
- Old: ``| Caps | body ≤16 KB; app ≤64 KB; ≤10 attachments; ≤5 URLs; ≤20 participants; ≤4 alternatives; handoff ≤4000 chars; brief ≤64 KB even with `--max-bytes` |``
- New: ``| Caps | body ≤16 KB; app ≤64 KB (fallback ≤2000 chars, frame data ≤32 KB, per-component caps in app.v1); Tier-2 bundle ≤512 KB; app result ≤4 KB; ≤10 attachments; ≤5 URLs; ≤20 participants; ≤4 alternatives; handoff ≤4000 chars; brief ≤64 KB even with `--max-bytes` |``

**E-10. §13.2 CLI.**
- Old: ``| `convoz post <conv> [--format …] [--file path…] [--app file] <text\|->` | post to main | `post` |``
- New: ``| `convoz post <conv> [--format …] [--file path…] [--app file [--app-data file] [--app-fallback T] [--app-title T]] <text\|->` | post to main | `post` |`` + row ``| `convoz app init <dir>` · `convoz app build <dir>` · `convoz app validate <file>` | scaffold · bundle a Tier-2 app · validate | `app_build`, `app_validate` |``
- Old: ``| `convoz reply <message> [--broadcast] <text\|->` | thread reply | `reply` |``
- New: ``| `convoz reply <message> [--broadcast] [--app file …] <text\|->` | thread reply | `reply` |``

**E-11. §8 I-46 — MessageChannel, not `event.source`; navigation.** (Contradiction: with a port per frame, frame messages have no `event.source`; self-navigation is not covered.)
- Old: ``| I-46 | **Apps cannot forge the owner.** The host gives each Tier-2 frame its own `MessageChannel` port and checks `event.source`; a frame result only fills a host-rendered confirm sheet; only the owner's tap outside the frame sends. A `via_app` message stores the app's agent and app message, renders "via app by @x", and shows the same in `convoz read`. | APP + DB | `TestAppResult_NoSendWithoutHostGesture`, `TestViaApp_AttributedToAgentInConvozRead`, `TestAppFrame_SandboxScriptsOnly` |``
- New: ``| I-46 | **Apps cannot forge the owner.** The host never reads window `message` events from app frames; it hands each frame its own `MessageChannel` port once, at load, and accepts only messages on that port. A frame result only fills a host-rendered confirm sheet; only a trusted tap on Send outside the frame sends. A frame that navigates (a second `load`) is torn down. A `via_app` message needs a human sender; the server sets `via_app_agent_id` from the app message's author; it renders "via app by @x" and shows the same in `convoz read`. | APP + DB | `TestAppResult_NoSendWithoutHostGesture`, `TestViaApp_AttributedToAgentInConvozRead`, `TestAppFrame_SandboxScriptsOnly`, `TestAppFrame_PortOnlyNoWindowMessages`, `TestAppFrame_NavigationTearsDown`, `TestViaApp_LeaseRejected403`, `TestViaApp_TargetMustBeAppByThatAgent` |``

**E-12. §8 — new invariant I-50 (the test S7 cites now has a schema).**
- Old: (after the I-49 row) — none.
- New: ``| I-50 | **App contract.** Every stored `app_json` matches app.v1 and the semantic checks (messages-apps spec §4.4); unknown keys → 400; a `fallback` is required; referenced uploads are bound to the same message with the right kind; no picker, form or select checklist on an ask; results match their target app. Clients validate again and render the fallback for anything they cannot validate. | APP + DB CHECK | `TestApp_SchemaRejectsUnknownKeys`, `TestApp_FallbackRequired`, `TestApp_ContractFixtures` (Go and TS, every fixture), `TestApp_UploadRefsBoundToMessage`, `TestApp_PickerOnAskRejected`, `TestAppResult_MustMatchTarget`, `TestAppKit_UnknownVersionRendersFallback` (TS) |``

**E-13. §16 S7 row.**
- Old: ``| S7 | Apps (`app_json` tier 1/2, frame sandbox, `MessageChannel`, host confirm sheet, `via_app` attribution) | appkit, message · apps-host · app-kit | I-46, `TestApp_SchemaRejectsUnknownKeys` |``
- New: ``| S7 | Apps: app.v1 schemas + fixtures in contracts; Tier-1 kit (10 types); `convoz app init/build/validate`; frame route + CSP; bridge v1; host confirm sheet; `via_app` + `app_result_json`; `app_result` inbox items | appkit, message, upload, agentrt · apps-host · app-kit, contracts | I-46, I-50 |``

**E-14. §4.1 layout — name the contract files.**
- Old: `  contracts/  OpenAPI 3.1 (REST) + JSON Schema 2020-12 (events, one file per type.vN, app-kit props, settings, MCP tool schemas)`
- New: `  contracts/  OpenAPI 3.1 (REST) + JSON Schema 2020-12 (events, one file per type.vN; schemas/v1: app, components/*, manifest, bridge, app-result, system; settings; MCP tool schemas) + fixtures (app valid/invalid, projection)`

**E-15. §4.1 refinements — who inlines the runtime.**
- Old: ``| Sandbox runtime | `app-kit` on `preact/compat`, inlined into each Tier-2 frame document; ≤40 KB gz | The frame cannot load scripts from our origin. |``
- New: ``| Sandbox runtime | `app-kit` frame runtime on `preact/compat`, ≤40 KB gz, embedded in the `convoz` binary and inlined by `convoz app build` into each Tier-2 bundle (an upload of kind `app`, served only by `GET /api/apps/:id/frame` with the frame CSP). The CLI bundles with esbuild's Go API (DEFAULT). | The frame cannot load scripts from our origin; agents need no npm. |``

**E-16. §14 — delete and purge cover the new columns.** (Gap: a deleted message's FTS row and files stay reachable.)
- Old: ``- **Conversation delete (DA-6):** soft. `deleted_at` hides it from everyone; the owner sees it in Trash for 30 d and can restore it; then it is purged automatically.``
- New: ``- **Message delete:** tombstone. In the same tx the FTS row is deleted; from then on the API never serves its body, app, result or files (404), to anyone. Purge scrubs the bytes.`` + the old line unchanged.
- Old (purge bullet): ``scrubs: `messages.body` → '', `app_json` → NULL,``
- New: ``scrubs: `messages.body` → '', `app_json` → NULL, `app_result_json` → NULL, `uploads.waveform` with the uploads,``

**E-17. §2.3 permission matrix — app rows.**
- Old: ``| Post a text message or thread reply | ✓ | P | P | P + `post` | K+R |``
- New: same row + ``| Post an app (Tier 1 or 2) | ✗ | ✗ | ✗ | P + `post` | K |`` + ``| Send an app result (`via_app`) | ✓ | P | P | ✗ | K+R |``

**E-18. §2.3 — what an edit may change.**
- Old: ``| Edit own message | ✓ | ✓ | ✓ | text only, ≤24 h | K |``
- New: ``| Edit own message (body and format only; not asks, answers, via_app or system; apps and files immutable; mentions unchanged, no new items or pushes) | ✓ | ✓ | ✓ | same, ≤24 h | K |``

**E-19. §3.8 inbox reasons — `app_result` and precedence.**
- Old: ``…`membership` (it was added, removed, approved or declined; a pending add it requested was decided).``
- New: ``…`membership` (it was added, removed, approved or declined; a pending add it requested was decided); `app_result` (a human sent a result through one of its apps; one item per result, never coalesced). One item per (identity, message): `app_result` > `mention` > `ask_resolved` > `thread` > `activity`. Items for a voice message wait (`not_before`) for the transcript, ≤120 s.``

**E-20. §10.3 previews.**
- Old: ``- **Payload:** ≤3 KB, RFC 8291 encrypted, padded to the next 512-byte bucket. `{v:1, reason, title, body?, url, badge, topic}`.``
- New: same + `` `body` = the short plain-text projection (messages-apps spec §2.3), ≤140 chars; never app props, results or file bytes.``

**E-21. §5.1 step 2 and §5.4 — one projection; transcripts are searchable.**
- Old: `2. Before the transaction: authenticate, check scopes and rate budgets, parse and validate the payload, compute the markdown projection (no DB write lock held).`
- New: `2. Before the transaction: authenticate, check scopes and rate budgets, parse and validate the payload (app.v1 + semantic checks for apps), compute the plain-text projection (markdown, ask, app fallback, file names; no DB write lock held).`
- Old: ``| `upload.transcribed` | worker | C1 | upload, message_id | conv |``
- New: ``| `upload.transcribed` | worker (its tx also re-indexes the message FTS row with the transcript and releases held inbox items) | C1 | upload, message_id | conv |``

**E-22. §12.3 compact payloads — what "thin app stub" means.** (Contradiction: stubs vs Tier-1 apps that should render at once.)
- Old: ``thin `app` stubs until opened``
- New: `` `app` inline when ≤4 KB, else a stub `{type, v, title, fallback, bytes}` fetched by `GET /api/messages/:id/app` when visible on a fast link or on tap``

**E-23. §12.3 media auto-load — apps.**
- Old: ``| Media auto-load | No auto-load of images, audio, unfurl cards or app previews when``
- New: ``| Media auto-load | Tier-2 frames never auto-load on any network. No auto-load of images (gallery images too), audio, unfurl cards or app stubs when``

**E-24. §9 service worker.**
- Old: ``Network-first for `/api/*` GETs with an IndexedDB fallback.``
- New: ``Network-first for `/api/*` GETs with an IndexedDB fallback, except cache-first for `/api/apps/*/frame?h=` (immutable by hash; LRU ≤20 MB).``

**E-25. §15 Others — the frame exfiltration limit.**
- Old: ``Others: the FTS index is about as big as `messages` ``
- New: ``Others: a Tier-2 frame can navigate itself away and leak what the owner types into it (CSP cannot block self-navigation; the host tears it down on navigation and Tier-1 forms are preferred); the FTS index is about as big as `messages` ``

**E-26. §4.5 prototype → packages — prompt text.** (Contradiction: the prototype prompt says `--app picker|chart|table --app-data` and `--app-html`.)
- Old: ``the machine-request card → `features/now`.``
- New: ``the machine-request card → `features/now`; the agent prompt's App line becomes "App: --app file.json (Tier 1: chart, table, checklist, kv, picker, form, progress, code, gallery; Tier 2: convoz app build ./dir). fallback is required."; prototype `rich` kinds map as in messages-apps spec §4.9.``

**E-27. §8 I-31 — one audio per voice message; app uploads.**
- Old: ``| I-31 | An upload binds once, by its uploader, to a message in the same conversation, only when complete.``
- New: ``| I-31 | An upload binds once, by its uploader, to a message in the same conversation, only when complete. An audio upload is the only upload on its message. An app message binds exactly the uploads its app references; a kind `app` upload binds only to a frame app.``

**E-28. §17 open questions — add the DEFAULTs below (Q16–Q24).**
- Old: ``15. Later items need your approval when they come: `convoz watch --exec` (starts processes on a host), push action buttons (default OFF), Ed25519 per-host keys.``
- New: same + the §8.1 list as items 16–24.

### 8.1 Calls made here (DEFAULT, owner to confirm)

1. **One component per message**, no stacks in v1.
2. **Apps are immutable** after posting; to update, post again (live state goes in agent status).
3. **Only agents post apps**; humans send results.
4. **Unknown keys rejected**; `fallback` required; clients show the fallback for anything they cannot validate.
5. **Single picker sends on one tap**; form and Tier-2 results go through the host confirm sheet.
6. **Tier-2 frames never auto-load**, on any network; bundle ≤512 KB; served by a frame route with its own CSP (not `srcdoc`).
7. **`convoz app build` embeds esbuild** (Go API) and the app-kit runtime, so agents need no npm. Alternative: accept only one pre-built HTML file (smaller binary).
8. **Edits never add mentions, items or pushes**; edit history visible to everyone who canSee the message.
9. **Agents get unfurl URLs only**, never fetched content.
10. **Voice inbox items wait ≤120 s** for the transcript; spoiler text is not indexed.

### 8.2 Gaps left open (no edit proposed)

- G-7 Images have no thumbnails in v1; originals load on tap on slow links. Thumbnails (encrypted, derived) are a later slice.
- G-8 Agents cannot delete or edit from CLI/MCP in v1 (draft 8 Q12 still open).
- G-9 A human-authored app (e.g. owner posts a poll) is not in v1.
- G-10 Resolved in draft 9: `answer_via` is `inline` or `now`; a CLI answer comes back only with human CLI login (C-3).

---

## 9. Schema files and how they were checked

Directory `schemas/`:

| File | Content |
|---|---|
| `common.json` | ids, upload refs, sha256, semver, numbers, tones, one-line and multi-line text, fallback, summary |
| `app.json` | the `app_json` envelope; dispatches `props` by `type` |
| `components/{chart,table,checklist,kv,picker,form,progress,code,gallery,frame}.json` | Tier-1 props and the Tier-2 wire form |
| `manifest.json` | Tier-2 manifest |
| `bridge.json` | bridge v1 (`$defs/toFrame`, `$defs/fromFrame`, one def per message) |
| `app-result.json` | `app_result_json` |
| `system.json` | `system_json` (12 subtypes) |
| `examples/valid.json` (31) · `examples/invalid.json` (41) | every component, every bridge message, results, system lines; invalid ones for each rule |
| `validate.cjs` | the runner |

Run: `timeout 60 node validate.cjs <node_modules dir> <schemas dir>`. Result: **16 schemas compile in ajv 8.20.0 (Ajv2020, `strict: true`); 31/31 valid examples pass; 41/41 invalid examples fail, each on the intended rule** (bridge and system ones are pinned to their own `$def` so the reason is exact). `npx` is not on this machine's PATH, so ajv was loaded from the local npm cache (`~/.npm/_npx/405dc6d2c5e9f5ec/node_modules`) with `node`. Two notes: `strictRequired` is off (2020-12 `required` inside `if/then`/`anyOf` is valid; ajv's lint flags it); Go is not installed here, so RE2 compatibility of the patterns was checked by hand (only classes, anchors, `{n,m}`, escaped dots; no lookaround, no backreference, no `\u` regex escapes). The §4.4 semantic checks are not JSON Schema and were not machine-checked; they become `TestApp_ContractFixtures`.

---

<!-- ACs ready for ac-reviewer -->
## 10. AC draft

- AC-M1 Every message in a seeded fixture (one of each of the 10 variants, plus reply, broadcast, edited and unfurl) gets exactly one variant from §2.1, and `Project(short)`/`Project(long)` equal the expected strings in `fixtures/projection/*.json` in both Go and TS. Fails if any variant differs between Go and TS or from the fixture. Evidence: the two test logs side by side.
- AC-M2 Every file in `fixtures/app/valid` is accepted and every file in `fixtures/app/invalid` is rejected with its expected `code` and JSON-pointer `path`, by the server (`POST /api/apps/validate`), by `convoz app validate`, and by the client validator. Fails on any disagreement. Evidence: a test log listing each fixture and the three verdicts.
- AC-M3 A post with an unknown key (`/props/colour`) returns 400 `app_invalid` naming that path, writes no message, event, FTS or inbox row, and the CLI exits 2 with the same path. Evidence: HTTP transcript + row counts before/after.
- AC-M4 Edge sizes: an `app_json` of exactly 65 536 B canonical is accepted; 65 537 B returns 413/400 `app_too_large`; a Tier-2 bundle of 524 288 B is accepted and 524 289 B is rejected at upload; frame `data` of 32 769 B is rejected. Evidence: a test log with the byte counts.
- AC-M5 A picker, a form and a select checklist on an ask each return 400 `app_type_not_allowed_on_ask`; a chart on an ask is accepted and its in-app clicks do not answer the ask (the ask stays `open`). Evidence: test log + one screenshot.
- AC-M6 Single picker: one tap posts exactly one via_app message with body "Picked vitest", `via_app_agent_id` = the app author, `app_result_json.value.selected = ["vitest"]`, in the app message's thread; the agent gets one `app_result` item; `agent_streak` is unchanged. A lease posting `via_app` gets 403; a `via_app` whose target has no app, or another agent's app id in the body, is rejected (DB trigger even if the app check is bypassed). Evidence: test log + screenshot of "via app by @devtool".
- AC-M7 Tier 2, adversarial frame fixture: a frame that calls `window.parent.postMessage(result)` instead of the port, that posts on the port without a tap, that calls `fetch`, that writes `localStorage`, and that sets `location` to an outside URL — sends 0 messages, makes 0 network requests outside our origin (Playwright request log), and the navigation case shows "This app tried to leave and was closed". A real result posts only after Send in the host confirm sheet. Evidence: Playwright report with the request log and two screenshots.
- AC-M8 Frame route: correct `h`, cookie and canSee → 200 with the exact CSP header string from §5.4; wrong `h` → 404; lease → 403; missing `Sec-Fetch-Dest: iframe` → 400; a deleted message → 404. Evidence: test log quoting headers.
- AC-M9 Old client: a client build that knows only v1, given a v2 app, an unknown `type` and a frame with `bridge: 2`, renders the fallback card with "Update Convoz to view this app" in all three cases and throws no console error. Evidence: Playwright screenshots + console log.
- AC-M10 Save-Data on: opening a conversation with one gallery, one chart with props >4 KB and one Tier-2 app makes 0 requests for images, `/api/messages/:id/app` or `/api/apps/*/frame` until a tap; the Tier-2 preview shows its size. Evidence: HAR file.
- AC-M11 Voice: an agent's inbox item for a voice message is not claimable before the transcript is done (fake clock) and is claimable at once when it is; its text equals the transcript; after 120 s with a failed transcript it is delivered with `transcript_state:"failed"`; `convoz search` finds a word that is only in the transcript. Evidence: test log.
- AC-M12 Delete: after `DELETE /api/messages/:id`, search for its unique word returns 0 hits, `GET /api/files/:id` for its upload returns 404, `GET /api/messages/:id/app` returns 404, and `convoz read` shows `[deleted]`. After purge, a scan of every table finds the body, app, result and transcript strings 0 times. Evidence: test log with counts.
- AC-M13 Edit: an agent edit that adds `@other` adds no participant, no mention row, no inbox item and no push; editing an ask, an answer or a via_app message returns 400; an agent edit after 24 h returns 403. Evidence: test log.
- AC-M14 Regression: every draft-8 behaviour around messages still holds — I-8 thread rules, I-14 unread math (system lines never count, broadcast counted once), I-44 file serving, I-45 markdown links — on the S2/S6 suites unchanged. Evidence: the CI log.
- AC-M15 System lines: each of the 12 subtypes is written by its action in the same tx, validates against `system.v1`, holds no text (a seeded title or name appears 0 times in `system_json`), and renders the §3 template with the current display name after a rename. Evidence: test log + one screenshot of the `member.requested` card.

## Handoff
- ACs ready for ac-reviewer (see §10 above).
- Draft-8 edits E-1…E-28 need an owner/lead decision before they are applied (this spec did not touch draft 8).
- Implementation → advanced-coder for S7 co-design (contracts + Go appkit + TS app-kit + bridge, 3+ modules); coder for the CLI `app init/build/validate` and the projection; fast-coder for copying the schema files and fixtures into `packages/contracts` (per `~/.knowledge/modules/shared/records/model-selection.md`).
