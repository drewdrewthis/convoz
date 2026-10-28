package httpapi

import (
	"context"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// Owner (Drew, conv 179, msg 10021): "I feel like I shouldn't have to ask for updates all the time..." The server asks the agent
// itself when it keeps working with a plan that is behind, and once a day about a delivery whose plan went quiet.

// freshRig is a server on a clock the test moves, with the owner, one conversation and the agent "alpha" (901) in it with a session.
type freshRig struct {
	s     *Server
	clock *stepClock
	conv  int64
	agent *call
	n     int
	owner int64
}

func newFreshRig(t *testing.T) *freshRig {
	t.Helper()
	store := dbtest.Store(t)
	clock := &stepClock{at: time.Now()}
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(t, store, clock.Now()), "one", clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	r := &freshRig{s: NewServer(store, clock, nil, nil, Config{}, log.New(io.Discard, "", 0)), clock: clock}
	r.owner = boot.Owner.ID
	owner := strconv.FormatInt(boot.Owner.ID, 10)
	dbtest.Exec(t, store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (901,'agent','alpha','Alpha','alpha','A',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (901,`+owner+`)`,
		`INSERT INTO machines (id, name, key_hash, key_enc, key_dek_id, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at)
		   VALUES (1,'box-2',zeroblob(32),zeroblob(8),1,'cvz_m_x',127,'any',`+owner+`,1,1)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (9001,901,1,randomblob(32),'client-aaaa','a',127,1,1,9999999999999)`)
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		cv, err := conversation.Create(ctx, d, clock.Now(), conversation.New{By: boot.Owner.ID})
		if err != nil {
			return err
		}
		r.conv = cv.ID
		_, err = conversation.Add(ctx, d, clock.Now(), conversation.Join{Conversation: cv.ID, Identity: 901, By: boot.Owner.ID, Status: conversation.StatusActive})
		return err
	})
	r.agent = &call{p: authz.Principal{Authenticated: true, SessionID: 9001, IdentityID: 901, Role: "agent"},
		lease: auth.Lease{SessionID: 9001, IdentityID: 901, MachineID: 1, Machine: "box-2", Label: "a", Scopes: auth.ScopePost}}
	return r
}

func (r *freshRig) tx(t *testing.T, fn func(ctx context.Context, d pdb.DBTX) error) {
	t.Helper()
	if err := dbtest.TxErr(t, r.s.Store, fn); err != nil {
		t.Fatal(err)
	}
}

// posts has the agent post n messages through the real route, 10 seconds apart.
func (r *freshRig) posts(t *testing.T, n int) {
	t.Helper()
	for range n {
		r.n++
		rig := &streamRig{s: r.s, conv: r.conv}
		if code, body := rig.postAs(t, r.agent, `{"client_id":"fresh-post-`+strconv.Itoa(r.n)+`","body":"working on it","needs_you":false}`); code != http.StatusCreated {
			t.Fatalf("post %d: %d %v", r.n, code, body)
		}
		r.clock.add(10 * time.Second)
	}
}

// ownerSays has the owner write in the conversation now: the work there is for him.
func (r *freshRig) ownerSays(t *testing.T) {
	t.Helper()
	dbtest.Exec(t, r.s.Store, `INSERT INTO messages (conversation_id, author_id, kind, body, created_at) VALUES (`+strconv.FormatInt(r.conv, 10)+`,`+strconv.FormatInt(r.owner, 10)+`,'text','please',`+strconv.FormatInt(r.clock.Now().UnixMilli(), 10)+`)`)
}

// setPlan replaces the agent's plan at the clock's now.
func (r *freshRig) setPlan(t *testing.T, in plan.Input) {
	t.Helper()
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, _, err := plan.Replace(ctx, d, r.clock.Now(), 901, r.conv, in)
		return err
	})
}

// asks counts the agent's status_due items in the conversation that are still open, and acks them.
func (r *freshRig) asks(t *testing.T) int {
	t.Helper()
	var n int
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		if err := d.QueryRowContext(ctx, `SELECT count(*) FROM inbox_items WHERE identity_id = 901 AND conversation_id = ? AND reason = 'status_due' AND state = 'ready'`, r.conv).Scan(&n); err != nil {
			return err
		}
		_, err := d.ExecContext(ctx, `UPDATE inbox_items SET state = 'acked', acked_at = ? WHERE identity_id = 901 AND reason = 'status_due' AND state = 'ready'`, r.clock.Now().UnixMilli())
		return err
	})
	return n
}

func (r *freshRig) sweep(t *testing.T) {
	t.Helper()
	if err := r.s.sweepPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// An agent that keeps posting while its plan is 30 minutes old is asked once, even when the plan waits on the owner (it waited on a
// trash in conv 179 while the agent kept working); then it rests an hour. A fresh plan is never asked about.
func TestAnAgentThatKeepsPostingWithAPlanBehindIsAskedOnceAnHour(t *testing.T) {
	r := newFreshRig(t)
	r.setPlan(t, plan.Input{Now: []plan.Item{{Text: "Building invites"}}, Waiting: []string{"Approve the deploy"}})

	r.clock.add(5 * time.Minute)
	r.posts(t, 3)
	if n := r.asks(t); n != 0 {
		t.Fatalf("a plan 10 minutes old: %d asks, want 0", n)
	}
	r.clock.add(26 * time.Minute) // 31 minutes after the update (5, 3 posts of 10 s, 26); the three posts above count
	r.posts(t, 1)
	if n := r.asks(t); n != 1 {
		t.Fatalf("posting with a plan 31 minutes old: %d asks, want 1", n)
	}
	r.posts(t, 3)
	if n := r.asks(t); n != 0 {
		t.Fatalf("within the hour after an ask: %d asks, want 0", n)
	}
	r.clock.add(time.Hour)
	r.posts(t, 3)
	if n := r.asks(t); n != 1 {
		t.Fatalf("an hour later, still posting with the old plan: %d asks, want 1", n)
	}
	r.clock.add(2 * time.Hour)
	r.setPlan(t, plan.Input{Now: []plan.Item{{Text: "Building invites"}}})
	r.posts(t, 5)
	if n := r.asks(t); n != 0 {
		t.Fatalf("posting right after a plan update: %d asks, want 0", n)
	}
}

// An agent with no plan in a conversation is asked once it has worked there half an hour. A few quick answers right after it joins
// are not behind (CI run 40622514604: a third answer must not start a fourth turn of `convoz run`, nor a second ack in the audit).
func TestAnAgentWithNoPlanIsAskedOnceItHasWorkedThereHalfAnHour(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.posts(t, 3)
	if n := r.asks(t); n != 0 {
		t.Fatalf("three quick posts with no plan: %d asks, want 0", n)
	}
	r.clock.add(31 * time.Minute)
	r.posts(t, 1)
	if n := r.asks(t); n != 1 {
		t.Fatalf("posting 31 minutes after the first post, with no plan: %d asks, want 1", n)
	}
	got := statusDueBody(41, plan.Plan{}, plan.ErrNotFound, askedByStep, r.clock.Now().UnixMilli())
	if !strings.Contains(got, "You have no plan in conversation 41.") || !strings.Contains(got, "convoz plan 41 --doing") {
		t.Errorf("the ask with no plan: %q", got)
	}
}

// A feed no person wrote in (PR events, a board) is not work for anyone: its agent is never asked for a plan there, however many
// one-line posts it makes. A plan that exists and is late is asked about all the same, and a person writing there turns the ask on.
func TestAnAgentInAFeedNoOneWroteInIsNotAskedForAPlan(t *testing.T) {
	r := newFreshRig(t)
	r.posts(t, 3)
	r.clock.add(31 * time.Minute)
	r.posts(t, 3)
	if n := r.asks(t); n != 0 {
		t.Fatalf("a feed with no person's message: %d asks, want 0", n)
	}
	r.ownerSays(t)
	r.posts(t, 1)
	if n := r.asks(t); n != 1 {
		t.Fatalf("a person wrote there and the agent keeps posting: %d asks, want 1", n)
	}
}

// With no plan, replies in threads are not work: an agent that only answers in threads (a PR-events feed, a busy chat it answers in)
// is never asked for a first plan, however many replies and however long it goes on. Its top-level posts still count.
func TestAThreadReplyIsNotWorkThatAsksForAPlan(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	rig := &streamRig{s: r.s, conv: r.conv}
	code, root := rig.postAs(t, r.agent, `{"client_id":"fresh-root","body":"PR 1 opened","needs_you":false}`)
	if code != http.StatusCreated {
		t.Fatalf("root: %d %v", code, root)
	}
	rootID := strconv.FormatInt(int64(root["id"].(float64)), 10)
	for i := range 6 {
		if code, body := rig.postAs(t, r.agent, `{"client_id":"fresh-reply-`+strconv.Itoa(i)+`","body":"merged","thread_root_id":`+rootID+`}`); code != http.StatusCreated {
			t.Fatalf("reply %d: %d %v", i, code, body)
		}
		r.clock.add(5 * time.Minute)
	}
	r.posts(t, 1) // a second top-level post, half an hour in
	if n := r.asks(t); n != 0 {
		t.Fatalf("one root, six thread replies and one more top-level post over half an hour: %d asks, want 0", n)
	}
	r.posts(t, 1) // the third top-level post: now the agent is at work, and has had no plan for over half an hour
	if n := r.asks(t); n != 1 {
		t.Fatalf("three top-level posts over half an hour with no plan: %d asks, want 1", n)
	}
}

// With a plan that is late, thread replies count like any post: an agent that works only in threads is asked all the same.
func TestAnAgentWithALatePlanThatOnlyRepliesInThreadsIsStillAsked(t *testing.T) {
	r := newFreshRig(t)
	r.setPlan(t, plan.Input{Now: []plan.Item{{Text: "Building invites"}}})
	r.ownerSays(t)
	var root int64
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT max(id) FROM messages WHERE conversation_id = ?`, r.conv).Scan(&root)
	})
	rig := &streamRig{s: r.s, conv: r.conv}
	reply := func(i int) {
		t.Helper()
		if code, body := rig.postAs(t, r.agent, `{"client_id":"late-reply-`+strconv.Itoa(i)+`","body":"merged","thread_root_id":`+strconv.FormatInt(root, 10)+`}`); code != http.StatusCreated {
			t.Fatalf("reply %d: %d %v", i, code, body)
		}
	}
	for i := range 3 {
		r.clock.add(10 * time.Second) // after the plan's update, as the posts of the rig are
		reply(i)
	}
	if n := r.asks(t); n != 0 {
		t.Fatalf("a plan a few seconds old: %d asks, want 0", n)
	}
	r.clock.add(31 * time.Minute)
	reply(3)
	if n := r.asks(t); n != 1 {
		t.Fatalf("thread replies only, with a plan 31 minutes old: %d asks, want 1", n)
	}
}

// A plan with a delivery that had no update for a day shows At risk; its agent is asked once, then once a day while it stays so.
func TestAPlanWithADeliveryAndNoUpdateForADayIsAskedOnceADay(t *testing.T) {
	r := newFreshRig(t)
	r.setPlan(t, plan.Input{Deliver: []plan.DeliverInput{{Text: "Search filters live", Due: r.clock.Now().Add(5 * 24 * time.Hour).UnixMilli()}}})
	updated := r.clock.Now().UnixMilli()

	r.clock.add(23 * time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 0 {
		t.Fatalf("23 hours with no update: %d asks, want 0", n)
	}
	r.clock.add(2 * time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 1 {
		t.Fatalf("25 hours with no update: %d asks, want 1", n)
	}
	r.clock.add(2 * time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 0 {
		t.Fatalf("2 hours after the ask: %d asks, want 0", n)
	}
	r.clock.add(23 * time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 1 {
		t.Fatalf("a day after the ask: %d asks, want 1", n)
	}

	p := plan.Plan{UpdatedAt: updated, Body: plan.Body{Deliver: []plan.Deliverable{{Text: "Search filters live", Due: updated + 5*24*3600_000}}}}
	if got := statusDueBody(41, p, nil, askedByStep, updated+25*3600_000); !strings.Contains(got, "has had no update for 25 h") {
		t.Errorf("the ask about a quiet plan: %q", got)
	}
}
