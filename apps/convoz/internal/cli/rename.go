package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Rename runs `convoz rename <conv> <title|->`: an agent in the conversation gives it a new title (1 to 120 characters; "-"
// reads it from standard input). The conversation says so in a system line. A title the owner chose is theirs: the command
// then exits 4. After 3 renames an hour it exits 5.
func Rename(args []string, io IO) int {
	f := newChatFlags("rename", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 {
		return usageError(io, "usage: convoz rename <conv> <title|->")
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	title := pos[1]
	if title == "-" {
		raw, err := readAll(io)
		if err != nil {
			return fail(io, err)
		}
		title = strings.TrimRight(raw, "\r\n")
	}
	if strings.TrimSpace(title) == "" {
		return usageError(io, "the title is empty")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out struct {
		Conversation struct {
			Title string `json:"title"` // the title as the server kept it: it strips what a title may not hold
		} `json:"conversation"`
	}
	path := fmt.Sprintf("%s/%d", wire.RouteConversations, conv)
	if err := k.call(ctx, "PATCH", path, map[string]string{"title": title}, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "title": out.Conversation.Title})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Conversation.Title)
	}
	return ExitOK
}
