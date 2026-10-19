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

	if got := serverVersion(dir, "http://s", start, fetch); got != "v2" || asked != 1 {
		t.Fatalf("first call: %q, asked %d", got, asked)
	}
	if got := serverVersion(dir, "http://s", start.Add(9*time.Minute), fetch); got != "v2" || asked != 1 {
		t.Fatalf("within 10 minutes the kept answer is used: %q, asked %d", got, asked)
	}
	if serverVersion(dir, "http://s", start.Add(11*time.Minute), fetch); asked != 2 {
		t.Fatalf("after 10 minutes the server is asked again, asked %d", asked)
	}
	if serverVersion(dir, "http://other", start.Add(11*time.Minute), fetch); asked != 3 {
		t.Fatalf("another server is another question, asked %d", asked)
	}
}

func TestServerVersionKeepsNoAnswerThatFailed(t *testing.T) {
	dir := t.TempDir()
	asked := 0
	fetch := func(string) string { asked++; return "" }
	now := time.Unix(1_000_000, 0)
	serverVersion(dir, "http://s", now, fetch)
	serverVersion(dir, "http://s", now, fetch)
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
