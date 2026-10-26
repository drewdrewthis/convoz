package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	stdio "io"
	"math"
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
	dir     string // the config directory and the local session id the lease came from
	sid     string
}

// chatFlags are the global flags of the chat commands (design §13.2). --server is not one: the server is the one
// this machine logged in to.
type chatFlags struct {
	fs      *flag.FlagSet
	sid     *string
	as      *string
	asJSON  *bool
	timeout *time.Duration
	// textFrom is how many positionals come before the text of a post, reply or new (0: the command has no free text). From there
	// an argument that starts with "-" but names no flag of the command is text, not a flag; "--" always ends the flags.
	textFrom int
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
		if f.textFrom > 0 && len(pos) >= f.textFrom && f.startsText(args) {
			if len(args) > 0 && args[0] == "--" {
				args = args[1:]
			}
			return append(pos, args...), true
		}
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

// startsText says whether args begin the free text: "--", or a word like "--once is for tools" that is no flag of this command.
func (f *chatFlags) startsText(args []string) bool {
	if len(args) == 0 || !strings.HasPrefix(args[0], "-") || len(args[0]) == 1 {
		return false
	}
	if args[0] == "--" {
		return true
	}
	name, _, _ := strings.Cut(strings.TrimLeft(args[0], "-"), "=")
	return name != "h" && name != "help" && f.fs.Lookup(name) == nil
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
		if sid, err = sessionForAgent(io, dir, c, creds, *f.as, io.Getenv("CLAUDE_CODE_SESSION_ID")); err != nil {
			return nil, sessionEnded(io, err)
		}
	}
	s, err := loadSession(dir, sid)
	if err != nil {
		return nil, sessionEnded(io, err)
	}
	return &chatCmd{io: io, c: c, lease: s.Lease, asJSON: *f.asJSON, timeout: *f.timeout, dir: dir, sid: sid}, 0
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

// Post runs `convoz post [--fyi] [--format F] [--app FILE] [--file PATH]... [--client-id C] <conv> [text|-]`. It prints the message id (with
// --json also the files it carries). The text may be left out when files are given. A lost answer
// is retried with the same client id (see callRetry), so the server stores the message once. When Convoz says to slow down
// (429 with Retry-After) it waits that long and sends again.
func Post(args []string, io IO) int {
	f := newChatFlags("post", io)
	f.textFrom = 1
	opt := newPostFlags(f, "post")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if !opt.argsOK(pos) {
		return usageError(io, postUsage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	return opt.send(f, io, conv, 0, opt.textOf(pos))
}

// postFlags are the flags `post` and `reply` share.
type postFlags struct {
	format, clientID *string
	app              appOpts
	files            *fileList
	broadcast        bool // reply only: also show the reply in the main thread
	needs            needsYouFlags
	verb             string // post or reply, for the hint
}

func newPostFlags(f *chatFlags, verb string) postFlags {
	return postFlags{
		needs:    newNeedsYouFlags(f),
		verb:     verb,
		format:   f.fs.String("format", "", "markdown, markdownv2 or plain"),
		app:      newAppOpts(f, "a file holding an app (app.v1 JSON) to send with the text"),
		files:    filesFlag(f),
		clientID: f.fs.String("client-id", "", "the id that makes a retry safe; random when not given"),
	}
}

const postUsage = "usage: convoz post [--fyi] [--format F] [--app FILE] [--file PATH]... [--client-id C] <conv> [text|-]"

func filesFlag(f *chatFlags) *fileList {
	l := &fileList{}
	f.fs.Var(l, "file", "a file to attach, of any type, up to 10 times; the text may then be left out")
	return l
}

// argsOK says whether pos is the id and the text; with files the text may be left out.
func (o postFlags) argsOK(pos []string) bool {
	return len(pos) == 2 || (len(pos) == 1 && len(*o.files) > 0)
}

func (o postFlags) textOf(pos []string) string {
	if len(pos) == 2 {
		return pos[1]
	}
	return ""
}

// send posts text (or standard input for "-") to conversation conv, as a reply to thread when thread is not 0.
func (o postFlags) send(f *chatFlags, io IO, conv, thread int64, text string) int {
	if code, ok := o.needs.check(io, o.verb); !ok {
		return code
	}
	if text == "-" {
		raw, err := readAll(io)
		if err != nil {
			return fail(io, err)
		}
		text = strings.TrimRight(raw, "\r\n")
	}
	if strings.TrimSpace(text) == "" && len(*o.files) == 0 {
		return usageError(io, "the message is empty")
	}
	files, err := readAttachments(*o.files)
	if err != nil {
		return usageError(io, err.Error())
	}
	var app json.RawMessage
	var bundle string
	if o.app.set() {
		raw, b, code := o.app.check(io)
		if code != ExitOK {
			return code
		}
		app, bundle = raw, b
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if conv == 0 { // a reply names only the message: the conversation is the one of its thread
		var found wire.RepliesResponse
		if err := k.callRetry("GET", fmt.Sprintf("/api/messages/%d/replies?limit=1", thread), nil, &found); err != nil {
			return k.fail(err)
		}
		conv, thread = found.ConversationID, found.Root.ID // a message inside a thread replies to the thread's root
	}
	if o.app.set() {
		var code int
		if app, code = o.app.send(k, conv, app, bundle); code != ExitOK {
			return code
		}
	}
	clientID := *o.clientID
	var pending *pendingPost
	var sent []sentFile
	if len(files) > 0 {
		// The record keeps the client id and the uploads across runs, so a re-run after a failure resumes and posts once.
		if pending, err = k.openPending(conv, thread, *o.format, text, clientID, files); err != nil {
			return k.fail(err)
		}
		clientID = pending.ClientID
		if sent, err = k.attach(conv, files, pending); err != nil {
			return k.fail(err)
		}
	}
	if clientID == "" {
		clientID = "convoz-" + randomHex(8)
	}
	req := wire.PostRequest{ClientID: clientID, Body: text, Format: *o.format, ThreadRoot: thread, Broadcast: o.broadcast, App: app, NeedsYou: news()}
	for _, u := range sent {
		req.UploadIDs = append(req.UploadIDs, u.ID)
	}
	out, err := k.sendPost(conv, req)
	if err != nil {
		return k.fail(err)
	}
	if pending != nil {
		pending.done()
	}
	if k.asJSON {
		res := map[string]any{"id": out.ID, "conversation_id": out.ConversationID}
		if len(sent) > 0 {
			res["uploads"] = sent
		}
		k.printJSON(res)
	} else {
		fmt.Fprintln(k.io.Stdout, out.ID)
	}
	return ExitOK
}

// sendPost sends one message and returns its ids. The retry rule (callRetry) keeps one client id for all tries, so the server
// stores the message once, and a 429 with Retry-After is waited out.
func (k *chatCmd) sendPost(conv int64, req wire.PostRequest) (out wire.PostResponse, err error) {
	err = k.callRetry("POST", convPath(conv, "messages"), req, &out)
	return out, err
}

func convPath(conv int64, tail string) string {
	return fmt.Sprintf("%s/%d/%s", wire.RouteConversations, conv, tail)
}

func readAll(io IO) (string, error) {
	raw, err := stdio.ReadAll(io.Stdin)
	return string(raw), err
}

// ---- read ---------------------------------------------------------------------------------------------

// Read runs `convoz read [--since ID] [--limit N] [--thread ID] <conv>`: the messages oldest first. It moves the
// session's read cursor to the newest message it showed. --thread reads one thread: its root, or a stub when the
// agent joined after the root, and the replies it may see.
func Read(args []string, io IO) int {
	f := newChatFlags("read", io)
	since := f.fs.Int64("since", 0, "only messages after this id")
	limit := f.fs.Int("limit", 0, "at most this many messages (default 50, most 100)")
	thread := f.fs.Int64("thread", 0, "read the thread of this root message")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz read [--since ID] [--limit N] [--thread ID] <conv>")
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
	if *thread > 0 {
		q.Set("thread", strconv.FormatInt(*thread, 10))
	}
	path := convPath(conv, "messages")
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var page wire.MessagesResponse
	if err := k.call(ctx, "GET", path, nil, &page); err != nil {
		return k.fail(fmt.Errorf("conversation %v: %w", pos[0], err)) // names it: a refusal alone leaves the reader guessing which one
	}
	if len(page.Messages) > 0 && *thread == 0 {
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
		when := time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339)
		switch {
		case m.Deleted:
			fmt.Fprintf(k.io.Stdout, "#%d [deleted] %s\n", m.ID, when)
		case m.Kind == "system":
			fmt.Fprintf(k.io.Stdout, "#%d [system] %s\n  %s\n", m.ID, when, plain(m.Text))
		default:
			fmt.Fprintf(k.io.Stdout, "#%d %s%s %s\n", m.ID, authorOf(m), viaAppMark(m), when)
			for _, line := range strings.Split(wordsOf(m), "\n") {
				fmt.Fprintf(k.io.Stdout, "  %s\n", plain(line))
			}
			printApp(k.io, m)
			printUploads(k.io, m)
			if m.Ask != nil {
				printAsk(k.io, *m.Ask)
			}
		}
	}
	return ExitOK
}

// ---- inbox, ack -----------------------------------------------------------------------------------------

// Inbox runs `convoz inbox [--wait S] [--peek] [--claim N] [--visibility D] [--conv C]`: the held items, then newly
// claimed ones; with --wait it polls until an item arrives or S seconds pass, and rides out a lost connection while
// time is left. --peek changes nothing. --conv C looks at the items of one conversation only.
func Inbox(args []string, io IO) int {
	f := newChatFlags("inbox", io)
	wait := f.fs.Int("wait", 0, "wait up to this many seconds for an item")
	peek := f.fs.Bool("peek", false, "list the items without claiming any")
	claim := f.fs.Int("claim", 0, "claim at most this many items (default and most 20)")
	visibility := f.fs.String("visibility", "", "how long a claim holds before another session may take the item, 30s to 30m (default: the workspace setting, 5m)")
	conv := f.fs.Int64("conv", 0, "claim only the items of this conversation")
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz inbox [--wait S] [--peek] [--claim N] [--visibility D] [--conv C]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	deadline := time.Now().Add(time.Duration(max(*wait, 0)) * time.Second)
	var items []wire.InboxItem
	for {
		hold := max(min(int(math.Ceil(time.Until(deadline).Seconds())), wire.MaxHoldSeconds), 0)
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
		if *conv > 0 {
			q.Set("conv", strconv.FormatInt(*conv, 10))
		}
		var out wire.InboxResponse
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(hold)*time.Second+k.timeout)
		err := k.c.withTimeout(time.Duration(hold)*time.Second+requestTimeout).call(ctx, "GET", wire.RouteInbox+"?"+q.Encode(), k.lease, nil, &out)
		cancel()
		if errors.Is(err, errUnreachable) && time.Now().Before(deadline) {
			time.Sleep(inboxRetryPause) // a lost connection costs a try, not the wait; the held claim comes back with the same token
			continue
		}
		if err != nil {
			return k.fail(err)
		}
		items = out.Items
		if len(items) > 0 || !time.Now().Before(deadline) || *peek {
			break
		}
	}
	return k.printItems(items)
}

// inboxRetryPause is how long `convoz inbox` waits before asking again after a lost connection.
const inboxRetryPause = 300 * time.Millisecond

// printItems writes claimed or peeked items: JSON, or one line each.
func (k *chatCmd) printItems(items []wire.InboxItem) int {
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
	first, _, _ := strings.Cut(wordsOf(it.Message), "\n")
	line := fmt.Sprintf("%s conv %d %q %s x%d #%d @%s: %s", ref, it.Conversation.ID, title, it.Reason, it.Count, it.Message.ID, it.Message.Author.Handle, plain(first))
	if ask := it.Message.Ask; ask != nil && ask.Reply != nil { // the answer of a draft ask is what the agent acts on
		reply, _ := json.Marshal(ask.Reply)
		line += " reply: " + plain(string(reply))
	}
	if ask := it.Message.Ask; ask != nil && ask.Note() != "" {
		line += " — " + ask.Note()
	}
	return line
}

// wordsOf is what a message says: its body, or for a message with files the plain form the server made of it ("Voice note 0:20:
// ship the filters", "[Image: chart.png]"), which holds the body and names the files.
func wordsOf(m wire.Message) string {
	if len(m.Uploads) > 0 && m.Text != "" {
		return m.Text
	}
	return m.Body
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

// ackForms is what `convoz ack` accepts; a wrong form prints it.
const ackForms = "convoz ack <id>:<token>... | convoz ack <id> <token> | convoz ack - (a watch line, or id:token, on stdin)"

// Ack runs `convoz ack <id:token>...`: one line per item, "ok" or "claim_lost". Any lost claim is exit 4.
// It also takes `<id> <token>` as two words, and `-` for the watch lines (JSON or text) on stdin.
func Ack(args []string, io IO) int {
	f := newChatFlags("ack", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	items, err := ackRefs(pos, io.Stdin)
	if err != nil {
		return usageError(io, err.Error())
	}
	req := wire.AckRequest{Items: items}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out wire.AckResponse
	err = k.call(ctx, "POST", wire.RouteInboxAck, req, &out)
	lost := false
	if status, code := statusCode(err); status == 409 && code == wire.AckClaimLost {
		err, lost = nil, true // the body still says which items were acked
	}
	if err != nil {
		return k.fail(err)
	}
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
		fmt.Fprintln(k.io.Stderr, "convoz: claim_lost: a claim ran out or belongs to another session")
		return ExitConflict
	}
	return ExitOK
}

// printAsk writes what an ask message holds besides its question: the options with their reasons, where the ask stands and
// its history, so an agent reads who dismissed or answered it (C-6).
func printAsk(io IO, a wire.AskView) {
	if a.Draft != nil {
		printDraft(io, a)
		return
	}
	for i, o := range a.Options {
		mark := "-"
		if i == 0 {
			mark = "*"
			o.Label += " (recommended)"
		}
		fmt.Fprintf(io.Stdout, "  %s %s — %s\n", mark, plain(o.Label), plain(o.Why))
	}
	state := a.State
	switch {
	case a.State == "answered" && a.Chosen != nil && a.Chosen.Kind == "custom":
		state = "Replied · " + a.Answer
	case a.State == "answered":
		state = "Answered · " + a.Answer
	case a.State == "closed":
		state = "Closed (" + strings.ReplaceAll(a.CloseReason, "_", " ") + ")"
	}
	fmt.Fprintf(io.Stdout, "  [ask %s]\n", plain(state))
	if note := a.Note(); note != "" {
		fmt.Fprintf(io.Stdout, "  %s\n", note)
	}
	for _, h := range a.History {
		fmt.Fprintf(io.Stdout, "    %s %s\n", plain(historyLine(h, a)), time.UnixMilli(h.At).UTC().Format(time.RFC3339))
	}
}

// printDraft is printAsk of a draft ask: the original, the draft, and once answered the reply an agent acts on: send true with the
// final text, or send false.
func printDraft(io IO, a wire.AskView) {
	if a.Draft.Original != "" {
		fmt.Fprintf(io.Stdout, "  [original%s] %s\n", plainFrom(a.Draft.OriginalFrom), plain(a.Draft.Original))
	}
	fmt.Fprintf(io.Stdout, "  [draft] %s\n", plain(a.Draft.Text))
	switch {
	case a.Reply != nil && a.Reply.Send:
		fmt.Fprintf(io.Stdout, "  [ask Send: %s]\n", plain(a.Reply.Text))
	case a.Reply != nil:
		fmt.Fprintln(io.Stdout, "  [ask Don't send]")
	default:
		fmt.Fprintf(io.Stdout, "  [ask %s]\n", plain(a.State))
	}
	if a.Reply != nil {
		reply, _ := json.Marshal(a.Reply)
		fmt.Fprintf(io.Stdout, "  reply: %s\n", reply)
	}
	if note := a.Note(); note != "" {
		fmt.Fprintf(io.Stdout, "  %s\n", note)
	}
	for _, h := range a.History {
		fmt.Fprintf(io.Stdout, "    %s %s\n", plain(historyLine(h, a)), time.UnixMilli(h.At).UTC().Format(time.RFC3339))
	}
}

func plainFrom(from string) string {
	if from == "" {
		return ""
	}
	return " from " + plain(from)
}

// historyLine is one history row in words: "Dismissed by Drew", "Reopened by Drew", "Answered by Drew · Merge it".
func historyLine(h wire.AskHistoryRow, a wire.AskView) string {
	who := "the system"
	if h.By != nil {
		who = h.By.DisplayName
		if who == "" {
			who = "@" + h.By.Handle
		} else if h.By.Kind == "agent" {
			who += " @" + h.By.Handle // an agent is always shown with its handle (I-3)
		}
	}
	switch h.Event {
	case "create":
		return "Asked by " + who
	case "answer":
		return "Answered by " + who + " · " + a.Answer
	case "dismiss":
		return "Dismissed by " + who
	case "undismiss":
		return "Reopened by " + who
	case "withdraw":
		return "Withdrawn by " + who
	case "owner_replied":
		return "Replied in the thread by " + who
	case "replace":
		return "Replaced by an updated ask"
	case "updated":
		return "Updated by " + who
	}
	return "Closed (" + strings.ReplaceAll(a.CloseReason, "_", " ") + ")"
}

// viaAppMark says a message was sent through an app: " (via app by @devtool, from #9123)" (I-46).
func viaAppMark(m wire.Message) string {
	if m.ViaApp == nil {
		return ""
	}
	return fmt.Sprintf(" (via app by @%s, from #%d)", m.ViaApp.Agent.Handle, m.ViaApp.MessageID)
}

// printApp shows the app a message carries as one line and its fallback, and the result a message sent through an app holds.
func printApp(io IO, m wire.Message) {
	if m.ViaApp != nil {
		fmt.Fprintf(io.Stdout, "  result: %s\n", plain(string(m.ViaApp.Result)))
	}
	if len(m.App) == 0 {
		return
	}
	var a struct {
		Type, Title, Fallback string
		V                     int
	}
	if json.Unmarshal(m.App, &a) != nil {
		return
	}
	fmt.Fprintf(io.Stdout, "  [app %s %q v%d]\n", a.Type, a.Title, a.V)
	for _, line := range strings.Split(a.Fallback, "\n") {
		fmt.Fprintf(io.Stdout, "    %s\n", plain(line))
	}
}

// printUploads names each file a message carries, with the id that `convoz file` takes.
func printUploads(io IO, m wire.Message) {
	for _, u := range m.Uploads {
		fmt.Fprintf(io.Stdout, "  [file: %s (%s)]\n", plain(u.Name), u.ID)
	}
}

func badAck(what string) error {
	return fmt.Errorf("%q is not an item to ack; use: %s", what, ackForms)
}

func ackRef(id, token string) (wire.AckRef, bool) {
	n, err := strconv.ParseInt(id, 10, 64)
	return wire.AckRef{ID: n, ClaimToken: token}, err == nil && n > 0 && token != ""
}

// ackRefs reads the items to ack from the positional words: "id:token", "id token", or "-" for lines on stdin.
func ackRefs(pos []string, stdin stdio.Reader) ([]wire.AckRef, error) {
	if len(pos) == 0 {
		return nil, fmt.Errorf("usage: %s", ackForms)
	}
	var refs []wire.AckRef
	for i := 0; i < len(pos); i++ {
		a := pos[i]
		if a == "-" {
			more, err := ackRefsFromLines(stdin)
			if err != nil {
				return nil, err
			}
			refs = append(refs, more...)
			continue
		}
		id, token, _ := strings.Cut(a, ":")
		if !strings.Contains(a, ":") && i+1 < len(pos) {
			i++
			token, a = pos[i], a+" "+pos[i]
		}
		ref, ok := ackRef(id, token)
		if !ok {
			return nil, badAck(a)
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

// ackRefsFromLines reads watch lines: JSON ones by item_id and claim_token, text ones by their first word (id:token).
func ackRefsFromLines(r stdio.Reader) ([]wire.AckRef, error) {
	var refs []wire.AckRef
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ref wire.AckRef
		var ok bool
		if strings.HasPrefix(line, "{") {
			var w struct {
				ItemID     int64  `json:"item_id"`
				ClaimToken string `json:"claim_token"`
			}
			if json.Unmarshal([]byte(line), &w) == nil {
				ref, ok = ackRef(strconv.FormatInt(w.ItemID, 10), w.ClaimToken)
			}
		} else {
			id, token, _ := strings.Cut(strings.Fields(line)[0], ":")
			ref, ok = ackRef(id, token)
		}
		if !ok {
			return nil, badAck(line)
		}
		refs = append(refs, ref)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, fmt.Errorf("nothing to ack on stdin; use: %s", ackForms)
	}
	return refs, nil
}
