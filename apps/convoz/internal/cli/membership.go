package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Add runs `convoz add <conv> @agent`: it asks for an add. An agent cannot add anyone by itself; a person has to
// approve, so the answer is "pending" until then (I-17). A triage agent adds at once, in any conversation.
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

// Join runs `convoz join <conv>`: the agent asks for a seat in a conversation it is not in. The owner approves or denies it in Now, so the
// answer is "pending" until then; a triage agent just joins.
func Join(args []string, io IO) int {
	f := newChatFlags("join", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz join <conv>")
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
			Status string `json:"status"`
		} `json:"participant"`
	}
	if err := k.call(ctx, "POST", convPath(conv, "join-requests"), struct{}{}, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "status": out.Participant.Status})
	} else {
		fmt.Fprintf(k.io.Stdout, "%s\n", out.Participant.Status)
	}
	return ExitOK
}

// Remove runs `convoz remove <conv> @agent`: a triage agent takes an agent out of any conversation. The server refuses any other agent.
func Remove(args []string, io IO) int {
	f := newChatFlags("remove", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 || !strings.HasPrefix(pos[1], "@") || len(pos[1]) < 2 {
		return usageError(io, "usage: convoz remove <conv> @agent")
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
	var view struct {
		Conversation struct {
			Participants []wire.Person `json:"participants"`
		} `json:"conversation"`
	}
	if err := k.call(ctx, "GET", fmt.Sprintf("%s/%d", wire.RouteConversations, conv), nil, &view); err != nil {
		return k.fail(err)
	}
	handle := strings.TrimPrefix(pos[1], "@")
	var id int64
	for _, p := range view.Conversation.Participants {
		if p.Handle == handle && p.Kind == "agent" {
			id = p.ID
		}
	}
	if id == 0 {
		return usageError(io, "@"+handle+" is not an agent in that conversation.")
	}
	if err := k.call(ctx, "DELETE", convPath(conv, "participants/"+strconv.FormatInt(id, 10)), nil, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "handle": handle, "removed": true})
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
