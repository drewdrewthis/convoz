package main

import (
	"errors"
	"testing"
)

func TestParseAgent(t *testing.T) {
	ok, err := parseAgent("127.0.0.1:8081", "Dot.testonly.ts.net:8443")
	if err != nil || !ok.on || ok.listen != "127.0.0.1:8081" || ok.name != "dot.testonly.ts.net" || ok.publicPort != 8443 {
		t.Fatalf("got %+v %v", ok, err)
	}
	if off, err := parseAgent("", ""); err != nil || off.on {
		t.Fatalf("off: %+v %v", off, err)
	}
	for _, c := range [][2]string{{"127.0.0.1:8081", ""}, {"", "dot.testonly.ts.net"}, {"unix:///tmp/a.sock", "dot.testonly.ts.net"}, {"127.0.0.1:8081", "bad host"}} {
		if _, err := parseAgent(c[0], c[1]); err == nil {
			t.Errorf("%v: want an error", c)
		}
	}
	if _, err := parseAgent("0.0.0.0:8081", "dot.testonly.ts.net"); !errors.Is(err, errNotLoopback) {
		t.Errorf("a public bind is the wall's error, got %v", err)
	}
}
