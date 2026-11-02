package wire

import (
	"encoding/json"
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

func TestAskView_NoteIsForAnAskTheOwnerRepliedTo(t *testing.T) {
	if got := (AskView{State: "closed", CloseReason: "replied"}).Note(); got != RepliedNote {
		t.Errorf("Note() = %q, want %q", got, RepliedNote)
	}
	for _, a := range []AskView{{State: "closed", CloseReason: "withdrawn"}, {State: "open"}, {State: "answered"}} {
		if got := a.Note(); got != "" {
			t.Errorf("%s %s: Note() = %q, want none", a.State, a.CloseReason, got)
		}
	}
}

func goodPermission() AskPermission {
	return AskPermission{Action: "Merge PR 415", Risk: "Checkout breaks", Undo: "Revert the merge", Considered: []string{"Hold: costs a day"}, Confidence: 90}
}

func TestAskPermission_Problem(t *testing.T) {
	r := func(n int) string { return strings.Repeat("é", n) } // code points, not bytes
	for name, tc := range map[string]struct {
		mut  func(*AskPermission)
		want string // "" = good; else a part of the problem
	}{
		"a good one":              {func(*AskPermission) {}, ""},
		"one-way instead of undo": {func(p *AskPermission) { p.Undo, p.OneWay = "", true }, ""},
		"limits exactly": {func(p *AskPermission) {
			p.Action, p.Risk, p.Undo, p.Considered = r(100), r(140), r(80), []string{r(120), "b", "c"}
		}, ""},
		"action of 101":                {func(p *AskPermission) { p.Action = r(101) }, "Shorten: action has at most 100 characters"},
		"risk of 141":                  {func(p *AskPermission) { p.Risk = r(141) }, "Shorten: risk has at most 140 characters"},
		"undo of 81":                   {func(p *AskPermission) { p.Undo = r(81) }, "Shorten: undo has at most 80 characters"},
		"a considered line of 121":     {func(p *AskPermission) { p.Considered = []string{r(121)} }, "Shorten: considered has at most 120 characters"},
		"an empty action":              {func(p *AskPermission) { p.Action = "" }, "action"},
		"a whitespace-only risk":       {func(p *AskPermission) { p.Risk = "  \t" }, "risk"},
		"a whitespace-only considered": {func(p *AskPermission) { p.Considered = []string{" "} }, "considered"},
		"undo and one-way together":    {func(p *AskPermission) { p.OneWay = true }, "undo"},
		"neither undo nor one-way":     {func(p *AskPermission) { p.Undo = "" }, "undo"},
		"no considered":                {func(p *AskPermission) { p.Considered = nil }, "considered"},
		"4 considered":                 {func(p *AskPermission) { p.Considered = []string{"a", "b", "c", "d"} }, "considered"},
		"confidence -1":                {func(p *AskPermission) { p.Confidence = -1 }, "confidence"},
		"confidence 101":               {func(p *AskPermission) { p.Confidence = 101 }, "confidence"},
		"confidence 79":                {func(p *AskPermission) { p.Confidence = 79 }, GetConfidentFirst},
		"confidence missing":           {func(p *AskPermission) { p.Confidence = 0 }, GetConfidentFirst},
		"confidence 80":                {func(p *AskPermission) { p.Confidence = 80 }, ""},
	} {
		p := goodPermission()
		tc.mut(&p)
		got := p.Problem()
		if (tc.want == "") != (got == "") || !strings.Contains(got, tc.want) {
			t.Errorf("%s: Problem() = %q, want %q", name, got, tc.want)
		}
	}
}

func TestGetConfidentFirst_IsOneText(t *testing.T) {
	want := "Get confident first: research it or run it by @advisor, then ask with --confidence 80 or more. Never hand the owner the thinking."
	if GetConfidentFirst != want || MinConfidence != 80 {
		t.Errorf("GetConfidentFirst = %q, MinConfidence = %d", GetConfidentFirst, MinConfidence)
	}
}

func TestAskPermission_ConfidenceIsAnIntegerOnTheWire(t *testing.T) {
	var p AskPermission
	if err := json.Unmarshal([]byte(`{"confidence":80.5}`), &p); err == nil {
		t.Errorf("a confidence of 80.5 decoded as %d, want an error", p.Confidence)
	}
}

func TestAskRequest_PermissionNeedsNoOwnersCallAndIsAbsentOtherwise(t *testing.T) {
	p := goodPermission()
	if got := (AskRequest{Permission: &p}).OwnersCallProblem(); got != "" {
		t.Errorf("a permission ask needs no owner's call, got %q", got)
	}
	raw, _ := json.Marshal(AskRequest{ConversationID: 1})
	if strings.Contains(string(raw), "permission") {
		t.Errorf("an ask without a permission carries none: %s", raw)
	}
	raw, _ = json.Marshal(AskView{Kind: "permission", Permission: &p})
	for _, want := range []string{`"kind":"permission"`, `"action":"Merge PR 415"`, `"considered":["Hold: costs a day"]`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("AskView JSON lacks %s: %s", want, raw)
		}
	}
}
