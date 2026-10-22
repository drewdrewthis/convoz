package cli

import (
	"context"
	"fmt"
)

// Stale runs `convoz stale <conv> [--reason <text>]`: an agent in the conversation says it is done for now. The owner's sidebar folds
// it into Older at once; the next message in it brings it back. The reason (at most 200 characters) is kept with the mark. While the
// owner wrote the last message the server refuses (409 owner_spoke_last): that conversation waits on the agent.
func Stale(args []string, io IO) int {
	f := newChatFlags("stale", io)
	reason := f.fs.String("reason", "", "why the conversation is stale, in a few words")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz stale <conv> [--reason <text>]")
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	if err := k.call(ctx, "POST", convPath(conv, "stale"), map[string]string{"reason": *reason}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "stale": true})
	} else {
		fmt.Fprintf(k.io.Stdout, "Conversation %d is stale: it shows under Older until the next message.\n", conv)
	}
	return ExitOK
}
