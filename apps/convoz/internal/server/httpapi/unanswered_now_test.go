package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Owner: a message of mine that nobody answered for 10 minutes shows in GET /api/now, as it does in GET /api/waiting.

// unanswered reads the unanswered entries from GET /api/now and from GET /api/waiting.
func (r *freshRig) unanswered(t *testing.T) (now, waiting []wire.WaitingUnanswered) {
	t.Helper()
	c := &call{p: authz.Principal{Authenticated: true, HumanID: r.owner, Role: "owner"}}
	rec := httptest.NewRecorder()
	r.s.nowScreen(rec, httptest.NewRequest("GET", "/api/now", nil), c)
	var v struct {
		Unanswered []wire.WaitingUnanswered `json:"unanswered"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("/api/now: %v %s", err, rec.Body)
	}
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		out, err := r.s.waitingOn(ctx, d, c)
		waiting = out.Unanswered
		return err
	})
	return v.Unanswered, waiting
}

func TestAnOwnerMessageShowsAfterTenMinutes(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(10*time.Minute - time.Second)
	if now, _ := r.unanswered(t); len(now) != 0 {
		t.Fatalf("9m59s old: %d entries in /api/now, want 0", len(now))
	}
	r.clock.add(2 * time.Second)
	now, _ := r.unanswered(t)
	if len(now) != 1 || now[0].Conversation.ID != r.conv || now[0].Excerpt != "please" {
		t.Fatalf("10m01s old: %+v, want the one message", now)
	}
	if !reflect.DeepEqual(now[0].Members, []string{"alpha"}) {
		t.Errorf("members %v, want [alpha]", now[0].Members)
	}
}

func TestAnAnswerRemovesTheOwnerMessageFromTheFeed(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(11 * time.Minute)
	r.posts(t, 1)
	if now, _ := r.unanswered(t); len(now) != 0 {
		t.Fatalf("after the agent replied: %+v, want none", now)
	}
}

func TestTwoOwnerMessagesInOneChatGiveTheNewest(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(time.Minute)
	r.ownerSays(t)
	r.clock.add(11 * time.Minute)
	now, _ := r.unanswered(t)
	if len(now) != 1 {
		t.Fatalf("%d entries, want 1", len(now))
	}
	if want := r.clock.Now().Add(-11 * time.Minute).UnixMilli(); now[0].CreatedAt != want {
		t.Errorf("created_at %d, want the newest, %d", now[0].CreatedAt, want)
	}
}

func TestNowAndWaitingAgreeOnUnanswered(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(11 * time.Minute)
	now, waiting := r.unanswered(t)
	if len(now) != 1 || !reflect.DeepEqual(now, waiting) {
		t.Fatalf("/api/now %+v, /api/waiting %+v", now, waiting)
	}
}
