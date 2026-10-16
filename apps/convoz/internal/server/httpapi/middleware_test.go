package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestHostCheckOnTheUnixListenerAcceptsAnyPort(t *testing.T) {
	s := &Server{Cfg: Config{Host: "convoz.testonly.ts.net", Unix: true}}
	cases := []struct {
		host, forwarded string
		want            bool
	}{
		{"localhost", "convoz.testonly.ts.net", true},
		{"localhost", "convoz.testonly.ts.net:8443", true},
		{"localhost", "CONVOZ.testonly.ts.net:443", true},
		{"localhost", "evil.example:8443", false},
		{"localhost", "convoz.testonly.ts.net.evil.example", false},
		{"localhost", "", false},
		{"evil.example", "convoz.testonly.ts.net", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = c.host
		if c.forwarded != "" {
			r.Header.Set("X-Forwarded-Host", c.forwarded)
		}
		if got := s.hostOK(r); got != c.want {
			t.Errorf("Host %q X-Forwarded-Host %q: got %v want %v", c.host, c.forwarded, got, c.want)
		}
	}
}
