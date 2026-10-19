package wire

import (
	"strings"
	"testing"
)

func TestOwnersCall_Problem(t *testing.T) {
	for name, tc := range map[string]struct {
		call OwnersCall
		want string // "" = good; else a part of the problem
	}{
		"each kind":              {OwnersCall{"one-way", "A release cannot be taken back"}, ""},
		"scope":                  {OwnersCall{"scope", "Which teams get the beta"}, ""},
		"280 characters":         {OwnersCall{"taste", strings.Repeat("é", 280)}, ""},
		"nothing":                {OwnersCall{}, "Decide this yourself"},
		"no reason":              {OwnersCall{"taste", "  "}, "Decide this yourself"},
		"no kind":                {OwnersCall{"", "Your voice"}, "Decide this yourself"},
		"a kind that is unknown": {OwnersCall{"whim", "Your voice"}, "Decide this yourself"},
		"281 characters":         {OwnersCall{"values", strings.Repeat("x", 281)}, "at most 280"},
	} {
		got := tc.call.Problem()
		if (tc.want == "") != (got == "") || !strings.Contains(got, tc.want) {
			t.Errorf("%s: Problem() = %q, want %q", name, got, tc.want)
		}
	}
}
