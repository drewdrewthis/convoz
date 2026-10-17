package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// repeated is a flag that may stand more than once; each use adds a value.
type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, ", ") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

// Ask runs `convoz ask --question Q --recommend L --why W --alt L --alt-why W [--alt ... --alt-why ...] [--urgent] [--thread ROOT]
// [--client-id C] <conv>`: the agent asks the owner a question with a recommendation and up to 4 alternatives, each with its reason.
// It prints the ask id. A lost answer is retried with the same client id, so the server opens the ask once. There is no command to
// answer an ask: a person answers it (design §8.1, C-3).
func Ask(args []string, io IO) int {
	usage := "usage: convoz ask --question Q --recommend L --why W --alt L --alt-why W [--alt L --alt-why W]... [--urgent] [--thread ROOT] [--client-id C] <conv>"
	f := newChatFlags("ask", io)
	question := f.fs.String("question", "", "the question (at most 500 characters)")
	recommend := f.fs.String("recommend", "", "the option you recommend")
	why := f.fs.String("why", "", "why you recommend it")
	var alts, altWhys repeated
	f.fs.Var(&alts, "alt", "an alternative option (1 to 4 times)")
	f.fs.Var(&altWhys, "alt-why", "why that alternative is on the table (once for each --alt, in order)")
	urgent := f.fs.Bool("urgent", false, "the owner is waiting on it")
	thread := f.fs.Int64("thread", 0, "ask in the thread of this root message")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
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
		ConversationID: conv, ThreadRootID: *thread, ClientID: *clientID, Question: *question, Urgent: *urgent,
		Recommended: wire.AskOptionRequest{Label: *recommend, Why: *why},
	}
	for i, label := range alts {
		req.Alternatives = append(req.Alternatives, wire.AskOptionRequest{Label: label, Why: altWhys[i]})
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.OneAsk
	var err error
	slowUntil := time.Now().Add(maxSlowDown)
	for try := 1; ; {
		ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
		err = k.call(ctx, "POST", wire.RouteAsks, req, &out)
		cancel()
		if wait := slowDown(err); wait > 0 && time.Now().Add(wait).Before(slowUntil) {
			time.Sleep(wait)
			continue
		}
		if !errors.Is(err, errUnreachable) || try >= 3 {
			break
		}
		time.Sleep(time.Duration(try) * 300 * time.Millisecond)
		try++
	}
	if err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": out.Ask.ID, "conversation_id": out.Ask.ConversationID, "state": out.Ask.State})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Ask.ID)
	}
	return ExitOK
}
