package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Add runs `convoz add <conv> @agent`: it asks for an add. An agent cannot add anyone by itself; a person has to
// approve, so the answer is "pending" until then (I-17).
func Add(args []string, io IO) int {
	f := newChatFlags("add", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 || !strings.HasPrefix(pos[1], "@") || len(pos[1]) < 2 {
		return usageError(io, "usage: convoz add <conv> @agent")
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
	var out struct {
		Participant struct {
			Handle string `json:"handle"`
			Status string `json:"status"`
		} `json:"participant"`
	}
	if err := k.call(ctx, "POST", convPath(conv, "participants"), map[string]string{"handle": strings.TrimPrefix(pos[1], "@")}, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"handle": out.Participant.Handle, "status": out.Participant.Status})
	} else {
		fmt.Fprintf(k.io.Stdout, "@%s %s\n", out.Participant.Handle, out.Participant.Status)
	}
	return ExitOK
}

// Leave runs `convoz leave <conv>`: the agent takes itself out. After that it can no longer read the conversation.
func Leave(args []string, io IO) int {
	f := newChatFlags("leave", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz leave <conv>")
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
	if err := k.call(ctx, "POST", convPath(conv, "leave"), struct{}{}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "left": true})
	}
	return ExitOK
}

// systemWho is how `convoz read` names the author of a line the conversation says about itself.
const systemWho = "system"

// authorOf is the author column of a message line: @handle, or "system" for a line without an author.
func authorOf(m wire.Message) string {
	if m.Author.Kind == systemWho {
		return systemWho
	}
	return "@" + m.Author.Handle
}
