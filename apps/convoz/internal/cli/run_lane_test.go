package cli

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func laneItem(id int64, kind string) wire.InboxItem {
	return wire.InboxItem{ID: id, Message: wire.Message{ID: id, Author: wire.Person{Kind: kind}}}
}

// laneRig is a lane whose claim hands out the queued items once and whose serve blocks until released.
type laneRig struct {
	mu      sync.Mutex
	queue   []wire.InboxItem
	claims  int
	started chan int64
	release chan struct{}
	lane    *ownerLane
}

func newLaneRig(queue ...wire.InboxItem) *laneRig {
	g := &laneRig{queue: queue, started: make(chan int64, 8), release: make(chan struct{})}
	g.lane = newOwnerLane(func(context.Context) ([]wire.InboxItem, error) {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.claims++
		q := g.queue
		g.queue = nil
		return q, nil
	}, func(_ context.Context, it wire.InboxItem) {
		g.started <- it.ID
		<-g.release
	})
	return g
}

func (g *laneRig) claimCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.claims
}

func (g *laneRig) next(t *testing.T) int64 {
	t.Helper()
	select {
	case id := <-g.started:
		return id
	case <-time.After(2 * time.Second):
		t.Fatal("no item started")
		return 0
	}
}

func TestOwnerItemStartsWhileTheMainItemRuns(t *testing.T) {
	g := newLaneRig(laneItem(1, "human"))
	g.lane.setBusy(true)
	g.lane.tick(context.Background())
	if id := g.next(t); id != 1 {
		t.Errorf("started %d, want the owner item 1", id)
	}
	g.release <- struct{}{}
}

func TestLaneStaysQuietWhileTheMainLoopIsIdle(t *testing.T) {
	g := newLaneRig(laneItem(1, "human"))
	g.lane.tick(context.Background())
	if n := g.claimCount(); n != 0 {
		t.Errorf("claimed %d times with no main item running", n)
	}
}

func TestSecondOwnerItemWaitsForTheExtraSlot(t *testing.T) {
	g := newLaneRig(laneItem(1, "human"), laneItem(2, "human"))
	g.lane.setBusy(true)
	g.lane.tick(context.Background())
	g.next(t)
	g.lane.tick(context.Background()) // the slot is taken: no claim, nothing starts
	select {
	case id := <-g.started:
		t.Fatalf("item %d started beside the first", id)
	case <-time.After(100 * time.Millisecond):
	}
	if n := g.claimCount(); n != 1 {
		t.Errorf("claims while the slot was taken: %d, want 1", n)
	}
	g.release <- struct{}{}
	if id := g.next(t); id != 2 {
		t.Errorf("after the first ended, started %d, want 2", id)
	}
	g.release <- struct{}{}
}

func TestAgentItemsWaitInLine(t *testing.T) {
	g := newLaneRig(laneItem(1, "agent"))
	g.lane.setBusy(true)
	g.lane.tick(context.Background())
	select {
	case id := <-g.started:
		t.Fatalf("agent item %d started in the owner lane", id)
	case <-time.After(100 * time.Millisecond):
	}
	if g.lane.active.Load() {
		t.Error("the slot stays free when no owner item was claimed")
	}
}

func TestForkCallLeavesTheMainSessionIdAlone(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "projects", "p"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "projects", "p", "main-sid.jsonl"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	r := &runner{handle: "a", budget: "1.50", st: &runState{SessionID: "main-sid"},
		io: IO{Getenv: func(k string) string {
			if k == "CLAUDE_CONFIG_DIR" {
				return home
			}
			return ""
		}}}
	args := r.forkCall(laneItem(7, "human")).args()
	want := []string{"-p", "--permission-mode", "bypassPermissions", "--max-budget-usd", "1.50", "--resume", "main-sid", "--fork-session"}
	if !reflect.DeepEqual(args[:len(args)-1], want) {
		t.Errorf("args %q, want the main budget and a forked resume of the main session", args)
	}
	if r.st.SessionID != "main-sid" {
		t.Errorf("main session id became %q", r.st.SessionID)
	}
}

// --owner-lane=false leaves the runner's lane nil: the loop's calls must not fail, and nothing can claim, so owner items queue.
func TestLaneOffIsSafe(t *testing.T) {
	var l *ownerLane
	l.setBusy(true)
	l.setBusy(false)
}
