package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Owner: a wait with no plan update for more than 24 h leaves his feed and reminds its agent.

// ownerWaits counts the waits in GET /api/now and in GET /api/waiting.
func (r *freshRig) ownerWaits(t *testing.T) (now, waiting int) {
	t.Helper()
	c := &call{p: authz.Principal{Authenticated: true, HumanID: r.owner, Role: "owner"}}
	rec := httptest.NewRecorder()
	r.s.nowScreen(rec, httptest.NewRequest("GET", "/api/now", nil), c)
	var v struct {
		WaitingPlans []json.RawMessage `json:"waiting_plans"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("/api/now: %v %s", err, rec.Body)
	}
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		out, err := r.s.waitingOn(ctx, d, c)
		waiting = len(out.Plans)
		return err
	})
	return len(v.WaitingPlans), waiting
}

func (r *freshRig) wait(t *testing.T) {
	t.Helper()
	r.setPlan(t, plan.Input{Waiting: []string{"your call on the logo"}})
}

func TestAWaitOlderThanADayLeavesTheOwnersFeed(t *testing.T) {
	r := newFreshRig(t)
	r.wait(t)
	r.clock.add(24*time.Hour - time.Minute)
	if a, b := r.ownerWaits(t); a != 1 || b != 1 {
		t.Fatalf("23h59m old: /api/now %d, /api/waiting %d, want 1 and 1", a, b)
	}
	r.clock.add(2 * time.Minute)
	if a, b := r.ownerWaits(t); a != 0 || b != 0 {
		t.Fatalf("24h01m old: /api/now %d, /api/waiting %d, want 0 and 0", a, b)
	}
}

func TestAQuietWaitRemindsItsAgentOnceADay(t *testing.T) {
	r := newFreshRig(t)
	r.wait(t)
	r.clock.add(24*time.Hour + time.Minute)
	r.sweep(t)
	var body string
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		pl, err := plan.Get(ctx, d, 901, r.conv)
		body = statusDueBody(r.conv, pl, err, askedByStep, r.clock.Now().UnixMilli())
		return err
	})
	if !strings.Contains(body, "your call on the logo") || !strings.Contains(body, "--waiting") || !strings.Contains(body, "--done") {
		t.Fatalf("reminder body: %q", body)
	}
	if n := r.asks(t); n != 1 {
		t.Fatalf("one sweep: %d status_due items, want 1", n)
	}
	r.clock.add(time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 0 {
		t.Fatalf("a sweep 1 h later: %d items, want 0", n)
	}
}

func TestSendingThePlanAgainBringsTheWaitBack(t *testing.T) {
	r := newFreshRig(t)
	r.wait(t)
	r.clock.add(25 * time.Hour)
	if a, _ := r.ownerWaits(t); a != 0 {
		t.Fatalf("stale wait still in /api/now: %d", a)
	}
	r.wait(t)
	if a, b := r.ownerWaits(t); a != 1 || b != 1 {
		t.Fatalf("after the plan was sent again: /api/now %d, /api/waiting %d, want 1 and 1", a, b)
	}
}

func TestAnAgentOutOfTheConversationGetsNoWaitReminder(t *testing.T) {
	r := newFreshRig(t)
	r.wait(t)
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := d.ExecContext(ctx, `DELETE FROM participants WHERE conversation_id = ? AND identity_id = 901`, r.conv)
		return err
	})
	r.clock.add(25 * time.Hour)
	r.sweep(t)
	if n := r.asks(t); n != 0 {
		t.Fatalf("a non-member: %d reminders, want 0", n)
	}
}
