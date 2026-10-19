package cli

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafeName_NeverLeavesTheFolderOrMakesADotfile(t *testing.T) {
	for in, want := range map[string]string{
		"notes.txt":              "notes.txt",
		"../../.bashrc":          "bashrc",
		`..\..\evil`:             "evil",
		".profile":               "profile",
		"a b&c.txt":              "a_b_c.txt",
		"":                       "file",
		"...":                    "file",
		strings.Repeat("x", 300): strings.Repeat("x", 100),
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSaveTo_ADefaultPathIsNeverOverwritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "id_notes.txt")
	if _, err := saveTo(path, false, strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	if _, err := saveTo(path, false, strings.NewReader("second")); err == nil {
		t.Fatal("a second download to the default path must be refused")
	}
	if got, _ := os.ReadFile(path); string(got) != "first" {
		t.Fatalf("the file holds %q", got)
	}
}

func TestSaveTo_AChosenPathIsReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.txt")
	for _, body := range []string{"first", "second"} {
		if _, err := saveTo(path, true, strings.NewReader(body)); err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := os.ReadFile(path); string(got) != "second" {
		t.Fatalf("the file holds %q", got)
	}
}

func TestFile_AnIDThatStartsWithADashIsTakenAfterDashDash(t *testing.T) {
	cio := IO{Stderr: io.Discard, Stdout: io.Discard, Getenv: func(string) string { return "" }}
	f := newChatFlags("file", cio)
	f.fs.String("o", "", "")
	pos, ok := f.parse([]string{"-o", "-", "--", "-abcdefgh"}, cio)
	if !ok || len(pos) != 1 || pos[0] != "-abcdefgh" {
		t.Fatalf("pos %v ok %v", pos, ok)
	}
}
