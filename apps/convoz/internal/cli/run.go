package cli

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	stdio "io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Timings of `convoz run`. They are variables only so a test can shorten them.
var (
	runRetryPause = 2 * time.Second  // between the two tries of an item
	runHeartbeat  = 10 * time.Second // how often a running item tells the server that its runner is alive

	runHeldFirst = 5 * time.Second // first wait when another watch holds the agent's slot
	runHeldMax   = 5 * time.Minute // the longest wait between two tries for that slot
)

// runTries is how many times an item's command may fail before the thread is told and the item is finished.
const runTries = 2

// stringList is a repeatable flag.
type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, " ") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

// Run runs `convoz run --as H [--workdir D] [--budget USD] [--fresh-after N] [--item-timeout D] [--owner-lane=false] [--owner-lane-timeout D] [-- cmd args...]`:
// it serves the agent's inbox with one short-lived process per item, so the agent needs no terminal open.
//
// With `-- cmd args` the command runs once per item: the item as JSON on stdin; CONVOZ_SID (the runner's session, so the command's
// own convoz calls and acks are the runner's), CONVOZ_AS, CONVOZ_CONV, CONVOZ_THREAD, CONVOZ_MESSAGE and CONVOZ_ITEM in its
// environment. Without it, each item is one `claude -p` run in --workdir with every tool (see claudeCall.args).
//
// An item is acked only after its command exited 0. A failure keeps the item held, so it comes back to be tried again; before
// the retry the runner checks whether the agent already answered in the item's thread (a command that replied and then failed
// or timed out must not answer twice). After the second failure the thread is told and the item is finished.
// Each command is its own process group, so a timeout kills what the command started too.
//
// The server lets one runner serve an agent: a second `convoz watch` is refused for as long as this session lives. The command
// never stops on a network error, and waits (5 s doubling to 5 min) while a watch holds the agent; it stops
// when its session ends (exit 3), or on SIGINT/SIGTERM (it ends its session first so the lock and its claims are let go at once).
func Run(args []string, io IO) int {
	own, cmd := splitDash(args)
	f := newChatFlags("run", io)
	workdir := f.fs.String("workdir", "", "the directory Claude mode runs in (default: here)")
	// --allow and --write are kept so old service files still start; Claude mode already has every tool.
	var allow stringList
	f.fs.Var(&allow, "allow", "no effect: Claude mode has every tool")
	f.fs.Bool("write", false, "no effect: Claude mode has every tool")
	budget := f.fs.String("budget", "2.00", "Claude mode: the most one item may spend, in dollars (a first turn alone costs about $0.40)")
	freshAfter := f.fs.Int("fresh-after", 20, "Claude mode: start a new session, with a summary of the old one, after this many items")
	itemTimeout := f.fs.Duration("item-timeout", 10*time.Minute, "kill an item's command after this long")
	ownerLane := f.fs.Bool("owner-lane", true, "start an item written by the owner at once, in a second call, while a long item runs")
	laneTimeout := f.fs.Duration("owner-lane-timeout", 10*time.Minute, "kill the owner lane's call after this long")
	if pos, ok := f.parse(own, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 || *f.as == "" {
		return usageError(io, "usage: convoz run --as HANDLE [--workdir D] [--budget USD] [--fresh-after N] [--item-timeout D] [-- cmd args...]")
	}
	handle := strings.ToLower(*f.as)
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	unlock, err := lockRun(dir, handle)
	if err != nil {
		fmt.Fprintf(io.Stderr, "convoz: %s\n", err)
		return ExitFailure
	}
	defer unlock()
	// One client id per handle: a restart finds its own live session (and so its claims) again.
	runIO := io
	runIO.Getenv = func(k string) string {
		if k == "CLAUDE_CODE_SESSION_ID" {
			return "convoz-run-" + handle
		}
		return io.Getenv(k)
	}
	*f.sid = ""
	k, code := f.open(runIO)
	if k == nil {
		return code
	}
	statePath := filepath.Join(dir, runDir, handle+".json")
	r := &runner{k: k, io: runIO, handle: handle, cmd: cmd, workdir: *workdir, timeout: *itemTimeout, laneTimeout: *laneTimeout, budget: *budget, freshAfter: *freshAfter,
		statePath: statePath, st: loadRunState(statePath)}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *ownerLane {
		r.lane = newOwnerLane(r.claimExtra, r.serveLane)
		go r.lane.run(ctx, laneEvery)
	}
	code = r.loop(ctx)
	if ctx.Err() != nil { // asked to stop: end the session so its claims go back and the server lock opens
		_ = endSession(dir, k.c, k.sid)
	}
	return code
}

// splitDash splits the arguments at the first "--": the flags of convoz run, and the command that serves each item.
func splitDash(args []string) (own, cmd []string) {
	for i, a := range args {
		if a == "--" {
			return args[:i], args[i+1:]
		}
	}
	return args, nil
}

type runner struct {
	k          *chatCmd
	io         IO
	handle     string
	cmd        []string // empty: Claude mode
	workdir    string
	timeout    time.Duration
	budget     string
	freshAfter int
	statePath  string
	st         *runState
	lastErr    string // the last stderr line of the last failed command

	laneTimeout time.Duration
	lane        *ownerLane // nil: the owner lane is off
}

// loop polls the inbox for ever and serves one item at a time, in order.
func (r *runner) loop(ctx context.Context) int {
	backoff, heldWait, first := watchBackoffFirst, runHeldFirst, true
	for ctx.Err() == nil {
		hold := wire.MaxHoldSeconds
		if first {
			hold = 0 // answers at once, so a refusal (409) is known before "serving" is said
		}
		items, err := r.poll(ctx, hold, 1+r.lane.count())
		switch {
		case ctx.Err() != nil:
			return ExitOK
		case err == nil:
		case retryable(err):
			fmt.Fprintf(r.io.Stderr, "convoz run: %s; trying again in %s\n", err, backoff)
			sleepCtx(ctx, backoff)
			backoff = min(backoff*2, watchBackoffMax)
			continue
		case isWatchOpen(err):
			// The agent's own `convoz watch` holds the slot. Never take it by force: wait, or a service manager restart-loops us.
			fmt.Fprintf(r.io.Stderr, "convoz run: %s; trying again in %s\n", err, heldWait)
			sleepCtx(ctx, heldWait)
			heldWait = min(heldWait*2, runHeldMax)
			continue
		default:
			return r.k.fail(err)
		}
		backoff, heldWait = watchBackoffFirst, runHeldFirst
		if first {
			first = false
			fmt.Fprintf(r.io.Stdout, "convoz run: serving @%s (pid %d)\n", r.handle, os.Getpid())
		}
		if it, ok := r.next(items); ok {
			r.lane.setBusy(true)
			r.serve(ctx, it) // the rest stay held and come back on the next poll
			r.lane.setBusy(false)
		} else if len(items) > 0 {
			sleepCtx(ctx, laneEvery) // only the lane's items are held: a poll would answer at once
		}
	}
	return ExitOK
}

// next is the first item the owner lane does not have.
func (r *runner) next(items []wire.InboxItem) (wire.InboxItem, bool) {
	for _, it := range items {
		if !r.lane.owns(it.ID) {
			return it, true
		}
	}
	return wire.InboxItem{}, false
}

// isWatchOpen says the server refused a poll because a watch holds the agent's slot.
func isWatchOpen(err error) bool {
	status, _ := statusCode(err)
	return status == 409
}

// heldElsewhere prints the server's refusal of a poll because another runner or watch holds the agent, and says it was one.
func heldElsewhere(io IO, err error) (int, bool) {
	if status, _ := statusCode(err); status != 409 {
		return 0, false
	}
	fmt.Fprintf(io.Stderr, "convoz: %s\n", err)
	return ExitAuth, true
}

// poll claims at most one item (the held one first, so a failed item comes back) and says it is a runner polling.
func (r *runner) poll(ctx context.Context, hold, n int) ([]wire.InboxItem, error) {
	q := url.Values{"wait": {strconv.Itoa(hold)}, "claim": {strconv.Itoa(n)}, "runner": {"1"}}
	var out wire.InboxResponse
	err := r.k.c.withTimeout((wire.MaxHoldSeconds+15)*time.Second).call(ctx, "GET", wire.RouteInbox+"?"+q.Encode(), r.k.lease, nil, &out)
	return out.Items, err
}

func itemKey(it wire.InboxItem) string { return strconv.FormatInt(it.ID, 10) + ":" + it.ClaimToken }

// serve runs one item to its end or to a retry.
func (r *runner) serve(ctx context.Context, it wire.InboxItem) {
	key := itemKey(it)
	if r.st.Tries[key] > 0 && r.answered(ctx, it) { // the command replied before it failed: do not answer twice
		r.finish(ctx, it, key)
		return
	}
	err := r.runItem(ctx, it)
	switch {
	case ctx.Err() != nil:
		return
	case err == nil:
		r.st.update(func(s *runState) { s.Items++ })
		r.finish(ctx, it, key)
		return
	}
	n := r.st.failed(key)
	r.save()
	fmt.Fprintf(r.io.Stderr, "convoz run: item %d failed (%d of %d): %s\n", it.ID, n, runTries, r.lastErr)
	if n < runTries {
		sleepCtx(ctx, runRetryPause)
		return
	}
	if !r.answered(ctx, it) {
		r.tell(ctx, it, r.lastErr)
	}
	r.finish(ctx, it, key)
}

// finish acks the item and forgets its tries. A claim that was lost meanwhile is not an error: the item comes back and is judged again.
func (r *runner) finish(ctx context.Context, it wire.InboxItem, key string) {
	var out wire.AckResponse
	req := wire.AckRequest{Items: []wire.AckRef{{ID: it.ID, ClaimToken: it.ClaimToken}}}
	if err := r.k.callRetry("POST", wire.RouteInboxAck, req, &out); err != nil {
		if status, _ := statusCode(err); status != 409 && ctx.Err() == nil {
			fmt.Fprintf(r.io.Stderr, "convoz run: ack of item %d: %s\n", it.ID, err)
		}
		return
	}
	r.st.forget(key)
	r.save()
}

func (r *runner) save() {
	if err := r.st.save(r.statePath); err != nil {
		fmt.Fprintf(r.io.Stderr, "convoz run: %s\n", err)
	}
}

// rootOf is the thread the item's message is in, or the message itself when it starts one.
func rootOf(it wire.InboxItem) int64 {
	if it.Message.ThreadRootID > 0 {
		return it.Message.ThreadRootID
	}
	return it.Message.ID
}

// answered says whether the agent wrote in the item's thread, or in its conversation, after the item's message.
func (r *runner) answered(ctx context.Context, it wire.InboxItem) bool {
	conv := it.Conversation.ID
	if conv == 0 {
		return false
	}
	for _, q := range []string{"thread=" + strconv.FormatInt(rootOf(it), 10), "after=" + strconv.FormatInt(it.Message.ID, 10)} {
		var page wire.MessagesResponse
		if err := r.k.call(ctx, "GET", convPath(conv, "messages")+"?"+q, nil, &page); err != nil {
			continue
		}
		for _, m := range page.Messages {
			if m.ID > it.Message.ID && !m.Deleted && strings.EqualFold(m.Author.Handle, r.handle) {
				return true
			}
		}
	}
	return false
}

// tell says in the item's thread that the command failed. The client id is the claim's, so a retry stores the notice once.
func (r *runner) tell(ctx context.Context, it wire.InboxItem, last string) {
	if it.Conversation.ID == 0 {
		return
	}
	name := "claude"
	if len(r.cmd) > 0 {
		name = filepath.Base(r.cmd[0])
	}
	if len(last) > 200 {
		last = last[:200]
	}
	body := fmt.Sprintf("I couldn't answer this (convoz run: %s failed twice: %s).", name, last)
	id := fmt.Sprintf("convoz-run-%d-%s", it.ID, it.ClaimToken)
	req := wire.PostRequest{ClientID: id[:min(len(id), 64)], Body: body, ThreadRoot: rootOf(it), NeedsYou: news()}
	if err := r.k.callRetry("POST", convPath(it.Conversation.ID, "messages"), req, nil); err != nil && ctx.Err() == nil {
		fmt.Fprintf(r.io.Stderr, "convoz run: telling the thread: %s\n", err)
	}
}

// runItem runs the command for one item, bounded by the item timeout. While it runs the runner calls the server now and then:
// that keeps the item's claim and the server lock alive for a command that is quiet for a long time.
func (r *runner) runItem(ctx context.Context, it wire.InboxItem) error {
	cctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	go r.heartbeat(cctx)
	var c *exec.Cmd
	if len(r.cmd) > 0 {
		var err error
		if c, err = r.commandFor(it); err != nil {
			return err
		}
	} else {
		call := r.nextClaudeCall(cctx, it)
		c = exec.Command("claude", call.args()...)
	}
	c.Dir = r.workdir
	c.Env = append(os.Environ(),
		"CONVOZ_SID="+r.k.sid, "CONVOZ_AS="+r.handle, "CONVOZ_CONV="+strconv.FormatInt(it.Conversation.ID, 10),
		"CONVOZ_MESSAGE="+strconv.FormatInt(it.Message.ID, 10), "CONVOZ_ITEM="+strconv.FormatInt(it.ID, 10), "CONVOZ_THREAD="+optID(it.Message.ThreadRootID))
	var tail lastLine
	c.Stdout, c.Stderr = r.io.Stdout, stdio.MultiWriter(r.io.Stderr, &tail)
	err := runGroup(cctx, c)
	if err != nil {
		r.lastErr = tail.String()
		if r.lastErr == "" {
			r.lastErr = err.Error()
		}
		return err
	}
	r.st.update(func(s *runState) { s.Summary = "" }) // the new session got it
	return nil
}

// commandFor is the user's command for an item, with the item as JSON on stdin.
func (r *runner) commandFor(it wire.InboxItem) (*exec.Cmd, error) {
	raw, err := json.Marshal(it)
	if err != nil {
		return nil, err
	}
	c := exec.Command(r.cmd[0], r.cmd[1:]...)
	c.Stdin = bytes.NewReader(raw)
	return c, nil
}

func optID(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

// runGroup runs c as its own process group and kills the whole group when ctx ends, so a command that started others leaves none behind.
func runGroup(ctx context.Context, c *exec.Cmd) error {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.WaitDelay = 5 * time.Second
	if err := c.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		case <-done:
		}
	}()
	err := c.Wait()
	if ctx.Err() != nil {
		return fmt.Errorf("stopped after %w", ctx.Err())
	}
	return err
}

// heartbeat asks for the inbox without claiming until ctx ends: any call of the runner's session keeps its claims and its server lock.
func (r *runner) heartbeat(ctx context.Context) {
	t := time.NewTicker(runHeartbeat)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			var out wire.InboxResponse
			_ = r.k.call(ctx, "GET", wire.RouteInbox+"?peek=1", nil, &out)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// lastLine keeps the last non-empty line written to it.
type lastLine struct{ line string }

func (l *lastLine) Write(p []byte) (int, error) {
	for _, s := range strings.Split(string(p), "\n") {
		if s = strings.TrimSpace(s); s != "" {
			l.line = s
		}
	}
	return len(p), nil
}

func (l *lastLine) String() string { return l.line }

// nextClaudeCall is the `claude -p` run for an item: a new session (with the rules, and the summary of the one before it) when the
// session is new, never written, or past --fresh-after items; else a resume of it.
func (r *runner) nextClaudeCall(ctx context.Context, it wire.InboxItem) claudeCall {
	if r.st.SessionID != "" && r.st.Items >= r.freshAfter {
		r.rotate(ctx)
	}
	if r.st.SessionID == "" {
		r.st.update(func(s *runState) { s.SessionID, s.Items = newSessionID(), 0 })
		r.save()
	}
	call := claudeCall{Budget: r.budget, Session: r.st.SessionID, Resume: transcriptExists(r.io.Getenv, r.st.SessionID)}
	rules, summary := "", ""
	if !call.Resume {
		rules, summary = r.rules(), r.st.Summary
	}
	call.Prompt = claudePrompt(rules, summary, r.handle, itemLine(it)+"\n"+contextLines(it))
	return call
}

// rotate ends the session: the old one writes a one-line summary, which is kept as a handoff note and opens the next session.
func (r *runner) rotate(ctx context.Context) {
	var out bytes.Buffer
	c := exec.Command("claude", claudeCall{Budget: r.budget, Session: r.st.SessionID, Resume: true, Prompt: summaryAsk}.args()...)
	c.Dir, c.Stdout, c.Stderr = r.workdir, &out, r.io.Stderr
	summary := ""
	if runGroup(ctx, c) == nil {
		summary = strings.TrimSpace(out.String())
	}
	if len(summary) > wire.MaxHandoffBytes {
		summary = summary[:wire.MaxHandoffBytes]
	}
	if summary != "" {
		note := wire.HandoffRequest{ClientID: "convoz-run-" + randomHex(8), Body: summary}
		if err := r.k.callRetry("POST", wire.RouteHandoffs, note, nil); err != nil {
			fmt.Fprintf(r.io.Stderr, "convoz run: handoff note: %s\n", err)
		}
	}
	r.st.update(func(s *runState) { s.SessionID, s.Items, s.Summary = "", 0, summary })
	r.save()
}

// rules is `convoz rules`: the text the server holds, put once at the head of a new session. "" when it cannot be read.
func (r *runner) rules() string {
	var out bytes.Buffer
	if Rules(nil, IO{Stdin: r.io.Stdin, Stdout: &out, Stderr: r.io.Stderr, Getenv: r.io.Getenv}) != ExitOK {
		return ""
	}
	return strings.TrimSpace(out.String())
}

// newSessionID is a random version 4 UUID, which is what claude --session-id takes.
func newSessionID() string {
	b, _ := hex.DecodeString(randomHex(16))
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
