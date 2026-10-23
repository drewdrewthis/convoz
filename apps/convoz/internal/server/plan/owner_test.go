package plan_test

import (
	"slices"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
)

// Conv 151: an item labelled with someone else's name is not the owner's to do, so it is refused with a way out. A name label is one
// or two capitalised words of letters only.
func TestWaitingItemNamingSomeoneElseIsRefused(t *testing.T) {
	for label, item := range map[string]string{"Rogerio": "Rogerio: x", "Rogerio Silva": "Rogerio Silva: x", "Review": "Review: PR 70", "Zoë": "Zoë: x"} {
		_, why := plan.OwnWaiting([]string{"Approve PR 1", item}, "drew", "Drew")
		want := `waiting is only for what the owner must do. "` + label + `: …" names someone else: put it in --blocked "Waiting on ` + label + `: …", or drop the "` + label + `:" label.`
		if why != want {
			t.Errorf("%q: got %q, want %q", item, why, want)
		}
	}
}

// An instruction that happens to hold a colon is no name: a digit, a lower-case word or a link keeps the item as it is.
func TestAnInstructionWithAColonIsKept(t *testing.T) {
	in := []string{"Step 2: paste the key", "Log in: vercel.com", "Approve deploy: https://x", "see https://x", "https://x.y/z", "Day 10 owner: fix", "Approve PR 1"}
	got, why := plan.OwnWaiting(in, "drew", "Drew")
	if why != "" || !slices.Equal(got, in) {
		t.Errorf("got %q (%q)", got, why)
	}
}

func TestOwnersOwnLabelIsDroppedAndTheItemKept(t *testing.T) {
	got, why := plan.OwnWaiting([]string{"Drew: x", "drew: y", "@drew: z", "@Drew Wendt: w"}, "drew", "Drew Wendt")
	if why != "" || !slices.Equal(got, []string{"x", "y", "z", "w"}) {
		t.Errorf("got %q (%q)", got, why)
	}
}
