package cli

import (
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// maxNewTitleRunes is the longest title `convoz new` sends; the list shows it on one line.
const maxNewTitleRunes = 80

// New runs `convoz new [--with @a,@b] "title" ["first message"]`: the agent starts a conversation. The owner and the
// agent are in it. An agent named with --with joins at once when it already shares a conversation with this agent; any
// other one waits for the owner to approve, as with `convoz add` (I-17). It prints the new conversation id.
func New(args []string, io IO) int {
	f := newChatFlags("new", io)
	f.textFrom = 1 // the first message may start with "--"; a title that does goes after "--"
	with := f.fs.String("with", "", "the agents to bring in, @handles separated by commas; the owner is always in")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) < 1 || len(pos) > 2 {
		return usageError(io, "usage: convoz new [--with @a,@b] \"title\" [\"first message\"]")
	}
	title := strings.TrimSpace(pos[0])
	if n := utf8.RuneCountInString(title); n < 1 || n > maxNewTitleRunes || strings.ContainsFunc(title, unicode.IsControl) {
		return usageError(io, fmt.Sprintf("the title has 1 to %d characters on one line", maxNewTitleRunes))
	}
	handles, err := handlesOf(*with)
	if err != nil {
		return usageError(io, err.Error())
	}
	body := ""
	if len(pos) == 2 {
		body = strings.TrimSpace(pos[1])
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var made struct {
		Conversation struct {
			ID           int64         `json:"id"`
			Participants []wire.Person `json:"participants"`
		} `json:"conversation"`
	}
	req := map[string]any{"client_id": "convoz-" + randomHex(8), "title": title, "participants": handles}
	if err := k.callRetry("POST", wire.RouteConversations, req, &made); err != nil {
		return k.fail(err)
	}
	conv := made.Conversation.ID
	pending := notIn(handles, made.Conversation.Participants)
	if body != "" {
		if _, err := k.sendPost(conv, wire.PostRequest{ClientID: "convoz-" + randomHex(8), Body: body}); err != nil {
			fmt.Fprintf(io.Stderr, "convoz: conversation %d was made, but its first message was not sent\n", conv)
			return k.fail(err)
		}
	}
	if k.asJSON {
		k.printJSON(map[string]any{"conversation_id": conv, "pending": pending})
		return ExitOK
	}
	for _, h := range pending {
		fmt.Fprintf(io.Stderr, "convoz: @%s waits for the owner to approve\n", h)
	}
	fmt.Fprintln(io.Stdout, conv)
	return ExitOK
}

// handlesOf reads "@a,@b" into lower-case handles without the @, each once.
func handlesOf(list string) ([]string, error) {
	out := []string{}
	for _, part := range strings.Split(list, ",") {
		h := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(part), "@"))
		switch {
		case h == "" && strings.TrimSpace(list) == "":
		case h == "":
			return nil, fmt.Errorf("--with needs @handles separated by commas, got %q", list)
		case !slices.Contains(out, h):
			out = append(out, h)
		}
	}
	return out, nil
}

// notIn is the handles that are not among the people the server put in the conversation: the ones left pending.
func notIn(handles []string, people []wire.Person) []string {
	in := map[string]bool{}
	for _, p := range people {
		in[p.Handle] = true
	}
	out := []string{}
	for _, h := range handles {
		if !in[h] {
			out = append(out, h)
		}
	}
	return out
}
