package httpapi

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const testAgentHost = "dot.testonly.ts.net"

func agentTestServer(t *testing.T) http.Handler {
	t.Helper()
	cfg := Config{Host: "convoz.testonly.ts.net", Version: "test", AgentHost: testAgentHost, AgentPort: 45123, AgentOrigin: "https://" + testAgentHost}
	return NewServer(dbtest.Store(t), platform.NewClock(), nil, nil, cfg, log.New(io.Discard, "", 0)).AgentHandler()
}

// sample turns a pattern such as /api/files/:public_id into a path a request can carry.
func sample(pattern string) string {
	parts := strings.Split(pattern, "/")
	for i, p := range parts {
		if strings.HasPrefix(p, ":") {
			parts[i] = "x1"
		}
	}
	return strings.Join(parts, "/")
}

// notAServedRoute is the catch-all's answer: the same bytes as an unknown path.
func notAServedRoute(rec *httptest.ResponseRecorder) bool {
	return rec.Code == http.StatusNotFound && strings.Contains(rec.Body.String(), "No such route.")
}

// The agent listener must serve a route only when the table says so with a reason; a new route is refused until someone
// gives it one. This walks the whole table through the real handler.
func TestEveryRouteIsServedOnTheAgentListenerWithAReasonOrRefused(t *testing.T) {
	h := agentTestServer(t)
	served := map[string]string{}
	for n, rt := range Routes {
		reason, ok := rt.AgentReason()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(rt.Method, sample(rt.Pattern), nil)
		req.Host, req.RemoteAddr = testAgentHost, "192.0.2."+strconv.Itoa(n%250+1)+":4000" // a fresh address each: the failed-auth limit is per address
		req.Header.Set("Cookie", DeviceCookie+"=TESTONLY-owner-cookie")                    // an owner cookie buys nothing here
		h.ServeHTTP(rec, req)
		id := rt.Method + " " + rt.Pattern
		switch {
		case ok && reason == "":
			t.Errorf("%s: served with no reason", id)
		case ok && notAServedRoute(rec):
			t.Errorf("%s: the table serves it (%s) but the listener answered 404", id, reason)
		case !ok && !notAServedRoute(rec):
			t.Errorf("%s: refused by the table but the listener answered %d", id, rec.Code)
		}
		if ok {
			served[id] = reason
			if (rt.Auth == authz.Owner && !rt.Lease) || rt.RefuseLease || (rt.Agent != "" && rt.Auth != authz.Pub) {
				t.Errorf("%s: an owner or browser route must never be served on the agent listener", id)
			}
		}
	}
	// The no-credential routes are pinned by name: widening this list is a decision, made here, with a reviewer.
	pub := []string{"GET /healthz", "GET /api/version", "GET /install", "GET /cli/:file", "POST /api/device/code", "POST /api/device/token"}
	for id, reason := range served {
		if reason != "session lease" && reason != "machine key" && !contains(pub, id) {
			t.Errorf("%s (%s): a route with no credential is not in the pinned list", id, reason)
		}
	}
	for _, id := range pub {
		if served[id] == "" {
			t.Errorf("%s: pinned but not served", id)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestAgentListenerRefusesAForeignHost(t *testing.T) {
	h := agentTestServer(t)
	for host, want := range map[string]int{
		testAgentHost:                http.StatusOK,
		testAgentHost + ":443":       http.StatusOK,
		testAgentHost + ":45123":     http.StatusOK,
		"convoz.testonly.ts.net":     http.StatusMisdirectedRequest,
		testAgentHost + ".evil.test": http.StatusMisdirectedRequest,
		"":                           http.StatusMisdirectedRequest,
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/healthz", nil)
		req.Host = host
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %q: got %d want %d", host, rec.Code, want)
		}
	}
}

func TestClientIPTrustsForwardingOnlyFromTheLocalProxy(t *testing.T) {
	cases := []struct{ peer, xff, want string }{
		{"127.0.0.1:5555", "203.0.113.9", "203.0.113.9"},
		{"127.0.0.1:5555", "198.51.100.1, 203.0.113.9", "203.0.113.9"}, // the last entry is the one the proxy wrote
		{"127.0.0.1:5555", "not-an-ip", "127.0.0.1"},
		{"127.0.0.1:5555", "", "127.0.0.1"},
		{"[::1]:5555", "2001:db8::1", "2001:db8::1"},
		{"192.0.2.7:5555", "203.0.113.9", "192.0.2.7"}, // not the proxy: the header is a stranger's
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.peer
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientIP(r); got != c.want {
			t.Errorf("peer %s XFF %q: got %s want %s", c.peer, c.xff, got, c.want)
		}
	}
}

func TestAgentListenerLimitsLoginStartsPerAddress(t *testing.T) {
	h := agentTestServer(t)
	start := func(ip string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/device/code", strings.NewReader(`{}`)) // an invalid name: counted, never stored
		req.Host, req.RemoteAddr = testAgentHost, "127.0.0.1:4000"
		req.Header.Set("X-Forwarded-For", ip)
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for i := 0; i < agentStartsPerHour; i++ {
		if got := start("203.0.113.9"); got != http.StatusBadRequest {
			t.Fatalf("start %d: got %d want 400", i+1, got)
		}
	}
	if got := start("203.0.113.9"); got != http.StatusTooManyRequests {
		t.Fatalf("start %d: got %d want 429", agentStartsPerHour+1, got)
	}
	if got := start("203.0.113.10"); got != http.StatusBadRequest {
		t.Fatalf("another address: got %d want 400", got)
	}
}
