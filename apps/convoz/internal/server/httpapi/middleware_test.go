package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCSRFAcceptsOnlyTheAppOriginAndTheOwnerSetExtensionOrigin(t *testing.T) {
	const app = "https://convoz.testonly.ts.net"
	const ext = "chrome-extension://mbdignacpmfihffcpigobpekahlmeleb"
	const other = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		name, option, origin, xconvoz string
		blocked                       bool
		method, path                  string
	}{
		{"option empty, extension origin", "", ext, "1", true, "", ""},
		{"option set, extension origin", ext, ext, "1", false, "", ""},
		{"option set, other extension id", ext, other, "1", true, "", ""},
		{"option set, extension origin without X-Convoz", ext, ext, "", true, "", ""},
		{"option set, the app origin", ext, app, "1", false, "", ""},
		{"allowed: create conversation", ext, ext, "1", false, "POST", "/api/conversations"},
		{"allowed: post message", ext, ext, "1", false, "POST", "/api/conversations/12/messages"},
		{"allowed: start upload", ext, ext, "1", false, "POST", "/api/uploads"},
		{"allowed: upload chunk", ext, ext, "1", false, "PATCH", "/api/uploads/abc"},
		{"denied: delete conversation", ext, ext, "1", true, "DELETE", "/api/conversations/12"},
		{"denied: mark stale", ext, ext, "1", true, "POST", "/api/conversations/12/stale"},
		{"denied: messages path without id", ext, ext, "1", true, "POST", "/api/conversations/messages"},
		{"denied: extra segment after messages", ext, ext, "1", true, "POST", "/api/conversations/12/messages/5"},
		{"denied: empty setting on an allowed route", "", ext, "1", true, "POST", "/api/conversations"},
		{"app origin still writes anywhere", ext, app, "1", false, "DELETE", "/api/conversations/12"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &Server{Cfg: Config{Origin: app, ExtensionOrigin: c.option}}
			h := s.csrf(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
			method, path := c.method, c.path
			if method == "" {
				method, path = "POST", "/api/conversations"
			}
			r := httptest.NewRequest(method, path, strings.NewReader("{}"))
			r.Header.Set("Origin", c.origin)
			r.Header.Set("Content-Type", "application/json")
			if c.xconvoz != "" {
				r.Header.Set("X-Convoz", c.xconvoz)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if c.blocked {
				if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"csrf"`) {
					t.Fatalf("want 403 csrf, got %d %s", w.Code, w.Body.String())
				}
			} else if w.Code != http.StatusNoContent {
				t.Fatalf("want pass, got %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestHostCheckOnTheUnixListenerComparesThePortToTheConfiguredOne(t *testing.T) {
	cases := []struct {
		publicPort      int
		host, forwarded string
		want            bool
	}{
		{0, "localhost", "convoz.testonly.ts.net", true},
		{0, "localhost", "CONVOZ.testonly.ts.net:443", true},
		{0, "localhost", "convoz.testonly.ts.net:8443", false},
		{8473, "localhost", "convoz.testonly.ts.net:8473", true},
		{8473, "localhost", "convoz.testonly.ts.net:8443", false},
		{8473, "localhost", "convoz.testonly.ts.net", false},
		{0, "localhost", "evil.example:443", false},
		{0, "localhost", "convoz.testonly.ts.net.evil.example", false},
		{0, "localhost", "", false},
		{0, "evil.example", "convoz.testonly.ts.net", false},
	}
	for _, c := range cases {
		s := &Server{Cfg: Config{Host: "convoz.testonly.ts.net", Unix: true, PublicPort: c.publicPort}}
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = c.host
		if c.forwarded != "" {
			r.Header.Set("X-Forwarded-Host", c.forwarded)
		}
		if got := s.hostOK(r); got != c.want {
			t.Errorf("port %d Host %q X-Forwarded-Host %q: got %v want %v", c.publicPort, c.host, c.forwarded, got, c.want)
		}
	}
}
