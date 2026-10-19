package cli

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestAllowedToolsReadOnlyByDefault(t *testing.T) {
	got := allowedTools(nil, false)
	for _, w := range []string{"Read(./**)", "Bash(convoz reply:*)", "Bash(gh pr view:*)"} {
		if !slices.Contains(got, w) {
			t.Errorf("read-only list lacks %s: %v", w, got)
		}
	}
	for _, bad := range []string{"Edit(./**)", "Write(./**)", "Bash(git log:*)", "Bash"} {
		if slices.Contains(got, bad) {
			t.Errorf("read-only list holds %s", bad)
		}
	}
}

func TestAllowedToolsWriteAndExtraAddWithoutDuplicates(t *testing.T) {
	got := allowedTools([]string{"Bash(gh run view:*)", "Grep"}, true)
	for _, w := range []string{"Edit(./**)", "Write(./**)", "Bash(gh run view:*)"} {
		if !slices.Contains(got, w) {
			t.Errorf("list lacks %s: %v", w, got)
		}
	}
	n := 0
	for _, g := range got {
		if g == "Grep" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("Grep appears %d times", n)
	}
}

func TestClaudeArgsPutThePromptBeforeTheVariadicFlags(t *testing.T) {
	c := claudeCall{Allow: []string{"Read(./**)", "Grep"}, Deny: denyTools, Budget: "1.00", Session: "s-1", Prompt: "hello"}
	want := []string{"-p", "--permission-mode", "dontAsk", "--max-budget-usd", "1.00", "--session-id", "s-1", "hello",
		"--allowedTools", "Read(./**),Grep", "--disallowedTools", "Bash(convoz * --file*),Bash(convoz * --app*)"}
	if got := c.args(); !reflect.DeepEqual(got, want) {
		t.Errorf("args\n got %q\nwant %q", got, want)
	}
	c.Resume = true
	if got := c.args(); got[5] != "--resume" {
		t.Errorf("a resumed session passes --resume: %q", got)
	}
}

func TestClaudeArgsWithoutToolsLeaveTheFlagsOut(t *testing.T) {
	got := claudeCall{Budget: "1.00", Session: "s", Prompt: "p"}.args()
	if strings.Contains(strings.Join(got, " "), "Tools") {
		t.Errorf("no tools were given: %q", got)
	}
}

func TestRunStateCountsTriesPerClaim(t *testing.T) {
	st := &runState{}
	if n := st.failed("5:aa"); n != 1 {
		t.Fatalf("first failure counts %d", n)
	}
	if n := st.failed("5:bb"); n != 1 {
		t.Fatalf("a new claim of the item starts again, got %d", n)
	}
	if n := st.failed("5:aa"); n != 2 {
		t.Fatalf("second failure counts %d", n)
	}
	st.forget("5:aa")
	if st.Tries["5:aa"] != 0 {
		t.Error("a finished item is forgotten")
	}
}

func TestRunStateSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devtool.json")
	st := &runState{SessionID: "abc", Items: 3, Tries: map[string]int{"1:x": 1}}
	if err := st.save(path); err != nil {
		t.Fatal(err)
	}
	got := loadRunState(path)
	if got.SessionID != "abc" || got.Items != 3 || got.Tries["1:x"] != 1 {
		t.Errorf("state after a restart: %+v", got)
	}
	if loadRunState(filepath.Join(t.TempDir(), "none.json")).Tries == nil {
		t.Error("a missing file gives a usable state")
	}
}

func TestRunLockRefusesASecondRunnerAndNamesItsPid(t *testing.T) {
	dir := t.TempDir()
	release, err := lockRun(dir, "devtool")
	if err != nil {
		t.Fatal(err)
	}
	_, err = lockRun(dir, "devtool")
	if err == nil || !strings.Contains(err.Error(), "already running (pid ") {
		t.Fatalf("second lock: %v", err)
	}
	if _, err := lockRun(dir, "other"); err != nil {
		t.Errorf("another agent has its own lock: %v", err)
	}
	release()
	if _, err := lockRun(dir, "devtool"); err != nil {
		t.Errorf("after release: %v", err)
	}
}

func TestClaudePromptCarriesRulesAndSummaryOnlyWhenGiven(t *testing.T) {
	p := claudePrompt("RULES-TEXT", "did X", "devtool", "7:tok conv 41 \"t\" mention x1 #9 @drew: hi")
	for _, w := range []string{"RULES-TEXT", "Summary of earlier work: did X", "untrusted", itemMarker, "#9 @drew: hi"} {
		if !strings.Contains(p, w) {
			t.Errorf("prompt lacks %q", w)
		}
	}
	q := claudePrompt("", "", "devtool", "item")
	if strings.Contains(q, "Summary of earlier work") || strings.Contains(q, "RULES") {
		t.Errorf("nothing to carry: %q", q)
	}
}
