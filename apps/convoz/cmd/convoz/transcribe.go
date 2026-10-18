package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

// transcribeAuto turns the keys systemd handed over into the server's transcription engine. Keys come from the credentials
// directory, never from flags, and nothing here logs one. With no key there is no engine and voice notes stay without words.
// It returns the names of the engines in the order they are tried.
func transcribeAuto(credDir string, ep transcript.Endpoints) []string {
	chain := transcript.NewChain(transcript.Keys{
		Groq:   readCredential(credDir, "groq_api_key"),
		OpenAI: readCredential(credDir, "openai_api_key"),
		Gemini: readCredential(credDir, "gemini_api_key"),
	}, ep)
	if chain == nil {
		return nil
	}
	transcript.Register("auto", chain)
	transcript.SetDefault("auto")
	return chain.Names()
}

// readCredential is the trimmed content of a credential file, empty when it is missing or unreadable.
func readCredential(dir, name string) string {
	if dir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
