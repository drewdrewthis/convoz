package cli

import (
	"fmt"
	"net/url"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Brief runs `convoz brief [--max-bytes N] [--page N]`: who this session is, the last handoff note, the asks, the inbox and
// the conversations with unread messages, in one short text (design §3.8). It changes nothing, so it is safe to run again.
// --max-bytes is brought inside 4 KB to 64 KB by the server.
func Brief(args []string, io IO) int {
	f := newChatFlags("brief", io)
	maxBytes := f.fs.Int("max-bytes", 0, "the size of the brief, 4096 to 65536 (default: the workspace setting, 12288)")
	page := f.fs.Int("page", 0, "the page of the list of conversations with unread messages (10 a page)")
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz brief [--max-bytes N] [--page N] [--json]")
	}
	if *maxBytes < 0 || *page < 0 {
		return usageError(io, "--max-bytes and --page are positive numbers")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	q := url.Values{}
	if *maxBytes > 0 {
		q.Set("max_bytes", strconv.Itoa(*maxBytes))
	}
	if *page > 0 {
		q.Set("page", strconv.Itoa(*page))
	}
	path := wire.RouteBrief
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out wire.BriefResponse
	if err := k.callRetry("GET", path, nil, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
		return ExitOK
	}
	fmt.Fprintln(k.io.Stdout, plain(out.Text))
	return ExitOK
}
