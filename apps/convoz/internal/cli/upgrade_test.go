package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOutOfDate(t *testing.T) {
	for _, c := range []struct {
		local, server string
		want          bool
	}{
		{"abc1234def56", "abc1234def56", false},
		{"abc1234def56+dirty", "abc1234", false}, // the agent address shows a short commit
		{"abc1234", "999aaaa", true},
		{"v1.2.0", "v1.3.0", true},
		{"dev", "abc1234", false}, // a development build is never told to upgrade
		{"", "abc1234", false},
		{"abc1234", "", false}, // a server that gives no version is not a reason to stop
	} {
		if got := outOfDate(c.local, c.server); got != c.want {
			t.Errorf("outOfDate(%q, %q) = %v, want %v", c.local, c.server, got, c.want)
		}
	}
}

func TestServerVersionIsAskedOncePerTenMinutes(t *testing.T) {
	dir := t.TempDir()
	asked := 0
	fetch := func(string) string { asked++; return "v2" }
	start := time.Unix(1_000_000, 0)

	if got := serverVersion(dir, "http://s", "v2", start, fetch); got != "v2" || asked != 1 {
		t.Fatalf("first call: %q, asked %d", got, asked)
	}
	if got := serverVersion(dir, "http://s", "v2", start.Add(9*time.Minute), fetch); got != "v2" || asked != 1 {
		t.Fatalf("within 10 minutes the kept answer is used: %q, asked %d", got, asked)
	}
	if serverVersion(dir, "http://s", "v2", start.Add(11*time.Minute), fetch); asked != 2 {
		t.Fatalf("after 10 minutes the server is asked again, asked %d", asked)
	}
	if serverVersion(dir, "http://other", "v2", start.Add(11*time.Minute), fetch); asked != 3 {
		t.Fatalf("another server is another question, asked %d", asked)
	}
}

func TestServerVersionDoesNotTrustAKeptAnswerThatBlocksAnUpgradedCLI(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_000_000, 0)
	old := func(string) string { return "old" }
	serverVersion(dir, "http://s", "old", now, old) // keeps "old"

	asked := 0
	fresh := func(string) string { asked++; return "new" }
	if got := serverVersion(dir, "http://s", "new", now.Add(time.Minute), fresh); got != "new" || asked != 1 {
		t.Fatalf("an upgraded binary must ask again: %q, asked %d", got, asked)
	}
	if got := serverVersion(dir, "http://s", "new", now.Add(2*time.Minute), fresh); got != "new" || asked != 1 {
		t.Fatalf("the new answer is kept: %q, asked %d", got, asked)
	}
}

func TestServerVersionStillRefusesAnOldCLIAfterADeploy(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_000_000, 0)
	fresh := func(string) string { return "new" }
	serverVersion(dir, "http://s", "new", now, fresh) // keeps "new"
	got := serverVersion(dir, "http://s", "old", now.Add(time.Minute), fresh)
	if !outOfDate("old", got) {
		t.Fatalf("an old binary must still be told to upgrade, server answer %q", got)
	}
}

func TestServerVersionKeepsAnOutOfDateAnswerForTheSameCLI(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	asked := 0
	fetch := func(string) string { asked++; return "new" }
	serverVersion(dir, "http://s", "old", now, fetch)
	serverVersion(dir, "http://s", "old", now.Add(time.Minute), fetch)
	if asked != 1 {
		t.Fatalf("the same old CLI must not ask again within 10 minutes: asked %d", asked)
	}
}

func TestServerVersionKeepsNoAnswerThatFailed(t *testing.T) {
	dir := t.TempDir()
	asked := 0
	fetch := func(string) string { asked++; return "" }
	now := time.Unix(1_000_000, 0)
	serverVersion(dir, "http://s", "v2", now, fetch)
	serverVersion(dir, "http://s", "v2", now, fetch)
	if asked != 2 {
		t.Fatalf("a failed question is asked again, asked %d", asked)
	}
}

func TestVerifySHA256(t *testing.T) {
	body := []byte("a binary")
	sum := sha256.Sum256(body)
	good := hex.EncodeToString(sum[:])
	for name, c := range map[string]struct {
		file string
		ok   bool
	}{
		"sha256sum line":  {good + "  convoz-linux-amd64\n", true},
		"bare digest":     {good + "\n", true},
		"upper case":      {strings.ToUpper(good), true},
		"another digest":  {strings.Repeat("0", 64) + "  convoz-linux-amd64\n", false},
		"empty":           {"", false},
		"not a digest":    {"<html>404</html>", false},
		"digest too long": {good + "00", false},
	} {
		if err := verifySHA256(body, c.file); (err == nil) != c.ok {
			t.Errorf("%s: err = %v, want ok=%v", name, err, c.ok)
		}
	}
}

func TestReplaceExecutableSwapsTheFileWholeAndLeavesNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "convoz")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	if string(got) != "new" || info.Mode().Perm() != 0o755 {
		t.Fatalf("content %q mode %v", got, info.Mode())
	}
	if left, _ := os.ReadDir(dir); len(left) != 1 {
		t.Fatalf("a temporary file is left: %v", left)
	}
}

func TestReplaceExecutableLeavesTheOldBinaryWhenItCannotWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "convoz")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o755)
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	if err := replaceExecutable(path, []byte("new")); err == nil {
		t.Fatal("a read-only folder must be an error")
	}
	if got, _ := os.ReadFile(path); string(got) != "old" {
		t.Fatalf("the old binary changed: %q", got)
	}
}

func TestDecideVersion(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	never := time.Time{}
	cases := []struct {
		name   string
		local  string
		server serverInfo
		warned time.Time
		want   versionAction
	}{
		{"same build runs", "abc1234", serverInfo{"abc1234", 1}, never, versionRun},
		{"newer server warns", "abc1234", serverInfo{"999aaaa", 1}, never, versionWarn},
		{"server before the api field warns, does not refuse", "abc1234", serverInfo{"999aaaa", 0}, never, versionWarn},
		{"warned 10 minutes ago stays quiet", "abc1234", serverInfo{"999aaaa", 1}, now.Add(-10 * time.Minute), versionRun},
		{"warned 61 minutes ago warns again", "abc1234", serverInfo{"999aaaa", 1}, now.Add(-61 * time.Minute), versionWarn},
		{"another api refuses", "abc1234", serverInfo{"999aaaa", 2}, never, versionRefuse},
		{"another api refuses even when quiet", "abc1234", serverInfo{"999aaaa", 2}, now, versionRefuse},
		{"dev build never acts", "dev", serverInfo{"999aaaa", 2}, never, versionRun},
		{"server with no version runs", "abc1234", serverInfo{"", 0}, never, versionRun},
	}
	for _, c := range cases {
		if got := decideVersion(c.local, c.server, c.warned, now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestWarnStampIsKept(t *testing.T) {
	dir := t.TempDir()
	if !lastWarned(dir).IsZero() {
		t.Fatal("no stamp yet")
	}
	now := time.Unix(1_000_000, 0)
	markWarned(dir, now)
	if got := lastWarned(dir); !got.Equal(now) {
		t.Fatalf("stamp: got %v want %v", got, now)
	}
}
