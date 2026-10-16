package main

import (
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/httpapi"
)

func TestParseHostAndOrigin(t *testing.T) {
	cases := []struct{ in, name, origin string }{
		{"convoz.testonly.ts.net", "convoz.testonly.ts.net", "https://convoz.testonly.ts.net"},
		{"convoz.testonly.ts.net:443", "convoz.testonly.ts.net", "https://convoz.testonly.ts.net"},
		{"Convoz.testonly.ts.net:8473", "convoz.testonly.ts.net", "https://convoz.testonly.ts.net:8473"},
	}
	for _, c := range cases {
		name, port, err := parseHost(c.in)
		if err != nil || name != c.name {
			t.Fatalf("%s: %q %v", c.in, name, err)
		}
		if got := originFor(name, port, httpapi.Config{Unix: true}); got != c.origin {
			t.Errorf("%s: origin %q want %q", c.in, got, c.origin)
		}
	}
	if got := originFor("localhost", 0, httpapi.Config{Unix: true}); got != "http://localhost" {
		t.Errorf("localhost: %q", got)
	}
}

func TestParseHostRefusesBadPorts(t *testing.T) {
	for _, in := range []string{"a.testonly:0", "a.testonly:65536", "a.testonly:x", "a.testonly:"} {
		if _, _, err := parseHost(in); err == nil {
			t.Errorf("%s: want error", in)
		}
	}
}

func TestRelyingPartyIDHasNoPort(t *testing.T) {
	name, port, _ := parseHost("convoz.testonly.ts.net:8473")
	wa, err := auth.NewRelyingParty(name, originFor(name, port, httpapi.Config{Unix: true}))
	if err != nil {
		t.Fatal(err)
	}
	if wa.Config.RPID != "convoz.testonly.ts.net" || wa.Config.RPOrigins[0] != "https://convoz.testonly.ts.net:8473" {
		t.Errorf("rp %q %v", wa.Config.RPID, wa.Config.RPOrigins)
	}
}
