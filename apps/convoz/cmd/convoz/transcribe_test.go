package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

func TestTranscribeAutoReadsKeysFromTheCredentialsDirectory(t *testing.T) {
	defer transcript.SetDefault(transcript.None)
	dir := t.TempDir()
	if got := transcribeAuto(dir, transcript.DefaultEndpoints()); got != nil {
		t.Fatalf("no key must mean no engine: %v", got)
	}
	if got := transcribeAuto("", transcript.DefaultEndpoints()); got != nil || transcript.Default() != transcript.None {
		t.Fatalf("no directory must mean no engine: %v", got)
	}
	write := func(name, v string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("groq_api_key", "TESTONLY-g\n")
	write("gemini_api_key", "TESTONLY-m\n")
	got := transcribeAuto(dir, transcript.DefaultEndpoints())
	if len(got) != 2 || got[0] != "groq" || got[1] != "gemini" || transcript.Default() != "auto" {
		t.Fatalf("got %v default %q", got, transcript.Default())
	}
	if _, ok := transcript.Lookup("auto"); !ok {
		t.Fatal("auto is not registered")
	}
}
