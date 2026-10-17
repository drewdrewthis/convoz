package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// list is a flag that may stand more than once; the values keep their order.
type list []string

func (l *list) String() string     { return fmt.Sprint([]string(*l)) }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

// Ask limits (design §8.1): a question and every option are short, and an ask has one to four alternatives.
const (
	maxQuestion = 500
	maxLabel    = 120
	maxWhy      = 280
	maxAlts     = 4
)

// Ask runs `convoz ask <conv> --question Q --recommend L --why W --alt L --alt-why W [...]`: it puts a question to the
// humans of a conversation, with the answer the agent recommends and why, and at least one alternative and why. Every part
// is required. It prints the ask id. `convoz ask withdraw <id>` takes an open ask back.
func Ask(args []string, io IO) int {
	f := newChatFlags("ask", io)
	question := f.fs.String("question", "", "what the agent asks, at most 500 characters")
	recommend := f.fs.String("recommend", "", "the answer the agent recommends")
	why := f.fs.String("why", "", "why it recommends that")
	var alts, altWhys list
	f.fs.Var(&alts, "alt", "an alternative answer; give --alt-why after it. 1 to 4 times")
	f.fs.Var(&altWhys, "alt-why", "why this alternative is worth choosing")
	urgent := f.fs.Bool("urgent", false, "the owner sees it first")
	thread := f.fs.Int64("thread", 0, "ask in the thread of this message")
	appFile := f.fs.String("app", "", "a file holding an app (app.v1 JSON) to show with the question")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) == 2 && pos[0] == "withdraw" {
		return askWithdraw(f, io, pos[1])
	}
	const usage = "usage: convoz ask <conv> --question Q --recommend L --why W --alt L --alt-why W [--alt L --alt-why W ...] [--urgent] [--thread ROOT]"
	if len(pos) != 1 {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	req := wire.AskRequest{ConversationID: conv, Question: *question, Recommended: wire.AskOption{Label: *recommend, Why: *why}, Urgent: *urgent, ThreadRootID: *thread}
	if len(alts) != len(altWhys) || len(alts) < 1 || len(alts) > maxAlts {
		return usageError(io, fmt.Sprintf("an ask has 1 to %d alternatives, and each --alt has an --alt-why", maxAlts))
	}
	for i := range alts {
		req.Alternatives = append(req.Alternatives, wire.AskOption{Label: alts[i], Why: altWhys[i]})
	}
	if msg := askProblem(req); msg != "" {
		return usageError(io, msg)
	}
	if *appFile != "" {
		raw, err := os.ReadFile(*appFile)
		if err != nil || !json.Valid(raw) {
			return usageError(io, fmt.Sprintf("--app %s is not a file of JSON", *appFile))
		}
		req.App = raw
	}
	if req.ClientID = *clientID; req.ClientID == "" {
		req.ClientID = "convoz-" + randomHex(8)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := k.callRetry("POST", wire.RouteAsks, req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]int64{"id": out.ID, "conversation_id": conv})
	} else {
		fmt.Fprintln(k.io.Stdout, out.ID)
	}
	return ExitOK
}

// askProblem names the first part of an ask that is empty or too long, or "" when the ask is whole.
func askProblem(r wire.AskRequest) string {
	check := func(name, v string, max int) string {
		switch n := utf8.RuneCountInString(v); {
		case n == 0:
			return name + " is required"
		case n > max:
			return fmt.Sprintf("%s is at most %d characters", name, max)
		}
		return ""
	}
	parts := []struct {
		name, value string
		max         int
	}{{"--question", r.Question, maxQuestion}, {"--recommend", r.Recommended.Label, maxLabel}, {"--why", r.Recommended.Why, maxWhy}}
	for _, a := range r.Alternatives {
		parts = append(parts, struct {
			name, value string
			max         int
		}{"--alt", a.Label, maxLabel}, struct {
			name, value string
			max         int
		}{"--alt-why", a.Why, maxWhy})
	}
	for _, p := range parts {
		if msg := check(p.name, p.value, p.max); msg != "" {
			return msg
		}
	}
	return ""
}

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
