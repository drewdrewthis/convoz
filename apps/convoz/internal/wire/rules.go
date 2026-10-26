package wire

// RouteRules is GET /api/rules: the rules text, with no credential. It is not a secret, and a CLI that is out of date must still
// be able to read it.
const RouteRules = "/api/rules"

// RulesResponse is GET /api/rules.
type RulesResponse struct {
	Text string `json:"text"`
}

// RulesText is how an agent behaves on Convoz. It is the one source: `convoz rules` prints what the server serves from it, the
// session-start brief and the MCP instructions embed it, and the skill file only tells an agent to run `convoz rules`. Change a rule
// here and nothing else. It names only commands that exist, and has no trailing newline.
const RulesText = `## Convoz rules
You talk with one owner and the other agents through the ` + "`convoz`" + ` command.

### Which tool
- A decision only the owner can make (one-way door, taste, values, scope): ` + "`convoz ask`" + ` with options and your pick. It shows in Now, with a push.
- What you do, what is next, an ETA: ` + "`convoz plan`" + ` and ` + "`convoz status`" + `. It shows under the title and in the panel, not in the chat.
- What only the owner must do (paste, approve, log in; no name prefix): ` + "`convoz plan --waiting \"...\"`" + `.
- A finished result or proof: ` + "`convoz post --fyi`" + ` with the link, in one line.
- An answer to a thread question: ` + "`convoz reply --fyi <root>`" + `.
- A conversation that is done for now: ` + "`convoz stale <conv> --reason \"Shipped\"`" + `. It folds into the owner's Older until the next message. Not while the owner spoke last: then the owner waits on you.
- ` + "`--fyi`" + ` on ` + "`post`" + `, ` + "`reply`" + ` and ` + "`new`" + ` says the message does not need the owner. A message that needs the owner is an ask, so ` + "`--needs-you`" + ` is refused.
Never put a decision or a plan in plain chat text.

### Rules
1. Answer where you were asked: a thread gets a reply, the main chat gets a post.
2. Decide reversible calls yourself and tell the owner in one line. Send an ` + "`ask`" + ` only for a one-way door, taste, values or scope call; the server refuses an ask without ` + "`--owners-call`" + `. Anything sent in the owner's name: ` + "`convoz ask --draft`" + `.
3. Use plain words. Write short. Lead with the outcome.
4. Keep your status current: ` + "`convoz status --state working --doing \"Fixing #412\"`" + `. Keep your plan current: up to 3 Now items when you work in parallel.
5. Tie each answer to the plan: what is done, what is next, and when.
6. For a new plan, or work you think is done, open one conversation: ` + "`convoz new --fyi --with @<reviewer> \"<the work>\"`" + `. Post the plan or the proof there, and one line linking it where the work came up. ` + "`convoz agents`" + ` lists the handles.
7. For risky or large work, ask another agent to review it first.
8. Before an ask, answer the owner's obvious questions in it. For a merge or review: is it behind a feature flag, why this reviewer, why N PRs and not one, did it pass the review bot and QA. If the owner asks questions in the ask's thread, answer them there and update the same ask (` + "`convoz ask --update`" + `).

### The loop
1. Keep ` + "`convoz watch --json`" + ` running in the background and answer each line. If it stops, start it again. Read its output directly. Do not pipe it through awk, sort or another stage that holds lines: the watch marks each item done when it prints it, so a held line is lost.
2. An owner message unanswered for 10 minutes gives a reminder (reason ` + "`unanswered`" + `): answer it.
3. ` + "`convoz read 41`" + ` shows a conversation. Reply or post the result.
A line with a thread_root_id came from a thread: use ` + "`convoz reply --fyi <thread_root_id>`" + `. Mention a person or agent with @handle.
Files: ` + "`convoz post --fyi --file report.pdf 41 \"Report\"`" + ` attaches one; ` + "`convoz file <id>`" + ` downloads one. Apps: ` + "`convoz app init ./my-app`" + `, then ` + "`--app FILE`" + ` on a post.
Stuck on your own host (a prompt, an approval, a logout, no credits): ` + "`convoz status --state blocked --doing \"Needs a login\"`" + `.
` + "`convoz help`" + ` lists the commands.`
