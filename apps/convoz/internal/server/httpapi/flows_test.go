package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func TestClipKeepsPrintableASCIIOnly(t *testing.T) {
	got := clip("a‮b\x00c\tdé" + strings.Repeat("x", 40))
	if want := "abcd" + strings.Repeat("x", hostInfoLimit-4); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestMarkupInHostInfoStaysUnderTheColumnLimit(t *testing.T) {
	nasty := strings.Repeat(`<>&"\`, 40)
	info, err := json.Marshal(wire.HostInfo{Hostname: clip(nasty), OS: clip(nasty), Arch: clip(nasty), CLIVersion: clip(nasty)})
	if err != nil {
		t.Fatal(err)
	}
	if len(info) >= 200 || strings.ContainsAny(string(info), `<>&\`) {
		t.Fatalf("%d bytes: %s", len(info), info)
	}
}
