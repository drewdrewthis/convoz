package cli

import (
	"encoding/json"
	stdio "io"
	"strings"
)

func init() {
	Register(Command{Name: "hook", Hidden: true, Summary: "Called by Claude Code hooks: tell the owner why you are stuck.", Example: "convoz hook resume", Order: 97, Run: hook,
		Subs:  []string{"notify", "resume"},
		Usage: "convoz hook notify   (the hook JSON on stdin)\nconvoz hook resume"})
}

// maxHookDoing keeps the status text inside the 200 characters a status takes, with room for the prefix.
const maxHookDoing = 200

// hook runs `convoz hook notify|resume`. It is called by Claude Code, so it never fails loudly and never blocks: every error
// (not logged in, no network, a bad payload) ends in exit 0 and silence.
func hook(args []string, io IO) int {
	if len(args) == 0 {
		return usageError(io, "usage: convoz hook notify|resume")
	}
	quiet := io
	quiet.Stderr, quiet.Stdout = stdio.Discard, stdio.Discard
	switch args[0] {
	case "notify":
		raw, _ := stdio.ReadAll(stdio.LimitReader(io.Stdin, 64<<10))
		var in struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &in)
		msg := strings.Join(strings.Fields(in.Message), " ")
		Status(append([]string{"--state", "blocked", "--doing", truncateRunes("Needs approval on its host: "+msg, maxHookDoing)}, args[1:]...), quiet)
	case "resume":
		Status(append([]string{"--state", "working"}, args[1:]...), quiet)
	default:
		return usageError(io, "usage: convoz hook notify|resume")
	}
	return ExitOK
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
