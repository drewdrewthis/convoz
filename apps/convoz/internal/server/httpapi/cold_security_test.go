package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// The agent listener serves no page: an owner's cookie gives no rights there, so every page URL answers like an unknown path (404);
// a bearer that is no agent's credential is refused first (401).
func TestTheAgentListenerServesNoPage(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	r.s.Cfg.AgentHost = "agent.example"
	h := r.s.AgentHandler()
	paths := []string{"/", "/chats", "/chats?x=1"}
	for _, rt := range Routes {
		if rt.Page {
			paths = append(paths, strings.NewReplacer(":id", "1", ":name", "x").Replace(rt.Pattern))
		}
	}
	for _, p := range paths {
		for _, c := range []struct {
			header, value string
			want          int
		}{
			{"Cookie", DeviceCookie + "=" + r.cookie, http.StatusNotFound},
			{"Authorization", "Bearer cvz_x_abc", http.StatusUnauthorized},
		} {
			req := httptest.NewRequest("GET", p, nil)
			req.Host = "agent.example"
			req.RemoteAddr = "203.0.113.5:5555"
			req.Header.Set(c.header, c.value)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want || strings.Contains(rec.Body.String(), "<html") {
				t.Fatalf("agent listener GET %s with %s: %d %.80q, want %d and no page", p, c.header, rec.Code, rec.Body.String(), c.want)
			}
		}
	}
}

// A HEAD for a page carries no body, so it must not run the first screen's reads (they may write: Now wakes snoozes).
func TestAHeadForAFirstScreenRunsNoReads(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	reads := 0
	for path, rt := range r.s.readRoutes {
		rt.handle = func(*Server, http.ResponseWriter, *http.Request, *call) { reads++ }
		r.s.readRoutes[path] = rt
	}
	head := r.do("HEAD", "/", nil, "")
	if head.Code != http.StatusOK || reads != 0 || head.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("HEAD /: code %d, %d reads run, want 200 and none", head.Code, reads)
	}
	if strings.Contains(head.Body.String(), `id="cz-data"`) {
		t.Fatal("HEAD /: the cold page's data block was built")
	}
	if r.do("GET", "/", nil, ""); reads == 0 {
		t.Fatal("GET /: the first screen's reads did not run, so the HEAD check proves nothing")
	}
}
