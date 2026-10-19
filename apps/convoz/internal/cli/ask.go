package cli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// repeated is a flag that may stand more than once; each use adds a value.
type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, ", ") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

// Ask runs `convoz ask --question Q --recommend L --why W --alt L --alt-why W [--alt ... --alt-why ...] --owners-call KIND
// --owners-call-why W [--urgent] [--thread ROOT] [--client-id C] <conv>`: the agent asks the owner a question with a recommendation and
// up to 4 alternatives, each with its reason, and says why only the owner can decide it. Without that the ask is refused with exit 2 and
// the agent is told to decide it itself. It prints the ask id. A lost answer is retried with the same client id, so the server opens the ask once. There is no command to
// answer an ask: a person answers it (design §8.1, C-3).
func Ask(args []string, io IO) int {
	usage := "usage: convoz ask --question Q --recommend L --why W --alt L --alt-why W [--alt L --alt-why W]... --owners-call KIND --owners-call-why W [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>"
	f := newChatFlags("ask", io)
	question := f.fs.String("question", "", "the question (at most 500 characters)")
	recommend := f.fs.String("recommend", "", "the option you recommend")
	why := f.fs.String("why", "", "why you recommend it")
	var alts, altWhys repeated
	f.fs.Var(&alts, "alt", "an alternative option (1 to 4 times)")
	f.fs.Var(&altWhys, "alt-why", "why that alternative is on the table (once for each --alt, in order)")
	callKind := f.fs.String("owners-call", "", "why only the owner can decide: one-way, taste, values or scope")
	callWhy := f.fs.String("owners-call-why", "", "the reason it is the owner's call (1 to 280 characters)")
	urgent := f.fs.Bool("urgent", false, "the owner is waiting on it")
	thread := f.fs.Int64("thread", 0, "ask in the thread of this root message")
	appOpt := newAppOpts(f, "a file holding an app (app.v1 JSON) to show with the question")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) == 2 && pos[0] == "withdraw" {
		return askWithdraw(f, io, pos[1])
	}
	if len(pos) != 1 {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	call := wire.OwnersCall{Kind: *callKind, Reason: *callWhy}
	if problem := call.Problem(); problem != "" {
		return refuse(io, problem)
	}
	switch {
	case strings.TrimSpace(*question) == "" || strings.TrimSpace(*recommend) == "" || strings.TrimSpace(*why) == "":
		return usageError(io, "an ask needs --question, --recommend and --why")
	case len(alts) == 0 || len(alts) != len(altWhys):
		return usageError(io, "give each --alt its --alt-why (at least one alternative)")
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	req := wire.AskRequest{
		ConversationID: conv, ThreadRootID: *thread, ClientID: *clientID, Question: *question, Urgent: *urgent, OwnersCall: call,
		Recommended: wire.AskOptionRequest{Label: *recommend, Why: *why},
	}
	for i, label := range alts {
		req.Alternatives = append(req.Alternatives, wire.AskOptionRequest{Label: label, Why: altWhys[i]})
	}
	var bundle string
	if appOpt.set() {
		raw, b, code := appOpt.check(io)
		if code != ExitOK {
			return code
		}
		req.App, bundle = raw, b
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if appOpt.set() {
		var code int
		if req.App, code = appOpt.send(k, conv, req.App, bundle); code != ExitOK {
			return code
		}
	}
	var out wire.OneAsk
	if err := k.callRetry("POST", wire.RouteAsks, req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": out.Ask.ID, "conversation_id": out.Ask.ConversationID, "state": out.Ask.State})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Ask.ID)
	}
	return ExitOK
}

// refuse tells the agent on stdout and on stderr, so a script that reads either one sees it, and exits with the usage code.
func refuse(io IO, msg string) int {
	fmt.Fprintln(io.Stdout, msg)
	return usageError(io, msg)
}

// askWithdraw runs `convoz ask withdraw <id>`: the asker takes back its open ask.
func askWithdraw(f *chatFlags, io IO, rawID string) int {
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return usageError(io, rawID+" is not an ask id")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if err := k.callRetry("POST", fmt.Sprintf("%s/%d/withdraw", wire.RouteAsks, id), struct{}{}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": id, "withdrawn": true})
	}
	return ExitOK
}
