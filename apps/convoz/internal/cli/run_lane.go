package cli

import (
	"context"
	stdio "io"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// laneEvery is how often the owner lane looks for an owner item while the main item runs. A variable so a test can shorten it.
var laneEvery = 5 * time.Second

// ownerLane starts an item written by the owner at once, in a second call, while the main loop is busy with a long item.
// At most one extra call runs at a time; items of agents are left to the main loop.
type ownerLane struct {
	claim  func(context.Context) ([]wire.InboxItem, error) // claims ready items, never the one the main loop holds
	serve  func(context.Context, wire.InboxItem)
	busy   atomic.Bool // the main loop is serving an item
	active atomic.Bool // the extra call is taken
}

func newOwnerLane(claim func(context.Context) ([]wire.InboxItem, error), serve func(context.Context, wire.InboxItem)) *ownerLane {
	return &ownerLane{claim: claim, serve: serve}
}

// setBusy is safe on a nil lane (the lane is off).
func (l *ownerLane) setBusy(b bool) {
	if l != nil {
		l.busy.Store(b)
	}
}

func (l *ownerLane) run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.tick(ctx)
		}
	}
}

// tick claims when the main loop is busy and the extra call is free, and serves the owner items one after the other in the extra
// call. Claimed items of agents stay held for the main loop, which gets its held items first on its next poll.
func (l *ownerLane) tick(ctx context.Context) {
	if !l.busy.Load() || !l.active.CompareAndSwap(false, true) {
		return
	}
	items, err := l.claim(ctx)
	var owner []wire.InboxItem
	for _, it := range items {
		if it.Message.Author.Kind == "human" {
			owner = append(owner, it)
		}
	}
	if err != nil || len(owner) == 0 {
		l.active.Store(false)
		return
	}
	go func() {
		defer l.active.Store(false)
		for _, it := range owner {
			l.serve(ctx, it)
		}
	}()
}

// claimExtra claims ready items only: the item the main loop holds is left out.
func (r *runner) claimExtra(ctx context.Context) ([]wire.InboxItem, error) {
	q := url.Values{"wait": {"0"}, "claim": {"20"}, "held": {"0"}}
	var out wire.InboxResponse
	err := r.k.call(ctx, "GET", wire.RouteInbox+"?"+q.Encode(), nil, &out)
	return out.Items, err
}

// forkCall is the claude run of the extra call: it forks the main session, so the main session id and its transcript stay as they
// are. Before the main session has a transcript there is nothing to fork: the extra call is its own new session.
func (r *runner) forkCall(it wire.InboxItem) claudeCall {
	sid := r.st.session()
	call := claudeCall{Budget: r.budget, Session: sid, Resume: sid != "" && transcriptExists(r.io.Getenv, sid)}
	rules := ""
	if call.Resume {
		call.Fork = true
	} else {
		call.Session, rules = newSessionID(), r.rules()
	}
	call.Prompt = claudePrompt(rules, "", r.handle, itemLine(it)+"\n"+contextLines(it))
	return call
}

// serveLane runs one owner item in the extra call, with its own timeout; the budget per item is the main one.
func (r *runner) serveLane(ctx context.Context, it wire.InboxItem) {
	key := itemKey(it)
	cctx, cancel := context.WithTimeout(ctx, r.laneTimeout)
	defer cancel()
	go r.heartbeat(cctx)
	var c *exec.Cmd
	if len(r.cmd) > 0 {
		var err error
		if c, err = r.commandFor(it); err != nil {
			return
		}
	} else {
		c = exec.Command("claude", r.forkCall(it).args()...)
	}
	c.Dir = r.workdir
	c.Env = append(os.Environ(),
		"CONVOZ_SID="+r.k.sid, "CONVOZ_AS="+r.handle, "CONVOZ_CONV="+strconv.FormatInt(it.Conversation.ID, 10),
		"CONVOZ_MESSAGE="+strconv.FormatInt(it.Message.ID, 10), "CONVOZ_ITEM="+strconv.FormatInt(it.ID, 10), "CONVOZ_THREAD="+optID(it.Message.ThreadRootID))
	var tail lastLine
	c.Stdout, c.Stderr = r.io.Stdout, stdio.MultiWriter(r.io.Stderr, &tail)
	err := runGroup(cctx, c)
	switch {
	case ctx.Err() != nil:
		return
	case err == nil:
		r.finish(ctx, it, key)
		return
	}
	// A failed extra item stays held: the main loop gets it next and retries it like any item. After the second failure it is told.
	if r.st.failed(key) >= runTries {
		last := tail.String()
		if last == "" {
			last = err.Error()
		}
		if !r.answered(ctx, it) {
			r.tell(ctx, it, last)
		}
		r.finish(ctx, it, key)
	}
	r.save()
}
