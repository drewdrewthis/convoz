package cli

import (
	"fmt"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func init() {
	Register(Command{Name: "typing", Summary: "Show the owner that you are replying.", Example: "convoz typing --as code-review --thread 812 41", Order: 57, Run: Typing,
		Usage: "convoz typing [--thread MESSAGE] <conv>"})
}

// Typing runs `convoz typing [--thread MESSAGE] <conv>`: the owner sees "@you is replying…" in the conversation, or in the thread
// of MESSAGE, for 30 seconds. A claim shows it by itself; this is for work without one. Call again to keep it up. Posting ends it.
func Typing(args []string, io IO) int {
	f := newChatFlags("typing", io)
	thread := f.fs.Int64("thread", 0, "a message of the thread you are replying in")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 || *thread < 0 {
		return usageError(io, "usage: convoz typing [--thread MESSAGE] <conv>")
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if err := k.callRetry("POST", convPath(conv, "typing"), wire.TypingRequest{ThreadRoot: *thread}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "thread": *thread})
	} else {
		fmt.Fprintln(k.io.Stdout, strconv.FormatInt(conv, 10))
	}
	return ExitOK
}
