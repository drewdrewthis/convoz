package httpapi

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func clientErrorRig() (*Server, *bytes.Buffer) {
	var out bytes.Buffer
	return NewServer(nil, platform.SystemClock{}, nil, nil, Config{}, log.New(&out, "", 0)), &out
}

func postClientError(s *Server, device int64, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	c := &call{p: authz.Principal{Authenticated: true, DeviceID: device, Role: "owner"}}
	s.clientError(rec, httptest.NewRequest(http.MethodPost, "/api/client-errors", strings.NewReader(body)), c)
	return rec
}

func reportJSON(t *testing.T, r wire.ClientErrorRequest) string {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestClientErrorWritesOneEscapedLogLine(t *testing.T) {
	s, out := clientErrorRig()
	rec := postClientError(s, 1, reportJSON(t, wire.ClientErrorRequest{
		Message: "boom\nclient_error build=forged", Stack: "Error: boom\n    at f (/assets/main.js:1:2)", Page: "/chats?token=SECRET#frag", Build: "abc123", UA: "TestBrowser/1", At: 1,
	}))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	line := out.String()
	if strings.Count(line, "\n") != 1 || !strings.HasPrefix(line, "client_error build=\"abc123\" page=\"/chats\" ua=\"TestBrowser/1\" message=\"boom\\nclient_error") {
		t.Errorf("want one escaped line with a path-only page, got %q", line)
	}
	if strings.Contains(line, "SECRET") {
		t.Errorf("the query reached the log: %q", line)
	}
}

func TestClientErrorCutsMessageAndStack(t *testing.T) {
	s, out := clientErrorRig()
	postClientError(s, 1, reportJSON(t, wire.ClientErrorRequest{Message: strings.Repeat("m", 900), Stack: strings.Repeat("s", 9000), Page: "/", Build: "b", UA: "u"}))
	line := out.String()
	if strings.Count(line, "m") > clientErrorMessage+len("client_error build message=")+2 || strings.Count(line, "s") > clientErrorStack+len("stack")+len("message")+2 {
		t.Errorf("message or stack not cut: %d bytes logged", len(line))
	}
}

func TestClientErrorRefusesABodyOver16KB(t *testing.T) {
	s, out := clientErrorRig()
	rec := postClientError(s, 1, reportJSON(t, wire.ClientErrorRequest{Message: strings.Repeat("x", 17<<10)}))
	if rec.Code != http.StatusBadRequest || out.Len() != 0 {
		t.Errorf("status %d, log %q; want 400 and no line", rec.Code, out.String())
	}
}

func TestClientErrorIsLimitedPerDeviceSession(t *testing.T) {
	s, out := clientErrorRig()
	body := reportJSON(t, wire.ClientErrorRequest{Message: "m", Page: "/"})
	for i := 0; i < clientErrorsPerHour; i++ {
		if rec := postClientError(s, 1, body); rec.Code != http.StatusNoContent {
			t.Fatalf("report %d: %d", i+1, rec.Code)
		}
	}
	if rec := postClientError(s, 1, body); rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Errorf("the next report got %d, want 429 with Retry-After", rec.Code)
	}
	if rec := postClientError(s, 2, body); rec.Code != http.StatusNoContent {
		t.Errorf("another device session got %d, want 204", rec.Code)
	}
	if n := strings.Count(out.String(), "client_error"); n != clientErrorsPerHour+1 {
		t.Errorf("%d lines logged, want %d", n, clientErrorsPerHour+1)
	}
}

func TestClientErrorRouteIsTheOwnersAndNotTheAgentPorts(t *testing.T) {
	for _, rt := range Routes {
		if rt.Pattern != "/api/client-errors" {
			continue
		}
		if _, served := rt.AgentReason(); served || rt.Auth != authz.Owner || rt.Lease || rt.Method != http.MethodPost {
			t.Errorf("route %+v: want POST, owner only, no lease, not on the agent listener", rt)
		}
		return
	}
	t.Error("no route for /api/client-errors")
}
