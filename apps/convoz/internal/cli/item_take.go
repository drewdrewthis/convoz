package cli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// stepList is a repeatable --step flag.
type stepList []string

func (s *stepList) String() string     { return strings.Join(*s, "; ") }
func (s *stepList) Set(v string) error { *s = append(*s, v); return nil }

// itemTake runs `convoz item take <message-id> [--question Q] --context C [--step S]... [--plan P]`: the agent takes a question of the
// owner. The item is on his message, started; each --step is a research step, pending after it. Optional: a quick answer is a plain reply.
func itemTake(args []string, io IO) int {
	usage := "usage: convoz item take <message-id> --context C [--question Q] [--step S]... [--plan P]"
	f := newChatFlags("item take", io)
	question := f.fs.String("question", "", "the question as the item's title (plain text, 200 characters); empty uses the message")
	context := f.fs.String("context", "", "why, in a sentence or two (plain text, 2000 characters)")
	plan := f.fs.String("plan", "main", "the plan this item is in")
	var steps stepList
	f.fs.Var(&steps, "step", "a research step, pending after the question (repeatable)")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, usage)
	}
	msg, err := strconv.ParseInt(pos[0], 10, 64)
	if err != nil || msg <= 0 {
		return usageError(io, fmt.Sprintf("%q is not a message id. %s", pos[0], usage))
	}
	if strings.TrimSpace(*context) == "" {
		return usageError(io, "--context is required: say in a sentence or two why, for the owner. "+usage)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.TakeResponse
	req := wire.TakeRequest{Question: *question, Context: *context, Steps: steps, Plan: *plan}
	if err := k.callRetry("POST", fmt.Sprintf("/api/messages/%d/take", msg), req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
		return ExitOK
	}
	for _, it := range out.Items {
		fmt.Fprintf(k.io.Stdout, "%s %s: %s\n", it.Key, it.State, it.Title)
	}
	return ExitOK
}
