package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func init() {
	Register(Command{Name: "reply", Order: 55, Run: Reply,
		Usage: "convoz reply [--broadcast] [--format F] [--client-id C] <message> <text|->"})
}

// Reply runs `convoz reply [--broadcast] [--format F] [--client-id C] <message> <text|->`: a reply in the thread of a top-level
// message. --broadcast also shows it in the main list. It prints the reply's id. The conversation is found from the message,
// and a retry with the same client id stores the reply once, as for `convoz post`.
func Reply(args []string, io IO) int {
	f := newChatFlags("reply", io)
	broadcast := f.fs.Bool("broadcast", false, "also show the reply in the main list")
	format := f.fs.String("format", "", "markdown, markdownv2 or plain")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 {
		return usageError(io, "usage: convoz reply [--broadcast] [--format F] [--client-id C] <message> <text|->")
	}
	root, err := strconv.ParseInt(pos[0], 10, 64)
	if err != nil || root <= 0 {
		return usageError(io, fmt.Sprintf("%q is not a message id", pos[0]))
	}
	text := pos[1]
	if text == "-" {
		raw, err := readAll(io)
		if err != nil {
			return fail(io, err)
		}
		text = strings.TrimRight(raw, "\r\n")
	}
	if strings.TrimSpace(text) == "" {
		return usageError(io, "the message is empty")
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var thread wire.RepliesResponse
	if err := k.call(ctx, "GET", fmt.Sprintf("/api/messages/%d/replies?limit=1", root), nil, &thread); err != nil {
		return k.fail(err)
	}
	out, err := k.sendPost(thread.ConversationID, wire.PostRequest{ClientID: *clientID, Body: text, Format: *format, ThreadRoot: root, Broadcast: *broadcast})
	if err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]int64{"id": out.ID, "conversation_id": out.ConversationID})
	} else {
		fmt.Fprintln(k.io.Stdout, out.ID)
	}
	return ExitOK
}
