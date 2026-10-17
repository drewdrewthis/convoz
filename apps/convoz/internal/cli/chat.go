package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	stdio "io"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// defaultTimeout bounds a command that has no long wait of its own, retries included.
const defaultTimeout = 30 * time.Second

// chatCmd is what the chat commands share: the server, the lease of the session they run in, and the output mode.
type chatCmd struct {
	io      IO
	c       *client
	lease   string
	asJSON  bool
	timeout time.Duration
}

// chatFlags are the global flags of the chat commands (design §13.2). --server is not one: the server is the one
// this machine logged in to.
type chatFlags struct {
	fs      *flag.FlagSet
	sid     *string
	as      *string
	asJSON  *bool
	timeout *time.Duration
}

func newChatFlags(name string, io IO) *chatFlags {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Stderr)
	return &chatFlags{
		fs:      fs,
		sid:     fs.String("sid", io.Getenv("CONVOZ_SID"), "the local session id"),
		as:      fs.String("as", io.Getenv("CONVOZ_AS"), "the agent handle; uses or starts the session of the client id"),
		asJSON:  fs.Bool("json", false, "print JSON"),
		timeout: fs.Duration("timeout", defaultTimeout, "give up after this long"),
	}
}

// parse reads the flags and returns the positional arguments. Flags may come before, between and after them;
// "--" ends the flags. A bad flag is a usage error with the convoz: prefix.
func (f *chatFlags) parse(args []string, io IO) ([]string, bool) {
	var pos []string
	for {
		if !parseFlags(f.fs, args, io) {
			return nil, false
		}
		rest := f.fs.Args()
		if len(rest) == 0 {
			return pos, true
		}
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" {
			return append(pos, rest...), true
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

// open finds the lease the command runs under. It returns an exit code when it cannot.
func (f *chatFlags) open(io IO) (*chatCmd, int) {
	dir, err := configDir(io.Getenv)
	if err != nil {
		return nil, fail(io, err)
	}
	creds, err := loadCredentials(dir, osKeychain{io.Getenv})
	if err != nil {
		return nil, fail(io, err)
	}
	c := newClient(creds.Server)
	sid := *f.sid
	if sid == "" {
		if *f.as == "" {
			return nil, usageError(io, "name a session with --sid (or CONVOZ_SID), or an agent with --as")
		}
		if sid, err = sessionForAgent(dir, c, creds, *f.as, io.Getenv("CLAUDE_CODE_SESSION_ID")); err != nil {
			return nil, sessionEnded(io, err)
		}
	}
	s, err := loadSession(dir, sid)
	if err != nil {
		return nil, sessionEnded(io, err)
	}
	return &chatCmd{io: io, c: c, lease: s.Lease, asJSON: *f.asJSON, timeout: *f.timeout}, 0
}

// call sends one authenticated request within the command's timeout. Only a lost connection is retried by the callers that may.
func (k *chatCmd) call(ctx context.Context, method, path string, in, out any) error {
	return k.c.call(ctx, method, path, k.lease, in, out)
}

// fail prints err; a lease the server ended gets its own message and exit 3.
func (k *chatCmd) fail(err error) int { return sessionEnded(k.io, err) }

func (k *chatCmd) printJSON(v any) {
	raw, _ := json.Marshal(v)
	fmt.Fprintln(k.io.Stdout, string(raw))
}

// convArg reads the conversation id positional.
func convArg(io IO, s string) (int64, bool) {
	id, err := strconv.ParseInt(s, 10, 64)
	if err != nil || id <= 0 {
		usageError(io, fmt.Sprintf("%q is not a conversation id", s))
		return 0, false
	}
	return id, true
}

// ---- post ---------------------------------------------------------------------------------------------

// Post runs `convoz post [--format F] [--client-id C] <conv> <text|->`. It prints the message id. A lost answer is
// retried with the same client id, up to 3 tries within --timeout, so the server stores the message once.
func Post(args []string, io IO) int {
	f := newChatFlags("post", io)
	format := f.fs.String("format", "", "markdown, markdownv2 or plain")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 {
		return usageError(io, "usage: convoz post [--format F] [--client-id C] <conv> <text|->")
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
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
	var out wire.PostResponse
	req := wire.PostRequest{ClientID: *clientID, Body: text, Format: *format}
	var err error
	for try := 1; try <= 3; try++ {
		if err = k.call(ctx, "POST", convPath(conv, "messages"), req, &out); !errors.Is(err, errUnreachable) || ctx.Err() != nil {
			break
		}
		time.Sleep(time.Duration(try) * 300 * time.Millisecond)
	}
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

func convPath(conv int64, tail string) string {
	return fmt.Sprintf("%s/%d/%s", wire.RouteConversations, conv, tail)
}

func readAll(io IO) (string, error) {
	raw, err := stdio.ReadAll(io.Stdin)
	return string(raw), err
}

// ---- read ---------------------------------------------------------------------------------------------

// Read runs `convoz read [--since ID] [--limit N] <conv>`: the messages oldest first. It moves the session's read
// cursor to the newest message it showed.
func Read(args []string, io IO) int {
	f := newChatFlags("read", io)
	since := f.fs.Int64("since", 0, "only messages after this id")
	limit := f.fs.Int("limit", 0, "at most this many messages (default 50, most 100)")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz read [--since ID] [--limit N] <conv>")
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
	q := url.Values{}
	if *since > 0 {
		q.Set("after", strconv.FormatInt(*since, 10))
	}
	if *limit > 0 {
		q.Set("limit", strconv.Itoa(*limit))
	}
	path := convPath(conv, "messages")
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var page wire.MessagesResponse
	if err := k.call(ctx, "GET", path, nil, &page); err != nil {
		return k.fail(err)
	}
	if len(page.Messages) > 0 {
		newest := page.Messages[len(page.Messages)-1].ID
		if err := k.call(ctx, "POST", convPath(conv, "read"), wire.ReadRequest{MainID: newest}, nil); err != nil {
			return k.fail(err)
		}
	}
	if k.asJSON {
		k.printJSON(map[string]any{"messages": append([]wire.Message{}, page.Messages...)})
		return ExitOK
	}
	for _, m := range page.Messages {
		fmt.Fprintf(k.io.Stdout, "#%d @%s %s\n", m.ID, m.Author.Handle, time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339))
		for _, line := range strings.Split(m.Body, "\n") {
			fmt.Fprintf(k.io.Stdout, "  %s\n", plain(line))
		}
	}
	return ExitOK
}

// ---- inbox, ack -----------------------------------------------------------------------------------------

// Inbox runs `convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]`: the held items, then newly claimed
// ones; with --wait it polls until an item arrives or S seconds pass. --peek changes nothing.
func Inbox(args []string, io IO) int {
	f := newChatFlags("inbox", io)
	wait := f.fs.Int("wait", 0, "wait up to this many seconds for an item")
	peek := f.fs.Bool("peek", false, "list the items without claiming any")
	claim := f.fs.Int("claim", 0, "claim at most this many items (default and most 20)")
	visibility := f.fs.String("visibility", "", "how long a claim holds before another session may take the item, 30s to 30m (default 5m)")
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	remaining := max(*wait, 0)
	var items []wire.InboxItem
	for {
		hold := min(remaining, wire.MaxHoldSeconds)
		q := url.Values{"wait": {strconv.Itoa(hold)}}
		if *peek {
			q.Set("peek", "1")
		}
		if *claim > 0 {
			q.Set("claim", strconv.Itoa(*claim))
		}
		if *visibility != "" {
			q.Set("visibility", *visibility)
		}
		var out wire.InboxResponse
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(hold)*time.Second+k.timeout)
		err := k.c.withTimeout(time.Duration(hold)*time.Second+requestTimeout).call(ctx, "GET", wire.RouteInbox+"?"+q.Encode(), k.lease, nil, &out)
		cancel()
		if err != nil {
			return k.fail(err)
		}
		items = out.Items
		remaining -= hold
		if len(items) > 0 || remaining <= 0 || *peek {
			break
		}
	}
	if k.asJSON {
		k.printJSON(map[string]any{"items": append([]wire.InboxItem{}, items...)})
		return ExitOK
	}
	for _, it := range items {
		fmt.Fprintln(k.io.Stdout, itemLine(it))
	}
	return ExitOK
}

// itemLine is one inbox item on one line: <id>:<token> conv <c> "<title>" <reason> x<count> #<msg> @<author>: <first line>.
// An item with no token (a peek of a ready item) shows the bare id.
func itemLine(it wire.InboxItem) string {
	ref := strconv.FormatInt(it.ID, 10)
	if it.ClaimToken != "" {
		ref += ":" + it.ClaimToken
	}
	title := ""
	if it.Conversation.Title != nil {
		title = *it.Conversation.Title
	}
	first, _, _ := strings.Cut(it.Message.Body, "\n")
	return fmt.Sprintf("%s conv %d %q %s x%d #%d @%s: %s", ref, it.Conversation.ID, title, it.Reason, it.Count, it.Message.ID, it.Message.Author.Handle, plain(first))
}

// plain drops control characters except newline and tab, and format characters (Unicode Cf: bidi overrides such as
// U+202E, zero-width marks), so a message cannot move the cursor, recolour or retitle the terminal of the person
// reading it, nor flip or hide text. JSON output needs none of this: the encoder escapes them.
func plain(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

// Ack runs `convoz ack <id:token>...`: one line per item, "ok" or "claim_lost". Any lost claim is exit 4.
func Ack(args []string, io IO) int {
	f := newChatFlags("ack", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) == 0 {
		return usageError(io, "usage: convoz ack <id:token>...")
	}
	var req wire.AckRequest
	for _, a := range pos {
		id, token, ok := strings.Cut(a, ":")
		n, err := strconv.ParseInt(id, 10, 64)
		if !ok || err != nil || n <= 0 || token == "" {
			return usageError(io, fmt.Sprintf("%q is not <id>:<token>", a))
		}
		req.Items = append(req.Items, wire.AckRef{ID: n, ClaimToken: token})
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out wire.AckResponse
	if err := k.call(ctx, "POST", wire.RouteInboxAck, req, &out); err != nil {
		return k.fail(err)
	}
	lost := false
	for _, r := range out.Results {
		lost = lost || r.Result != wire.AckOK
	}
	if k.asJSON {
		k.printJSON(map[string]any{"results": out.Results})
	} else {
		for _, r := range out.Results {
			fmt.Fprintf(k.io.Stdout, "%d %s\n", r.ID, r.Result)
		}
	}
	if lost {
		return ExitConflict
	}
	return ExitOK
}
