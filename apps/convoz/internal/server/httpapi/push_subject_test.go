package httpapi

import "testing"

func TestPushSubjectIsABareAddressWithoutPort(t *testing.T) {
	for host, want := range map[string]string{
		"host.ts.net:8473": "push@host.ts.net",
		"host.ts.net":      "push@host.ts.net",
		"[::1]:8473":       "push@[::1]",
		"[::1]":            "push@[::1]",
		"::1":              "push@[::1]",
	} {
		s := &Server{Cfg: Config{Host: host}}
		if got := s.pushSubject(); got != want {
			t.Errorf("Host %q: subject %q, want %q", host, got, want)
		}
	}
}
