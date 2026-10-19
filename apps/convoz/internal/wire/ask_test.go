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

func TestOwnersCall_InYourNameIsForADraftAskOnly(t *testing.T) {
	if got := (OwnersCall{OwnersCallInYourName, "Because"}).Problem(); !strings.Contains(got, "draft ask only") {
		t.Errorf("Problem() = %q, want it to say the call is for a draft ask only", got)
	}
	if got := (AskRequest{Draft: &AskDraft{Text: "Hi"}}).OwnersCallProblem(); got != "" {
		t.Errorf("a draft ask needs no owner's call, got %q", got)
	}
	if got := (AskRequest{}).OwnersCallProblem(); !strings.Contains(got, "Decide this yourself") {
		t.Errorf("an ask with options still needs one, got %q", got)
	}
}

func TestAskDraft_LimitsAndTruncation(t *testing.T) {
	for name, tc := range map[string]struct {
		draft AskDraft
		want  string
	}{
		"plain":         {AskDraft{Text: "Hi"}, ""},
		"4000":          {AskDraft{Text: strings.Repeat("é", 4000)}, ""},
		"empty":         {AskDraft{Text: " "}, "needs the draft"},
		"4001":          {AskDraft{Text: strings.Repeat("x", 4001)}, "at most 4000"},
		"original 2001": {AskDraft{Text: "Hi", Original: strings.Repeat("x", 2001)}, "at most 2000"},
	} {
		got := tc.draft.Problem()
		if (tc.want == "") != (got == "") || !strings.Contains(got, tc.want) {
			t.Errorf("%s: Problem() = %q, want %q", name, got, tc.want)
		}
	}
	cut := TruncateOriginal(strings.Repeat("é", 2500))
	if n := len([]rune(cut)); n != 2000 || !strings.HasSuffix(cut, "…") {
		t.Errorf("TruncateOriginal kept %d characters, want 2000 ending with …", n)
	}
	if short := TruncateOriginal("Hi"); short != "Hi" {
		t.Errorf("a short original changed: %q", short)
	}
}
