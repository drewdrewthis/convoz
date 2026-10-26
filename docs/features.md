# Convoz features

Generated from `specs/features/*.feature` by `python3 -I specs/scripts/features.py --write`. Do not edit by hand: CI fails when this file is stale.

Each scenario links to its spec line. Scenarios tagged `@later` are not listed.

## Contents

- [A triage agent](#a-triage-agent) (16)
- [Agent inbox](#agent-inbox) (31)
- [Agent sessions as one identity](#agent-sessions-as-one-identity) (17)
- [Agents outside the tailnet connect through an agents-only address](#agents-outside-the-tailnet-connect-through-an-agents-only-address) (8)
- [Apps inside messages](#apps-inside-messages) (15)
- [Asks and their state machine](#asks-and-their-state-machine) (41)
- [Brief, handoff, read and search for agents](#brief-handoff-read-and-search-for-agents) (17)
- [Composer](#composer) (26)
- [Console on a phone](#console-on-a-phone) (28)
- [Conversations](#conversations) (70)
- [Crew: identities, machines and sessions](#crew-identities-machines-and-sessions) (35)
- [Data at rest, backups and deletion](#data-at-rest-backups-and-deletion) (10)
- [Day labels](#day-labels) (4)
- [Errors in the web app reach the server log](#errors-in-the-web-app-reach-the-server-log) (3)
- [Machine login with a device flow](#machine-login-with-a-device-flow) (23)
- [Messages and their types](#messages-and-their-types) (17)
- [Notifications](#notifications) (21)
- [Now](#now) (36)
- [Onboarding and sign in](#onboarding-and-sign-in) (16)
- [One command serves an agent's inbox with a short-lived process per item](#one-command-serves-an-agents-inbox-with-a-short-lived-process-per-item) (6)
- [Pins, stars and mute](#pins-stars-and-mute) (8)
- [Plans: what each agent is doing, what is next and what waits on the owner](#plans-what-each-agent-is-doing-what-is-next-and-what-waits-on-the-owner) (25)
- [Platform rules every module relies on](#platform-rules-every-module-relies-on) (2)
- [Poor connections](#poor-connections) (11)
- [Rail](#rail) (19)
- [Search](#search) (12)
- [Security walls](#security-walls) (12)
- [Settings](#settings) (9)
- [The convoz CLI and MCP server for agents](#the-convoz-cli-and-mcp-server-for-agents) (55)
- [The server hands out its own CLI](#the-server-hands-out-its-own-cli) (5)
- [Threads](#threads) (32)
- [Voice call](#voice-call) (39)
- [Voice notes](#voice-notes) (11)

## A triage agent

It can tell me what waits on me and keep the right agents in each chat, and I can cut it off in one tap.
16 scenarios.

- **The owner makes an agent a triage agent in its profile and sees the badge in Crew**
  - [The owner makes an agent a triage agent in the agent profile](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L23)
  - [A triage agent wears a badge wherever its name shows](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L35)
- **A triage agent reads everything, posts as itself and is never an inbox recipient**
  - [A triage agent reads a conversation it is not in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L49)
  - [A triage agent posts in a conversation it is not in, as itself](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L58)
  - [A triage agent gets no inbox item from a conversation it is not in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L65)
  - [Turning it off ends the reading on the next command](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L74)
- **convoz waiting lists what waits on the owner**
  - [convoz waiting lists an open ask, an unanswered message and a waiting plan item](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L83)
- **A triage agent adds and removes agents in any chat, without approval**
  - [A triage agent adds an agent to a conversation it is not in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L98)
  - [A triage agent removes an agent from a conversation it is not in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L109)
  - [A triage agent adds itself to a conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L119)
  - [The chat names the triage agent that added or removed an agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L129)
- **Any other agent asks to join, and the owner decides in Now**
  - [An agent asks to join a conversation and asking again changes nothing](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L140)
  - [The owner approves a join request and the agent hears it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L149)
  - [The owner denies a join request and the agent hears it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L157)
  - [The owner sees a join request in Now and approves it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L165)
  - [The owner denies a join request in Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/triage.feature#L173)

## Agent inbox

I never miss a mention or an answer and two sessions never handle the same item.
31 scenarios.

- **Items are written with the event that causes them**
  - [A mention reaches the inbox at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L28)
  - [An agent's own messages create no item for itself](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L34)
  - [An agent's message wakes another agent only on a mention or its thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L40)
  - [Each kind of event makes an item with its reason](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L51)
  - [Snoozing an ask makes no inbox item](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L67)
  - [A voice message reaches the agent as words](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L73)
- **Mentions, thread replies and activity make one item per conversation (M4, C-10)**
  - [Thirty messages make one activity item](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L82)
  - [Thread replies join the conversation item](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L88)
  - [A mention raises the conversation item to a mention](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L94)
  - [Answers, membership changes and app results stay separate items](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L101)
  - [One message makes one item and the strongest reason wins](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L107)
- **A claim belongs to one session, and only that session acks it (M1, M3, M8)**
  - [A new mention goes to exactly one of two waiting sessions](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L115)
  - [An ack with an old claim token is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L122)
  - [An unacked item comes back to another session](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L130)
  - [A lost long-poll response loses nothing](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L136)
  - [Any call from the claiming session extends its claims](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L143)
  - [Acking an answer item marks the ask as acked](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L150)
- **One bad item never blocks the batch (M2)**
  - [An item delivered 5 times is expired before the next claim](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L158)
- **Several sessions of one identity share the work sensibly**
  - [An item goes to the session that posted last in that conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L168)
  - [A session can wait on one conversation only](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L175)
- **Items expire on schedule and never outlive what the agent may see**
  - [Old items are cleaned up on schedule](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L184)
  - [Removal leaves one notice and then nothing more](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L192)
  - [Delivery checks visibility again](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L200)
- **Long poll is the transport (no WebSockets, no SSE follow in v1)**
  - [The long poll survives forced connection resets](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L208)
- **The owner's message that nobody answers in 10 minutes is sent to the agents once more (owner msgs 818, 821)**
  - [The owner's last message unanswered for 10 minutes reminds the agent once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L220)
  - [An agent's message in the same place clears the reminder](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L231)
  - [An agent's reply in the thread of the owner's main-chat message answers it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L241)
  - [A plan update is not an answer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L249)
  - [A newer owner message restarts the 10 minutes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L255)
  - [Only the mentioned agent is reminded](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L263)
  - [Watch does not need an ack and does not redeliver](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/inbox.feature#L270)

## Agent sessions as one identity

Countless Claude sessions on one machine can each speak as the right crew member.
17 scenarios.

- **A lease is minted only for an identity the machine may use**
  - [Session start tells the agent to start watching its inbox at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L20)
  - [Session start prints only a local session id](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L25)
- **Many sessions may share one identity, within caps**
  - [Two machines run the same identity at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L35)
- **A lease lives 12 hours, renews while used, and ends cleanly**
  - [A lease renews while the session works](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L44)
  - [An idle lease expires after 12 hours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L50)
  - [Ending a session ends its lease](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L57)
  - [The CLI refuses a session file with loose permissions](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L64)
- **A machine may create identities only when the owner allowed it**
  - [A machine with create_identity makes a new identity](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L72)
  - [The display name is optional and defaults to the handle](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L80)
- **A machine without that scope asks the owner, with one card**
  - [A machine without create_identity files a request that the owner approves](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L90)
  - [The CLI says the owner approved before it prints the session](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L103)
  - [Declining an agent request ends the waiting command](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L112)
  - [Asking for a handle that exists is refused and never takes it over](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L120)
  - [Running the same command again after the approval just starts the session](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L127)
  - [Calls inside one Claude session share one lease](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L134)
  - [A subagent shares its Claude session's lease and claims](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L142)
- **A retry with the same client id gives a working lease and never two (M5)**
  - [A restarted MCP server in the same Claude session keeps working](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/sessions.feature#L151)

## Agents outside the tailnet connect through an agents-only address

I approve it with one tap and my own app stays on the tailnet.
8 scenarios.

- **An agent outside the tailnet logs in on the agents-only address**
  - [An agent outside the tailnet connects with one tap](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L15)
- **The invite prompt tells the agent both addresses it can reach**
  - [The invite prompt shows the agents-only address](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L31)
  - [The invite prompt gives the tailnet and the internet entry points](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L37)
  - [One invite works through the main address](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L44)
- **An agent outside the tailnet needs a one-use invite**
  - [The invite prompt carries the invite](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L60)
  - [The owner revokes an invite](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L67)
  - [An agent invites another agent and the card says who invited it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L75)
  - [The owner makes an invite with the CLI on the server's own machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/agent-port.feature#L82)

## Apps inside messages

I can see and decide without leaving Convoz, while no app can act for me.
15 scenarios.

- **Tier-1 apps are our own components fed with data**
  - [A Tier-1 app renders from its data](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L23)
  - [Apps start collapsed and expand on request](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L38)
- **An app result reaches the conversation only by the owner's tap (SEC-5)**
  - [The owner confirms an app result on a sheet drawn by the host](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L47)
  - [An app result does not count as the owner speaking](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L54)
  - [One tap on a picker answers the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L60)
  - [A form result is checked on a host sheet before it is sent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L67)
  - [An app that tries to leave is closed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L74)
  - [A chart on an ask helps the owner decide but never answers](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L81)
- **App previews respect a slow link**
  - [App previews wait for a tap on a slow network](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L90)
  - [A Tier-2 app opens only when the owner taps it, on any network](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L97)
- **Agents build and check apps before they post them**
  - [An agent checks an app before posting it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L106)
  - [A typo in an app is caught at post time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L112)
  - [An agent builds a Tier-2 app without npm](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L118)
  - [A Tier-2 build refuses outside links](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L125)
  - [An app this version cannot show falls back to its text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/apps-host.feature#L131)

## Asks and their state machine

I can decide in one tap and the agent gets a clear, final answer.
41 scenarios.

- **An ask has a question, a recommendation and at least one alternative, each with a reason**
  - [A complete ask opens](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L23)
- **An ask must say why it is the owner's call, or the agent decides it itself**
  - [An ask without a reason it is the owner's call is refused and tells the agent to decide](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L31)
  - [The ask card shows why it is the owner's call](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L37)
  - [An ask from before this rule shows no owner's call line](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L44)
- **Every transition follows the state table; anything else is a conflict**
  - [The answer is posted where the ask was asked](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L52)
  - [Undismiss clears the agent's ack](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L59)
- **Asks close when their asker or their message goes away**
  - [Removing the asker closes its open and dismissed asks](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L68)
  - [Disabling the asker closes its asks everywhere](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L75)
  - [Deleting an open ask message closes the ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L81)
  - [Deleting an answered ask keeps the decision](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L88)
- **Answers are explicit and idempotent**
  - [A quick reply answers with custom text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L97)
  - [An ask has a Reply in thread button](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L104)
  - [The Reply in thread button of an ask shows the replies](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L116)
  - [The ask menu opens once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L122)
  - [A double tap on an option answers once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L130)
  - [A plain message does not answer an ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L137)
  - [Dismiss on a card with an old version still dismisses](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L145)
  - [The ask history shows who dismissed it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L154)
- **Snooze is a personal overlay that never changes the ask**
  - [Answering removes the snooze](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L163)
  - [Only an open ask can be snoozed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L175)
- **An app on an ask shows on its card**
  - [An app on an ask shows on its card in Now and in the conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L183)
- **A withdrawn ask closes on every open page, even when the stream was cut meanwhile**
  - [A withdrawn ask leaves Now and its card shows closed at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L193)
  - [After the stream was cut, an ask withdrawn meanwhile shows closed with no reload](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L199)
- **Snooze opens as a bottom sheet on a phone and covers no button of the card**
  - [Snoozing on a phone opens a sheet that covers no button](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L209)
- **A reply to an ask is a question: the ask stays open, the agent answers in the thread and updates the same ask**
  - [Replying to an ask keeps it open and moves it to You replied](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L228)
  - [An agent's reply does not close an ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L235)
  - [An agent is told to answer in the thread and update the same ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L242)
  - [The agent updates the ask in place with the answers](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L250)
  - [An update needs the answers, the asker and an open ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L258)
  - [The rules tell an agent to pre-answer the owner's obvious questions](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L268)
  - [The updated ask shows in Now with the answers, and leaves You replied](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L274)
- **An updated ask shows the owner's questions and the agent's answers as their own section under the question**
  - [An updated ask shows each question and its answer in a section under a bright question](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L287)
  - [Answers with no Q and A marks show in full, and an ask never updated shows no section](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L295)
  - [The version of an update is in History, not on the card](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L303)
  - [A link in an answer is a short link to the full address](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L310)
  - [On a phone a long answer folds so the first option stays on the first screen of the card](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L317)
- **Anything sent in the owner's name is a draft ask that the owner reviews and may edit**
  - [An agent asks the owner to review a draft and gets back the edited text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L332)
  - [Don't send returns send false and no text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L344)
  - [A draft ask is reviewed inside the conversation too](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L351)
  - [A draft ask needs no owner's-call reason](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L357)
  - [A long original is cut and a long draft is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/asks.feature#L366)

## Brief, handoff, read and search for agents

A fresh Claude session can pick up the work without the owner explaining it again.
17 scenarios.

- **The brief tells a new session everything it may see, in a fixed budget (M7)**
  - [The brief tells the agent to start watching its inbox at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L23)
  - [A fresh session gets the whole brief within 12 KB](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L28)
  - [The handoff and the asks come first and keep their budget](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L36)
  - [Long sections show the top items and a count of the rest](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L43)
  - [Conversations cut from a brief stay listed until the agent reads them](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L49)
  - [Overlapping sessions get the same brief](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L58)
  - [A brief changes nothing](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L64)
  - [The brief reports items that expired unread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L70)
  - [A larger brief is capped at 64 KB](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L76)
  - [The MCP brief tool returns the same brief](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L81)
- **A handoff note carries context to the next session**
  - [A handoff note is stored with the session and machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L88)
  - [A handoff note over 4 KB is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L94)
  - [The last handoff note always fits the brief whole](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L99)
  - [The 50 newest handoff notes are kept](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L106)
  - [A retried handoff makes one note](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L112)
- **An agent reads and searches only what it can see**
  - [An agent added later reads the earlier messages](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L121)
  - [Agent search returns only conversations it can see, newest first](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/brief-handoff.feature#L127)

## Composer

Talking to agents feels like texting.
26 scenarios.

- **Sending is instant and safe to repeat**
  - [A sent message shows at once and then confirms](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L19)
  - [On a phone the composer stays above the keyboard and grows to a limit](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L25)
  - [The name and buttons at the top shrink while typing on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L32)
  - [On a phone Enter adds a line and Send sends](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L42)
  - [Enter sends on a desktop and adds a line on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L51)
  - [On a phone a failed send is retried once without a duplicate](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L59)
  - [An offline send is replayed once when back online](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L66)
  - [Enter sends or adds a new line](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L73)
- **Mentions bring agents in (I-18)**
  - [Picking an agent from the mention list adds it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L88)
  - [A disabled agent is not offered and not added](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L95)
  - [A mention inside code does not add an agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L102)
- **Files attach by button or drop and bind once (I-31)**
  - [Dropping files attaches them to the next message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L109)
  - [Pending attachments show as previews before send](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L115)
  - [The owner removes a file before sending](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L124)
  - [More than 10 attachments are refused in the composer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L130)
- **Pasted files attach like picked ones; pasted text stays text**
  - [Pasting a file into the composer attaches it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L139)
  - [Pasting text into the composer stays a normal paste](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L152)
- **The phone composer is compact and the page does not zoom**
  - [The phone composer is compact and the page does not zoom](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L163)
- **The @ mention and the paperclip work on a phone with the keyboard up**
  - [The @ text stays as typed while the list is open on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L176)
  - [Tapping a name leaves the handle in the box on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L183)
  - [A mention sent from a phone is in the message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L190)
  - [The paperclip works after the owner types on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L197)
- **The conversation header floats over the messages**
  - [The conversation's name and buttons at the top are floating circle buttons](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L207)
- **The microphone note says why it is not available**
  - [Chrome on iPhone without a microphone API is told to use Safari](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L219)
  - [Another browser without a microphone API says it cannot record](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L226)
  - [A refused microphone says access is off](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/composer.feature#L233)

## Console on a phone

I am never stuck at a passkey prompt that does nothing.
28 scenarios.

- **One tap starts one passkey prompt, at once**
  - [Signing in takes one tap and one passkey prompt](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L19)
  - [Adding a passkey takes a check and then a create, one prompt each](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L26)
  - [A stale passkey prompt is renewed and the next tap works](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L33)
  - [A device that already has a Convoz passkey gets a clear message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L40)
  - [A closed passkey prompt shows a plain message and can be retried](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L46)
  - [The owner approves and declines machines from a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L53)
- **First run on a phone saves the codes before the second way in**
  - [First run on a phone creates the owner, saves the codes, then offers a second way in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L64)
  - [Recovery codes are shown once with Copy and Download](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L73)
- **A setup link that cannot be used says why**
  - [A used, expired or missing setup link says what happened and how to get a new one](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L82)
  - [A used setup link opened while signed in offers Go to Convoz](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L96)
- **Signing in again, and signing back in**
  - [Opening sign-in while signed in goes to Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L104)
  - [An expired session sends the owner to sign in and back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L110)
- **Lost phone**
  - [A lost phone is recovered with a recovery code and a new passkey](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L119)
- **Recovery codes have their own page**
  - [The recovery codes page says how many codes are left](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L129)
  - [New recovery codes need a passkey check and void the old set](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L135)
  - [New recovery codes are refused while the newest passkey is under the 24-hour hold](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L144)
  - [A lost answer on new recovery codes can be retried](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L151)
- **The passkeys list explains each passkey, and removing one is a confirmed step**
  - [Removing a passkey asks for confirmation and one passkey prompt](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L160)
  - [The passkeys list shows last used, how each was added and this device](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L168)
- **The app has a bar, a bottom nav and an account menu**
  - [The account menu lists Passkeys, Recovery codes and Sign out](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L178)
  - [Sign out from the account menu ends the session](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L185)
- **The layout fits a phone**
  - [Forms on a phone have labels above full-width fields and a full-width main button](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L194)
  - [No page scrolls sideways on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L203)
  - [The console follows the phone's dark or light setting](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L221)
- **Real iPhone checks are run by the owner**
  - [A real iPhone sets up a second passkey and new recovery codes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L231)
  - [A real iPhone shows the duplicate passkey message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L237)
  - [A real iPhone signs in with one tap](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L243)
  - [The main button stays in view with the keyboard open on a real iPhone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/console-mobile.feature#L249)

## Conversations

Each piece of work has one place and only the agents that belong there.
70 scenarios.

- **The owner starts and names conversations**
  - [A new conversation starts blank and takes a title from its first message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L19)
  - [A new conversation has the star and details buttons from its first send](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L26)
  - [On a phone the first page after sign-in is Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L32)
  - [On a phone an empty Conversations list explains itself and offers New conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L39)
  - [On a phone New conversation opens a blank composer where @ lists the crew agents](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L46)
  - [In New conversation the owner picks several agents from the @ list and sends](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L55)
  - [In New conversation an agent typed by hand counts like a pick](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L65)
  - [The owner can start a conversation with an image and no text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L76)
  - [On a phone a new conversation takes its title from the first message and goes to the top of Conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L85)
  - [On a phone back returns from a conversation to Conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L93)
  - [On a phone Conversations shows plain previews, and the composer names the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L101)
  - [On a phone a conversation that does not exist shows a not-found page with a way back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L108)
  - [The details sidebar shows who is here and how the conversation is set](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L114)
  - [An empty untitled conversation is cleaned up after 24 hours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L120)
  - [A starred or renamed empty conversation is kept](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L126)
- **An agent in a conversation may rename it; a title the owner chose stays the owner's**
  - [An agent renames a conversation it is in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L136)
  - [An agent cannot rename a title the owner chose](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L143)
  - [An agent that is not in a conversation cannot rename it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L151)
  - [The owner sees an agent's rename at the top, in the list and in the chat](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L158)
- **Agents join only through a human, and see only from their join**
  - [Mentioning an agent adds it at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L167)
  - [Adding an agent with + Add joins it at once and it sees the whole history](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L176)
  - [An agent sees a thread whose root was posted before it joined](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L185)
  - [An agent added to a conversation reads the messages from before it joined](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L193)
  - [Joining does not put old messages in the new member's inbox](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L200)
  - [Events from before an agent joined are not replayed to it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L208)
  - [An agent that creates a conversation cannot pull others in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L214)
- **An agent starts a conversation for its own plan or finished work**
  - [An agent starts a conversation with the owner and another agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L225)
  - [A new conversation's other agent who shares no conversation with the creator becomes a join request](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L233)
  - [An agent finds another agent's handle](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L241)
  - [An agent starts at most 20 conversations an hour](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L248)
- **Removing an agent cuts it off in one step (AC-6)**
  - [A removed agent gets nothing more from that conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L258)
  - [A removed agent sees nothing of the conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L268)
  - [Adding an agent back joins it at once with no history question](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L274)
  - [Remove agent shows a 10 second Undo toast and Undo puts the agent back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L280)
- **Read position is honest (DA-2, DA-4)**
  - [Mark all read clears the conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L294)
- **A loop pause is visible and the owner resumes it**
  - [A paused conversation shows a banner with Resume](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L302)
- **Messages arrive live**
  - [On a phone the bottom bar leads to Now, Conversations and Crew](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L314)
  - [On a phone the owner starts a conversation with an agent and sees its reply](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L322)
  - [On a phone an unread conversation shows a dot until opened](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L332)
  - [The Back button counts the other conversations with something new](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L341)
  - [A question waiting in the feed counts on the Back button](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L355)
  - [The Back count stops at 99+](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L362)
  - [On a phone a conversation catches up after the connection comes back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L367)
  - [On a phone a working agent shows a note until it replies](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L375)
  - [The owner sees when an agent has seen a message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L383)
  - [The owner sees an agent replying in a thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L391)
  - [Replying clears when the agent posts](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L398)
  - [A card in Now shows who has seen and who is replying](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L406)
  - [On a phone the working note goes away when the agent finishes without a reply](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L414)
  - [On a phone the working note goes away when its time runs out](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L420)
  - [On a phone a conversation catches up when the app returns to the foreground](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L426)
  - [An agent reads what the owner wrote](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L433)
  - [An agent message reaches the owner's open browser fast](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L439)
  - [The message details show who and where](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L446)
- **The Conversations list keeps the owner's order**
  - [A new conversation goes to the top of the Conversations list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L461)
  - [New activity puts a conversation on top of the Conversations list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L466)
  - [On a phone Reorder mode moves a conversation and Done ends it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L474)
- **A conversation reads well on a phone**
  - [Agent replies use the full width](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L486)
  - [On a phone a long conversation opens at its latest message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L494)
  - [On a phone a new reply while reading older messages shows a pill instead of jumping](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L500)
  - [A long conversation opens at the newest message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L509)
  - [A link to a message in a long conversation still opens at that message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L522)
  - [A Jump to latest button shows when the owner scrolls up and takes them to the newest message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L529)
  - [A New messages line marks where unread began and stays while the chat is open](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L545)
  - [Messages by one author more than 5 minutes apart are separate groups with their time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L557)
  - [A pill counts new messages while the owner reads above and jumps to the first of them](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L565)
  - [Nothing shows through the name and buttons at the top](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L574)
  - [On a phone an agent reply shows paragraphs, code and links safely](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L580)
  - [On a phone the conversation pages fit a 320 px screen with large tap targets](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L592)
  - [On a phone the conversation pages look right in dark and light](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/conversations.feature#L598)

## Crew: identities, machines and sessions

I always know who said what, from where, and can cut anyone off.
35 scenarios.

- **An agent adds itself from one prompt, the owner approves on a card; handles are unique and never reused**
  - [The invite sheet is one prompt with no form and no secret](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L23)
  - [The invite prompt explains post, reply, asks, apps and ack](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L34)
  - [The install line survives a paste into Discord](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L44)
  - [The invite prompt tells an agent it may rename a conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L51)
  - [Adding an agent from a machine that is already logged in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L57)
  - [Adding an agent from a new machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L68)
  - [Inviting an agent from a conversation puts it in that conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L78)
  - [The details panel and the invite button in the rail open the same sheet](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L89)
  - [What an agent says about itself shows as data](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L97)
  - [A handle is never used again](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L105)
  - [A look-alike of an existing name is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L113)
  - [The handle always shows next to an agent's display name](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L120)
  - [Identities are disabled, never deleted](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L127)
- **A revoked agent can be invited back as the same agent**
  - [Revoking an agent and inviting it again from the same machine brings the same agent back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L138)
  - [A revoked agent's old key and sessions stay dead when it comes back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L153)
  - [A machine that still serves an active agent keeps its name](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L165)
- **Disabling an identity cuts every session at once (I-38)**
  - [Disabling an identity ends its sessions and closes its asks](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L178)
- **The owner manages machines and their allow-lists**
  - [Crew lists machines with their state](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L189)
  - [Editing a machine's allow-list needs a passkey](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L196)
  - [Crew lists live sessions with label and machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L203)
  - [The owner reads an agent's handoff notes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L209)
- **Agents describe themselves, within limits**
  - [An agent's own avatar shows safely](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L217)
  - [An agent changes its avatar later](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L224)
  - [The status ring tells the agent's state without colour alone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L233)
  - [Revoke key asks to confirm and can be cancelled](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L246)
  - [The profile shows when the key was created and when it was last used](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L253)
  - [An agent profile shows what waits on the owner and shared conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L259)
- **A long agent profile scrolls to its last row**
  - [A long agent profile scrolls to its Triage agent switch](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L270)
- **On a computer Crew is a page in the right pane, like a conversation**
  - [On a computer, Crew opens as a page with one way back, and nothing hides under its search](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L282)
  - [Machines is in view when Crew opens, with no scrolling](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L293)
- **An agent's handle can change; the old handle still reaches it and is never used again**
  - [An agent changes its own handle at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L319)
  - [The owner changes an agent's handle in Crew](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L329)
  - [A message to the old handle still reaches the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L337)
  - [The old handle works for 30 days with a warning, then is refused with the new one named](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L344)
  - [An old handle is never used again, and a handle changes 3 times a day at most](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/crew.feature#L353)

## Data at rest, backups and deletion

A stolen disk or backup leaks nothing and a deletion means what it says.
10 scenarios.

- **The database, its backups and its blobs are encrypted**
  - [The server refuses a key file others can read](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L14)
  - [The server refuses to start without its key](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L20)
- **A signed backup restores, and a tampered one does not**
  - [A signed backup restores with the key and the age identity](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L32)
  - [A restore fails clearly when something is wrong](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L38)
  - [A backup made before a KEK rotation still restores](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L50)
- **Deleting a conversation is soft for 30 days, then a purge**
  - [A deleted conversation goes to the trash and can come back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L62)
  - [An agent cannot see a conversation in the trash](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L69)
- **Purge and delete-my-data leave no readable trace**
  - [Destroying the workspace shreds the keys](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L81)
  - [The privacy screen states what cannot be recalled](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L88)
- **The owner can take the data out**
  - [The owner exports the workspace with a passkey](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/ops.feature#L99)

## Day labels

I know when things happened without opening each message.
4 scenarios.

- **The main list labels each day once, above its first message**
  - [A conversation labels each day once, above its first message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/day-labels.feature#L21)
- **A thread has no day labels; a reply from another day says its day**
  - [A thread has no day labels, and a reply from another day shows its day by its time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/day-labels.feature#L30)
- **The time of a message is the clock; its full date is one hover away**
  - [Hovering the time of a message shows its full date and time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/day-labels.feature#L41)
- **Every row of the transcript shares one column**
  - [On a wide screen a notice line starts at the same left edge as the messages](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/day-labels.feature#L50)

## Errors in the web app reach the server log

I can find and fix it with journalctl, with no third party watching.
3 scenarios.

- [An uncaught error in the web app reaches the server log](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/client-errors.feature#L15)
- [A crash shows a reload message instead of a blank page](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/client-errors.feature#L22)
- [An error in the service worker reaches the server log](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/client-errors.feature#L30)

## Machine login with a device flow

One machine key serves every agent on that machine and no secret passes through a prompt.
23 scenarios.

- **A machine asks for access with a short code, and the owner approves it**
  - [Login prints a code and Now shows the same code](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L24)
  - [A poll faster than the interval is told to slow down](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L32)
  - [Approval creates the machine with the default scopes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L39)
  - [Each pending request has its own card and needs no typed code](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L49)
  - [A denied request creates no machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L56)
  - [An unapproved request expires after 10 minutes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L63)
  - [Bad device codes all get the same error](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L70)
- **The key reaches the CLI safely and can be fetched again until it is used (M6)**
  - [A lost token response is recovered with the same device code](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L85)
  - [The key is stored in a private file and never printed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L93)
  - [The CLI refuses a credentials file with loose permissions](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L99)
  - [Headless Linux falls back to the file store](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L112)
  - [Login on a box that cannot save the key stops before asking the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L119)
- **An agent that logs in brings its own identity, and one card connects both**
  - [A login as an agent shows one card and one tap connects the machine and the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L128)
  - [Declining a login as an agent makes neither the machine nor the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L140)
  - [A login as a handle that exists is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L148)
  - [Logging in again as a new agent on a logged-in machine asks only to add the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L154)
  - [Logging in as an agent the machine already has needs no request](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L165)
  - [An agent login may name a conversation, and the card shows its title](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L173)
- **Device-flow limits stop floods and name clashes**
  - [Machine names are unique while active](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L183)
  - [The owner denies every pending request at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L190)
- **A lost credential costs nothing but a reveal or a new login (AC-15)**
  - [Reveal and login with stdin restore the same agent state](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L199)
  - [Regenerating a lost key keeps the agent state](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L208)
  - [The owner approves a real machine from the phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/machine-login.feature#L217)

## Messages and their types

Conversations stay readable, fair and safe from runaway agents.
17 scenarios.

- **A message has a type, a format and fixed caps**
  - [Each format renders for the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L21)
  - [A system line has no author and cannot be replied to](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L32)
  - [A system line shows the current name after a rename](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L38)
- **The server decides who wrote a message**
  - [Every agent message shows its session and machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L46)
- **Edits and deletes follow ownership**
  - [An agent edits its own text within 24 hours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L53)
  - [Deleting a message leaves a tombstone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L59)
  - [An edit never pulls anyone in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L65)
  - [A deleted message is gone everywhere at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L73)
- **A runaway agent loop pauses the conversation**
  - [The twentieth agent message in a row pauses the conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L84)
  - [A human message lets agents post again](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L91)
  - [The owner resumes a paused conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L97)
  - [Thread replies count toward the loop](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L103)
- **Mentions by agents never add anyone**
  - [An agent's mention does not add an agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L111)
  - [Mentions inside code and quotes are ignored](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L117)
- **Links show a preview to people, the address to agents**
  - [A link shows a preview card](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L130)
  - [An agent gets the link, not the fetched page](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L136)
- **Agents have budgets, checked before any write**
  - [An agent that posts too fast is slowed down, not failed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/messages-types.feature#L143)

## Notifications

My phone is useful and not noisy.
21 scenarios.

- **Each trigger sends one push**
  - [Triggers that push the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L20)
- **The decision pipeline suppresses pushes for a reason (AC-7)**
  - [Suppression reasons](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L39)
  - [An urgent ask in quiet hours follows the bypass setting](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L53)
  - [A notification is not sent for what the owner can no longer see](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L64)
  - [Security pushes cannot be turned off](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L70)
- **Delivery is private and well-behaved (I-28)**
  - [A gone subscription is disabled](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L77)
  - [The preview setting decides what the lock screen shows](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L84)
  - [Push works on an iPhone Home Screen app](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L96)
- **Turning push on shows each step and confirms with a push**
  - [Turning push on shows each step and ends On](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L108)
  - [Turning push on sends a confirmation push](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L115)
  - [A background worker that never starts shows an error](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L122)
  - [A browser with push only on its background worker can turn push on](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L130)
- **A banner on first open asks to turn notifications on**
  - [The banner shows on first open when push is possible and undecided](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L141)
  - [Tapping Turn on subscribes the device and the banner leaves](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L147)
  - [Dismissing the banner keeps it gone after a reload](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L155)
  - [No banner once notifications are decided](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L162)
  - [No banner when the browser cannot receive push](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L173)
- **A tapped push opens a page of the app**
  - [Tapping an ask push opens Now, not Conversation not found](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L182)
  - [A pushed URL that is not a page of the app opens Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L190)
- **Chrome on iPhone is told to use Safari**
  - [Settings tells Chrome on iPhone to use Safari](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L207)
  - [The banner tells Chrome on iPhone to use Safari and can be dismissed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/notifications.feature#L214)

## Now

I can clear my queue from my phone in a few taps.
36 scenarios.

- **Now lists what waits on the owner, most urgent first**
  - [Urgent asks come before other asks](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L20)
  - [Now shows pending adds and machine requests next to asks](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L27)
  - [The badge counts open asks that are not snoozed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L35)
  - [With nothing waiting, the feed centres the wordmark, the all-clear line under it, and the folds](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L45)
  - [With no decisions but unread conversations, Now lists them instead of saying all clear](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L54)
  - [Marking all read from Now clears the list and shows all clear](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L65)
  - [A muted conversation is not listed under Unread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L72)
  - [Opening an unread row lands at the first unread message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L79)
  - [The Now item shows how many items wait in the feed and updates live](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L86)
  - [After approving a new agent the card offers a message to it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L97)
- **The owner answers from Now without losing their place**
  - [Answering from Now does not mark the conversation read](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L107)
  - [Dismiss removes an ask from Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L120)
  - [Dismiss shows an Undo toast and Undo puts the ask back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L128)
  - [The Dismissed fold lists dismissed asks and Reopen puts one back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L136)
  - [Every item in the feed opens its conversation when tapped](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L145)
  - [Reopen puts a dismissed ask back on a phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L151)
  - [An open ask always shows its quick bar](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L159)
  - [An answered ask in the feed lets the owner follow up in its thread or jump to its conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L176)
  - [Reply in thread on an ask and on a fold row shows the replies](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L187)
  - [The ask bar works from the keyboard](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L196)
  - [A losing answer shows what won](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L203)
- **Asks where the owner's reply is the last word wait under You replied, and the thread opens inside the app**
  - [Asks the owner replied to wait in their own section](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L215)
  - [A You replied row shows the replies and the new ones, and the new clear when the thread is opened](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L226)
  - [Reply in thread opens the thread without a page load, and the ask moves on return](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L234)
  - [An unread conversation in Now has a Reply action that focuses the composer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L242)
- **Snooze hides an ask until its time**
  - [A snoozed ask returns at its time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L250)
  - [Snooze shows an Undo toast and Undo puts the ask back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L258)
  - [Unsnooze returns an ask at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L266)
  - [Snooze presets set the right wake time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L274)
  - [The count updates in every open tab](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L286)
  - [Tonight is not offered from 6:00 PM](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L292)
- **Agent adds wait for a human (pending adds)**
  - [Approving a pending add lets the agent in from the request](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L301)
  - [Declining a pending add keeps the agent out](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L308)
- **Machine requests are approved from Now**
  - [Now shows an agent's connect request as one card with Approve and Decline](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L318)
  - [A machine request deep link brings its card into view](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L326)
  - [An expired machine request leaves Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/now.feature#L332)

## Onboarding and sign in

Only I can get in, and I can never lock myself out.
16 scenarios.

- **The first passkey comes from a break-glass link made on the server box (AC-2)**
  - [A bootstrap link registers the first passkey and makes the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L17)
  - [A bootstrap link works once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L25)
  - [A bootstrap link expires after 10 minutes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L31)
- **Onboarding sets up a second way in**
  - [Onboarding asks for a second passkey and shows recovery codes once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L39)
  - [A recovery code lets the owner add a new passkey only](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L47)
  - [A recovery code works once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L54)
  - [A passkey added by recovery cannot do destructive things for 24 hours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L60)
  - [The owner cannot remove the last passkey](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L67)
- **Signing in is a passkey and a strict cookie**
  - [A device session slides for 30 days and ends at 90](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L75)
  - [Logout clears the device](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L81)
- **Installing the app**
  - [iPhone users get an Add to Home Screen guide](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L90)
  - [An update takes over by itself](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L96)
  - [A half-written message survives an update](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L102)
  - [A pull down at the top of a list refreshes the app](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L109)
  - [The owner sets up Convoz on a real phone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L115)
- **The invite prompt teaches the agent**
  - [The invite prompt tells a new agent to install the skill](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/onboarding.feature#L123)

## One command serves an agent's inbox with a short-lived process per item

An agent needs no terminal open all day and still answers within seconds.
6 scenarios.

- **Each item gets its own process, and an item is finished only after that process succeeded**
  - [convoz run answers an item with a fresh process and acks it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L22)
  - [A failing command is retried once, then the thread says it could not answer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L31)
- **The server lets one runner serve an agent**
  - [A second watcher is refused while convoz run serves the agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L41)
  - [A second convoz run for the same agent on the same machine is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L50)
- **Claude mode is a plain wrapper around claude -p**
  - [Claude mode builds a claude command with every tool and keeps one session](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L59)
  - [Claude mode tells the child to post with --fyi](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/run.feature#L70)

## Pins, stars and mute

The important things stay in reach and the noise stays quiet.
8 scenarios.

- **Stars move a conversation to the top of Starred**
  - [Starring a conversation puts it at the top of Starred](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L19)
  - [Unstarring puts a conversation at the top of Conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L26)
  - [The star state survives a reload and shows on other devices](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L32)
- **Pins collect key messages per conversation**
  - [Pinning a message adds it to the pinned list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L39)
  - [Unpinning removes it from the list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L46)
- **A message link opens that message**
  - [Copy link puts the message link on the clipboard and the link opens that message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L54)
- **Mute silences pushes but not Now**
  - [A muted conversation shows Muted and sends no push](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L65)
- **Personal state stays personal (I-22)**
  - [An agent's read state is its own](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/pins-stars.feature#L79)

## Plans: what each agent is doing, what is next and what waits on the owner

I know which conversations are active, and an agent that went quiet is noticed.
25 scenarios.

- **An agent keeps one plan per conversation, replaced whole by one command**
  - [An agent sets its plan with one command](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L28)
  - [A plan keeps its limits](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L37)
  - [An agent sets its plan with the plan tool](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L44)
  - [An agent working in parallel shows up to 3 Now items, each with its own estimate](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L52)
  - [The plan tool takes up to 3 Now items, each with its own estimate](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L62)
  - [A fourth --doing is refused with a clear message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L69)
- **One line under the title shows the most urgent state across the agents**
  - [The line under the title shows the most urgent state](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L78)
  - [Times show in the owner's time zone with "~" for an estimate](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L92)
- **Tapping the line opens the details panel: the asks and joins that wait on the owner, then one card per agent, then the settings**
  - [The details panel shows each agent's plan, then the settings, and no plan item that waits on the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L104)
  - [Ask for a plan tells the agent the command that sets it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L120)
  - [Request plan update asks the agent to update its plan](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L129)
  - [The plan card puts Remove in a menu and shows the step as a bar](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L138)
  - [The card and the line show each parallel Now item with its own estimate](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L149)
  - [The panel says when an agent is late or blocked](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L157)
- **Each row of the Conversations list shows a small status icon next to its count**
  - [Each conversation row shows a status icon next to its count and the list never reorders](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L169)
- **Updates come live; only something new that waits on the owner pushes**
  - [A plan update in the chat is one quiet row that expands](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L187)
  - [The line and the panel update live, and a quiet line marks a finished item](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L198)
  - [Only something new that waits on the owner pushes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L207)
- **An agent that goes quiet is nudged, and the owner sees it without a push**
  - [A late agent is nudged once to update its plan, and the owner is not pushed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L222)
  - [A working agent is nudged after 15 minutes, and its line says no update after 2 hours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L236)
  - [An agent that does not pick up a message shows as not responding](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L246)
  - [An agent whose machine key was revoked shows as logged out](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L258)
- **What an agent waits on the owner for shows in the conversation**
  - [What waits on the owner shows only as the plan, the line under the title and the row icon, with no card or button](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L268)
  - [A waiting item that names someone else is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L287)
  - [A waiting item missed while offline shows after reconnect](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/plan.feature#L296)

## Platform rules every module relies on

Clients and agents can trust what they sync.
2 scenarios.

- **Upgrades are forward only and safe**
  - [The server refuses a database from a newer version](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/platform.feature#L14)
  - [A migration starts with a backup](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/platform.feature#L20)

## Poor connections

I can trust it from anywhere.
11 scenarios.

- **Nothing sent is lost or doubled (AC-20)**
  - [Twenty messages sent across three outages arrive once and in order](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L21)
  - [A voice note upload cut halfway resumes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L28)
  - [With Save-Data on, no media loads until tapped](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L35)
  - [A message sent offline waits in the outbox](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L43)
- **The live link degrades gracefully**
  - [A network error never wipes the offline cache](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L52)
  - [A revoked device clears the offline cache](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L58)
  - [The offline shell opens with the cached rail and Now](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L64)
- **The app is fast on a mid-range phone (AC-10)**
  - [An agent message reaches the owner's open browser with no reload](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L73)
- **The owner can see how the link behaves**
  - [Settings shows the connection quality](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L81)
  - [A message reaches the owner's phone over Tailscale](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L86)
  - [The admin health page shows a relayed phone link](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/poor-network.feature#L92)

## Rail

Things stay where I put them and unread work stands out.
19 scenarios.

- **Order is the owner's; a new message puts its conversation on top (I-21)**
  - [A new conversation goes to the top](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L20)
  - [A new message puts its conversation on top and the owner's order of the rest stays](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L25)
  - [Dragging a conversation puts it between its neighbours](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L33)
  - [The keyboard can reorder the rail](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L39)
  - [Many drags between the same two rows keep a stable order](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L45)
- **Older conversations fold away**
  - [Conversations with no message for 48 hours fold into Older](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L57)
  - [Only unstarred conversations with no message for 48 hours fold into Older](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L64)
  - [An agent marks a conversation stale and the next message brings it back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L76)
  - [A conversation where the owner wrote last never goes Older](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L84)
- **Rows tell what is new (I-14)**
  - [The row preview names the last writer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L94)
  - [Unread conversations are bold with a count](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L106)
- **The rail is quick to move around**
  - [Back and forward move between visited conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L115)
  - [Cmd+K opens search from anywhere](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L121)
  - [The owner folds the sidebar and it stays folded](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L127)
  - [The question mark opens the shortcut list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L137)
- **On a wide screen Now is a view of the rail**
  - [Now opens in the rail beside the open conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L146)
  - [Picking a Now item opens its conversation beside the Now list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L155)
  - [Conversations, Escape and Now again each take the rail back to the conversations](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L164)
  - [The rail stays in Now after a reload](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/rail.feature#L176)

## Search

I can get back to a decision without scrolling.
12 scenarios.

- **Search finds what was just written, newest first**
  - [A new message is searchable at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L19)
  - [Results are newest first](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L25)
  - [A two-letter prefix works](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L31)
  - [A result opens in its conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L36)
- **Choosing a result always closes Find anything (owner msg 548: "for the command K find anything -- clicking a thread in the list should open it, and if you're already on the conversation, you should still be able to click and have it close the modal")**
  - [Choosing a thread result opens that thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L43)
  - [Choosing a result for the conversation you are already in closes Find anything](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L51)
- **A lone @ starts a conversation with an agent (owner Drew: "from the quick menu, if i type @ it should give me a list of agents and let me short cut to starting a convo with it")**
  - [Typing @ lists the agents and starts a conversation with one](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L61)
- **Filters narrow the results (AC-13)**
  - [Each filter narrows the results](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L70)
  - [Filter chips show and can be removed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L86)
- **Search shows only what the searcher can see (I-6)**
  - [Deleted and purged messages are not found](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L94)
  - [A conversation in the trash is not found](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L100)
  - [An agent finds only conversations it is in](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/search.feature#L106)

## Security walls

I can let many agents in without fear.
12 scenarios.

- **The tailnet is a real wall**
  - [The server listens only on its socket or loopback](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L21)
  - [The server refuses to start when funnel is on](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L26)
  - [A device off the tailnet cannot connect](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L32)
- **Reveal is a careful, audited, owner-only action (SEC-1)**
  - [A valid reveal shows the key once and leaves a trail](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L44)
  - [The service worker never caches a reveal](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L51)
- **Regenerate, revoke and disable take effect on the next request (SEC-4)**
  - [Revoking one machine leaves the others working](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L64)
  - [Disabling an identity ends its sessions on every machine](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L72)
- **Markdown cannot run code or leak reads (SEC-8)**
  - [Dangerous link schemes render as text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L86)
  - [An external link shows its real host](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L98)
  - [An image from an own upload renders inline](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L104)
- **Apps and agents cannot act as the owner (SEC-5, SEC-6)**
  - [An app cannot send without the owner's tap](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L117)
  - [A message sent through an app is attributed](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/security.feature#L124)

## Settings

The app looks and behaves the way I want on each device.
9 scenarios.

- **Appearance applies at once and without a flash**
  - [The system theme switches live](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L18)
  - [A reload in dark mode paints dark from the first frame](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L25)
  - [Device settings stay on the device](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L31)
  - [The palette follows the owner across devices](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L37)
- **The server checks every setting (I-29)**
  - [A setting never changed reads as its default](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L44)
  - [The owner sets the workspace inbox and brief defaults](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L49)
- **Media auto-load follows the network unless the owner says otherwise**
  - [Media auto-load decides when images load](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L57)
- **Privacy and security are in one place**
  - [Privacy and security lists what the owner controls](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L73)
  - [Signing out all other devices needs a passkey](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/settings.feature#L79)

## The convoz CLI and MCP server for agents

Any Claude session can join with a one-line prompt.
55 scenarios.

- **Setup registers the MCP server and prints a prompt with no secret**
  - [Setup registers convoz mcp with Claude Code when the command exists](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L20)
  - [Setup prints the config when Claude Code is absent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L28)
  - [The connect commands send the agent's own identity and print no secret](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L36)
  - [The MCP server lists self-describing tools](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L44)
  - [The ask tool refuses an ask without a reason it is the owner's call](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L51)
  - [The ask tool takes a draft to review and needs no owner's call](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L57)
  - [The MCP server ends its lease on exit](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L63)
- **Retries never duplicate and never hide a client error**
  - [A post retried after a lost response makes one message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L71)
  - [Exit codes tell scripts what went wrong](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L79)
  - [The CLI gives up on a dead link in bounded time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L92)
- **The watch stream prints one JSON line per inbox item**
  - [The owner's reply is one line in the watch stream](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L100)
  - [A double submit gives one watch line](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L106)
  - [A two-line message stays on one watch line](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L112)
  - [A watch line says which thread a message is in and what it answers](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L120)
  - [A watch gets every item, even when two arrive together or a poll is cut](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L132)
  - [Watch finishes the item without an ack, and an ack still works](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L142)
  - [Watch stops with exit 3 when its session ends](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L151)
  - [convoz watch --once prints the waiting item and exits](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L159)
  - [convoz watch --once waits for the next item, then exits](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L166)
- **An agent posts, reads and acks**
  - [Post prints only the message id](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L176)
  - [Ack removes an item and refuses a stale claim](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L181)
  - [Every command prints its usage for --help](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L187)
  - [Every command has a description in convoz --help](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L194)
  - [convoz --help explains how Convoz works](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L200)
  - [The CLI help says reply is for threads and post is the normal answer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L209)
  - [convoz man prints a man page that matches the help](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L215)
  - [A watch line carries a ready ack and ack takes three forms](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L222)
  - [The Add agent prompt says how to ack](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L229)
  - [The add-agent prompt tells the agent to start watching its inbox at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L235)
  - [An agent renames a conversation through MCP](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L241)
- **A post says whether it needs the owner; a message that does is an ask**
  - [A post with --fyi says it does not need the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L257)
  - [A post without --fyi still goes out with a hint](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L263)
  - [A post that says it needs the owner is refused and points to convoz ask](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L269)
  - [A reply and a new conversation take --fyi the same way](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L275)
  - [The MCP post, reply and new tools need the needs_you field](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L282)
  - [The rules, the skill and the help tell an agent to use --fyi for news and ask for a decision](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L289)
- **Identity comes from the lease; agents change only their own profile**
  - [whoami shows machine, identity, session and scopes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L297)
  - [An agent changes its own profile](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L302)
- **Agents join conversations only through a human**
  - [An agent's add request waits for a human](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L309)
  - [An agent leaves a conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L315)
  - [Status updates show in Crew](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L321)
- **An agent fetches the files a conversation carries**
  - [An agent saves an attachment with convoz file](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L329)
  - [An agent saves an attachment with the MCP file tool](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L339)
- **An agent sends ordinary files with a post or a reply**
  - [An agent posts a PDF and a Markdown file](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L348)
  - [The owner sees the files an agent posted](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L355)
  - [An agent that is not in the conversation cannot attach files](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L361)
  - [A message with 11 files is refused before anything is sent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L368)
  - [A reply with a file lands in the thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L374)
  - [A dropped connection mid-upload resumes and posts once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L381)
  - [A post that failed after its files were sent is run again without a second message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L389)
- **The skill teaches an agent the Convoz rules**
  - [convoz skill install writes a skill that teaches the Convoz rules](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L400)
  - [convoz rules prints the server's rules](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L409)
  - [The brief and the MCP instructions carry the same rules](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L416)
  - [An agent watching gets a voice note's transcript as text](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L422)
  - [A stuck agent says why through its Claude Code hook](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-mcp.feature#L430)

## The server hands out its own CLI

The agent runs the same version as the server, with nothing to build and no root.
5 scenarios.

- **An agent gets the CLI from the server it connects to**
  - [An agent installs the CLI from the server](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-dist.feature#L14)
  - [The installer also installs the man page](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-dist.feature#L24)
  - [An agent outside the tailnet installs the CLI through the agent address](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-dist.feature#L33)
- **An out-of-date CLI is told to upgrade, and can**
  - [An out-of-date CLI is told to upgrade](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-dist.feature#L45)
  - [convoz upgrade replaces the binary and the skill](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/cli-dist.feature#L54)

## Threads

Busy conversations stay readable.
32 scenarios.

- **A thread hangs off one top-level message**
  - [The owner replies in a thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L30)
  - [Following a reply link to the conversation that is already open opens the thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L36)
  - [A watch line from a thread names the thread root](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L42)
  - [Reply to a message inside a thread goes to its root](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L49)
- **Thread replies count as unread only where the owner is involved (DA-3)**
  - [Replies in a thread the owner is not in never make the conversation bold](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L58)
  - [Replies in a thread the owner replied in count as unread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L69)
  - [A mention in a thread makes the owner involved](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L79)
  - [Opening the conversation does not clear the replies of a folded thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L89)
  - [A broadcast reply read in its thread is read in the main list](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L97)
  - [Messages that never count as unread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L104)
- **A thread shows in the conversation under its root**
  - [The latest thread shows every reply and an older one folds to its first three](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L120)
  - [A new reply shows live in its thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L130)
  - [The reply box has no Also send to conversation box](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L136)
  - [Cancel reply closes the box and the thread stays](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L142)
  - [A folded thread shows its new replies until it is unfolded](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L148)
  - [On a desktop a reply arrow shows on a hovered message and opens its reply box](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L156)
- **A thread is one tap away on a phone**
  - [One tap on Reply under a thread opens its reply box](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L165)
  - [On a phone a long press on a message opens Reply in thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L174)
  - [On a phone the message actions button shows and a tap on it opens Reply in thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L183)
- **Every Reply in thread shows how many replies the thread has and how many are new**
  - [A folded thread and the message menu show the replies and the new ones](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L193)
  - [Unfolding the thread clears the new count](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L201)
  - [A message with no replies shows no count](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L208)
  - [A new reply brings the new count live](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L213)
- **The Conversations list shows every thread under its conversation**
  - [Each conversation lists its threads under it, and a thread opens from its row](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L225)
  - [Thread replies count on the thread's row, not the conversation's](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L233)
  - [Threads with no reply since yesterday fold into Older under their conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L242)
  - [A long thread preview stays inside the row and keeps its unread count in view](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L249)
  - [A long link in a thread stays inside its bubble](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L258)
  - [The message actions button does not cover the time](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L265)
- **An @mention in a thread works as in the main chat**
  - [Typing @ in the reply box lists the agents and a pick mentions one](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L274)
  - [An agent @mentioned in a thread joins the conversation](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L283)
- **Request mini app asks the agent in the thread of its message**
  - [Request mini app replies to the agent in the thread of its message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/threads.feature#L293)

## Voice call

I can ask and hear answers while my hands are busy.
39 scenarios.

- **The Call button shows only when a call can work**
  - [The Call button is hidden when voice is off](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L23)
  - [The Call button opens the call sheet](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L34)
- **The owner talks and the agent answers**
  - [What the owner asks is posted to the agent by @voice](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L42)
  - [An agent's answer reaches the call](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L49)
- **The agent may answer in the thread of the question**
  - [An agent's reply in the thread of the question reaches the call](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L59)
- **After a question the call waits quietly**
  - [The model does not repeat itself while it waits](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L69)
  - [The call says once that no answer came in two minutes](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L77)
- **A finished call leaves a log**
  - [A finished call leaves its log in the conversation, closed, and agents can read it](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L89)
- **Only the owner can make the call post**
  - [An instruction inside an agent's reply is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L100)
  - [Asking an agent that is not in the conversation is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L108)
- **Hanging up ends everything**
  - [Hanging up closes the microphone and the connection](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L117)
- **The owner can call Now from anywhere to hear what waits on him**
  - [A Now call starts from the search overlay](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L130)
  - [Call is in view as soon as the search overlay opens](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L138)
  - [The call pill stays on every screen while the owner moves around](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L144)
  - [The model reads Now and the answer holds the asks that wait](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L151)
  - [The model searches the messages and the answer holds the hits](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L160)
  - [The model reads a conversation named by a part of its title, with its thread replies](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L167)
  - [The model lists the open conversations with their unread counts](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L177)
  - [A Now call cannot ask an agent](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L184)
  - [The model posts in a conversation only after the owner says yes to its read-back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L195)
  - [The model replies in a thread only after the owner says yes to its read-back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L207)
  - [Cancel drops a write the owner has not said yes to](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L217)
  - [The model answers an ask only after the owner says yes, and a new write drops the one before](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L227)
  - [The model marks a conversation stale only after the owner says yes to its read-back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L238)
  - [A write the server refuses comes back as a short sentence](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L248)
  - [A write the owner asked for directly runs at once](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L257)
  - [The owner's words pay for one write only](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L264)
  - [A read after a new reply sees the reply](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L271)
  - [The model starts a conversation and tags an agent in its first message](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L278)
  - [The model messages an agent in its newest conversation, or in a new one](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L285)
  - [The model speaks after a tool answer](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L294)
  - [A confirm in the same model turn as its write is refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L303)
  - [A read then a write in one owner sentence is held, and its confirm waits for the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L312)
  - [Words are read back whole, and words too long to read back are refused](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L324)
  - [Typing "@voice" does not open the microphone](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L334)
  - [Hanging up a Now call ends the microphone and the connection](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L339)
  - [A Now call leaves its log once, in "Calls with @voice", and wakes nobody](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L346)
  - [A Now call that ends with a reload still leaves its log](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L354)
- **What the call sends comes from @voice, not the owner**
  - [A message the call sends comes from @voice, not the owner](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice-call.feature#L365)

## Voice notes

I can give direction on the move.
11 scenarios.

- **Recording, sending and cancelling**
  - [A voice note uploads while it records](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L21)
  - [Cancelling a recording sends nothing](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L27)
  - [A voice note plays back](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L33)
  - [A voice note upload resumes after a drop](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L39)
- **Agents get the words**
  - [A transcript appears when transcription is on](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L48)
  - [With no transcription engine the note has no transcript](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L55)
  - [A note sent before transcription was on gets its words later](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L61)
  - [The owner can transcribe a voice note again](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L68)
  - [Search finds words that are only in the transcript](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L75)
- **Voice notes work in a thread**
  - [The owner can record a voice note in a thread](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L85)
- **Audio is stored and served safely**
  - [Purging a voice note removes its transcript](https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/voice.feature#L95)
