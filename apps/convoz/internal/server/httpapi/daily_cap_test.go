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

// checkPost is the check a handler makes before it stores a post.
func checkPost(s *Server, c *call, now time.Time) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	if s.withinBudgets(w, c, now) {
		w.WriteHeader(http.StatusNoContent)
	}
	return w
}

// mayPost is checkPost for a post that then gets stored, which spends the day.
func mayPost(s *Server, c *call, now time.Time) *httptest.ResponseRecorder {
	w := checkPost(s, c, now)
	if w.Code == http.StatusNoContent {
		s.countDailyPost(c, now)
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

// The scope a route names is checked by route() before the handler runs (I-6); this is the check and its words.
func TestALeaseWithoutTheScopeARouteNamesIsRefused(t *testing.T) {
	c := agentCall(1, 1)
	c.lease.Scopes = auth.ScopeRead
	if leaseHas(c.lease, "post") || !leaseHas(c.lease, "read") || !leaseHas(c.lease, "") {
		t.Errorf("a read-only lease: post=%v read=%v none=%v, want false true true", leaseHas(c.lease, "post"), leaseHas(c.lease, "read"), leaseHas(c.lease, ""))
	}
	for _, r := range Routes {
		if r.Scope != "" && scopeRefusals[r.Scope] == "" {
			t.Errorf("%s %s needs the %q scope but no refusal is worded for it", r.Method, r.Pattern, r.Scope)
		}
	}
}

func TestADailyCapCountsOnlyStoredPosts(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, Config{}, nil)
	s.postLimit = auth.Limiter{Window: time.Second, Max: 1000}
	s.dayIdentityLimit = auth.Limiter{Window: 24 * time.Hour, Max: 2}
	s.dayMachineLimit = auth.Limiter{Window: 24 * time.Hour, Max: 2}
	t0 := time.Unix(1_800_000_000, 0)
	c := agentCall(1, 1)

	for i := range 5 { // checked but never stored (400, 403, a replay): the day is not spent
		if w := checkPost(s, c, t0.Add(time.Duration(i)*time.Second)); w.Code != http.StatusNoContent {
			t.Fatalf("check %d: %d", i, w.Code)
		}
	}
	s.countDailyPost(c, t0)
	s.countDailyPost(c, t0)
	if w := checkPost(s, c, t0.Add(time.Minute)); w.Code != http.StatusTooManyRequests {
		t.Errorf("two stored posts spend a cap of 2: %d", w.Code)
	}
}
