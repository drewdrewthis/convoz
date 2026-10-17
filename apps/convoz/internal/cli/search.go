package cli

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Search runs `convoz search [--in CONV] [--from @HANDLE] [--limit N] <text...>`: the messages that hold the words, newest
// first, in the conversations this agent is in. The text may carry the filters of the search box (from:@x, is:ask, has:link
// ...); --in and --from add the in: and from: filters.
func Search(args []string, io IO) int {
	f := newChatFlags("search", io)
	in := f.fs.String("in", "", "only this conversation (its id, or a part of its title)")
	from := f.fs.String("from", "", "only messages written by this handle")
	limit := f.fs.Int("limit", 0, "at most this many results (default 20, most 50)")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	words := append([]string(nil), pos...)
	if *in != "" {
		words = append(words, `in:"`+strings.ReplaceAll(*in, `"`, "")+`"`)
	}
	if *from != "" {
		words = append(words, "from:@"+strings.TrimPrefix(*from, "@"))
	}
	text := strings.Join(words, " ")
	if strings.TrimSpace(text) == "" {
		return usageError(io, "usage: convoz search [--in CONV] [--from @HANDLE] [--limit N] <text...>")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	q := url.Values{"q": {text}}
	if *limit > 0 {
		q.Set("limit", strconv.Itoa(*limit))
	}
	var out wire.SearchResponse
	if err := k.call(ctx, "GET", wire.RouteSearch+"?"+q.Encode(), nil, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
		return ExitOK
	}
	for _, r := range out.Results {
		title := plain(r.ConversationTitle)
		if title == "" {
			title = "conversation " + strconv.FormatInt(r.ConversationID, 10)
		}
		fmt.Fprintf(k.io.Stdout, "#%d @%s in %s (%d) %s\n  %s\n", r.MessageID, r.Author.Handle, title, r.ConversationID,
			time.UnixMilli(r.CreatedAt).UTC().Format(time.RFC3339), plain(snippetText(r.Snippet)))
	}
	return ExitOK
}

func snippetText(parts []wire.SearchPart) string {
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String()
}
