package cli

import (
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// maxStatusText is the longest "doing" and "next" (schema agent_status).
const maxStatusText = 200

// StatusStates are the states an agent may report.
var StatusStates = []string{"idle", "working", "blocked", "waiting"}

// Status runs `convoz status --state S [--doing D] [--next N]`: what the agent is doing now and next, shown to the owner
// in Crew. The status is the agent's, shared by all its sessions.
func Status(args []string, io IO) int {
	f := newChatFlags("status", io)
	state := f.fs.String("state", "", "idle, working, blocked or waiting")
	doing := f.fs.String("doing", "", "what the agent is doing now, at most 200 characters")
	next := f.fs.String("next", "", "what it does next, at most 200 characters")
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz status --state S [--doing D] [--next N]")
	}
	if !slices.Contains(StatusStates, *state) {
		return usageError(io, "--state is idle, working, blocked or waiting")
	}
	if utf8.RuneCountInString(*doing) > maxStatusText || utf8.RuneCountInString(*next) > maxStatusText {
		return usageError(io, fmt.Sprintf("--doing and --next are at most %d characters", maxStatusText))
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if err := k.callRetry("PUT", wire.RouteStatus, wire.StatusRequest{State: *state, Doing: *doing, Next: *next}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]string{"state": *state, "doing": *doing, "next": *next})
	}
	return ExitOK
}
