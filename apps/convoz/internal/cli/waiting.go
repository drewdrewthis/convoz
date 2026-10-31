package cli

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Waiting runs `convoz waiting [--json]`: across every conversation the owner let this agent read, the open asks, the owner's messages
// nobody answered for 10 minutes, the plan items that wait on the owner and the owner's unread counts, so the agent can triage what
// needs the owner. The server refuses an agent without the triage right.
func Waiting(args []string, io IO) int {
	f := newChatFlags("waiting", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 0 {
		return usageError(io, "usage: convoz waiting [--json]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out wire.WaitingResponse
	if err := k.call(ctx, "GET", wire.RouteWaiting, nil, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
		return ExitOK
	}
	w := k.io.Stdout
	for _, a := range out.Asks {
		fmt.Fprintf(w, "ask #%d in %s: @%s asks (%s) %s\n", a.ID, convName(a.Conversation), a.Asker.Handle, age(a.AgeMS), plain(a.Question))
	}
	for _, u := range out.Unanswered {
		fmt.Fprintf(w, "unanswered in %s: owner wrote #%d (%s) %s %s/chats/%d#m%d\n", convName(u.Conversation, u.Members...), u.MessageID, age(u.AgeMS), plain(u.Excerpt), k.c.base, u.Conversation.ID, u.MessageID)
	}
	for _, p := range out.Plans {
		fmt.Fprintf(w, "plan in %s: @%s waits (%s) %s\n", convName(p.Conversation), p.Agent.Handle, age(out.Now-p.Since), plain(p.Text))
	}
	for _, u := range out.Unread {
		fmt.Fprintf(w, "unread in %s: %d\n", convName(u.Conversation), u.Unread)
	}
	return ExitOK
}

// convName is the title of a conversation, or the handles of its members when it has none.
func convName(c wire.AskConversation, members ...string) string {
	title := ""
	if c.Title != nil {
		title = plain(*c.Title)
	}
	if title == "" && len(members) > 0 {
		title = "@" + strings.Join(members, " @")
	}
	if title == "" {
		title = "conversation"
	}
	return title + " (" + strconv.FormatInt(c.ID, 10) + ")"
}

func age(ms int64) string {
	return time.Duration(ms * int64(time.Millisecond)).Round(time.Minute).String()
}
