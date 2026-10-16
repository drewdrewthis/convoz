package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func agentCall(identity, machine int64) *call {
	return &call{lease: auth.Lease{IdentityID: identity, MachineID: machine, Scopes: auth.ScopePost}}
}

func mayPost(s *Server, c *call, now time.Time) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	if s.agentMayPost(w, c, now) {
		w.WriteHeader(http.StatusNoContent)
	}
	return w
}

func TestADailyCapAnswers429WithRetryAfterAndOtherMachinesKeepPosting(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, Config{}, nil)
	s.postLimit = auth.Limiter{Window: time.Second, Max: 1000} // out of the way: this test is about the day caps
	s.dayIdentityLimit = auth.Limiter{Window: 24 * time.Hour, Max: 3}
	s.dayMachineLimit = auth.Limiter{Window: 24 * time.Hour, Max: 4}
	t0 := time.Unix(1_800_000_000, 0)

	for i := range 3 {
		if w := mayPost(s, agentCall(1, 1), t0.Add(time.Duration(i)*time.Minute)); w.Code != http.StatusNoContent {
			t.Fatalf("post %d within the identity cap: %d", i, w.Code)
		}
	}
	w := mayPost(s, agentCall(1, 1), t0.Add(10*time.Minute))
	var body wire.Error
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	wantSecs := int((24*time.Hour - 10*time.Minute).Seconds()) // the first post leaves the window 24 h after it was made
	if w.Code != http.StatusTooManyRequests || body.Error.Code != "rate_limited" || body.Error.RetryAfter != wantSecs || w.Header().Get("Retry-After") != "85800" {
		t.Errorf("the 4th post of one identity: %d %+v header=%q, want 429 retry_after=%d", w.Code, body.Error, w.Header().Get("Retry-After"), wantSecs)
	}

	// another identity on the same machine has its own cap, but the machine has one cap across its identities
	if w := mayPost(s, agentCall(2, 1), t0.Add(11*time.Minute)); w.Code != http.StatusNoContent {
		t.Errorf("another identity on box 1 may post: %d", w.Code)
	}
	if w := mayPost(s, agentCall(3, 1), t0.Add(12*time.Minute)); w.Code != http.StatusTooManyRequests {
		t.Errorf("the machine cap of 4 is spent: %d", w.Code)
	}
	if w := mayPost(s, agentCall(3, 2), t0.Add(12*time.Minute)); w.Code != http.StatusNoContent {
		t.Errorf("a post from another machine still passes: %d", w.Code)
	}
}

func TestAMachineWithoutThePostScopeMayNotPost(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, Config{}, nil)
	c := agentCall(1, 1)
	c.lease.Scopes = auth.ScopeRead
	if w := mayPost(s, c, time.Unix(1_800_000_000, 0)); w.Code != http.StatusForbidden {
		t.Errorf("scope check: %d", w.Code)
	}
}
