package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readSettings(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestMergeHooksMakesAMissingFileAndAddsNothingTwice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claude", "settings.json")
	for i, wantChanged := range []bool{true, false} {
		changed, err := MergeHooks(path)
		if err != nil || changed != wantChanged {
			t.Fatalf("run %d: changed=%v err=%v", i, changed, err)
		}
	}
	hooks := readSettings(t, path)["hooks"].(map[string]any)
	for _, event := range []string{"Notification", "UserPromptSubmit"} {
		if n := len(hooks[event].([]any)); n != 1 {
			t.Errorf("%s has %d entries, want 1", event, n)
		}
	}
}

func TestMergeHooksKeepsWhatIsThere(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	old := `{"model":"opus","hooks":{"Notification":[{"hooks":[{"type":"command","command":"notify-send hi"}]}],"Stop":[{"hooks":[]}]}}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := MergeHooks(path); err != nil {
		t.Fatal(err)
	}
	got := readSettings(t, path)
	hooks := got["hooks"].(map[string]any)
	if got["model"] != "opus" || hooks["Stop"] == nil || len(hooks["Notification"].([]any)) != 2 {
		t.Errorf("existing settings were not kept: %v", got)
	}
}

func TestMergeHooksLeavesABrokenFileAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{nope"), 0o600)
	if _, err := MergeHooks(path); err == nil {
		t.Fatal("a broken file must be an error")
	}
	if raw, _ := os.ReadFile(path); string(raw) != "{nope" {
		t.Errorf("the broken file was changed: %q", raw)
	}
}

// hook notify and resume exit 0 whatever happens (here: not logged in), and print nothing.
func TestHookNeverFails(t *testing.T) {
	var out, errOut strings.Builder
	io := IO{Stdin: strings.NewReader(`{"message":"Claude needs your permission to use Bash"}`), Stdout: &out, Stderr: &errOut, Getenv: func(string) string { return "" }}
	for _, sub := range []string{"notify", "resume"} {
		if code := hook([]string{sub}, io); code != 0 || out.Len()+errOut.Len() != 0 {
			t.Errorf("%s: exit %d, out %q err %q", sub, code, out.String(), errOut.String())
		}
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes(strings.Repeat("é", 300), 200); len([]rune(got)) != 200 {
		t.Errorf("got %d runes", len([]rune(got)))
	}
}
