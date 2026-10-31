package ask_test

import "testing"

// A permission ask shows its machine action, so an action of two words is no refusal.
func TestCreate_PermissionAskWithAShortActionIsNotJudgedAsASentence(t *testing.T) {
	s := world(t)
	p, _ := ports()
	pm := perm()
	pm.Action = "Merge it"
	if a := get(t, s, opened(t, s, p, pm)); a.Question != "Merge it" {
		t.Fatalf("question %q, want the action", a.Question)
	}
}
