package cli

import (
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// An ask the agent updated after the owner's questions reads "Updated by", not "Closed ()" (ask 1783).
func TestHistoryLineNamesAnUpdate(t *testing.T) {
	by := &wire.Person{Handle: "claude-convoz", DisplayName: "Claude", Kind: "agent"}
	if got := historyLine(wire.AskHistoryRow{Event: "updated", ToState: "open", By: by}, wire.AskView{}); got != "Updated by Claude @claude-convoz" {
		t.Fatalf("historyLine = %q", got)
	}
}
