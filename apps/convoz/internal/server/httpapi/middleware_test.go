package httpapi

import (
	"net/http/httptest"
	"testing"
)

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
