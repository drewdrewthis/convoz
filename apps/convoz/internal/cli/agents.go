package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Agents runs `convoz agents [--json]`: the other active agents, so an agent can find the handle to give `convoz new --with`.
// One line each: @handle, state, display name and, when the agent wrote one, its description.
func Agents(args []string, io IO) int {
	f := newChatFlags("agents", io)
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz agents [--json]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out wire.AgentsResponse
	if err := k.call(ctx, "GET", wire.RouteAgents, nil, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"agents": append([]wire.AgentRow{}, out.Agents...)})
		return ExitOK
	}
	for _, a := range out.Agents {
		line := fmt.Sprintf("@%s  %s  %s", a.Handle, a.State, plain(a.DisplayName))
		if a.Description != "" {
			line += "  " + plain(a.Description)
		}
		fmt.Fprintln(k.io.Stdout, strings.TrimSpace(line))
	}
	return ExitOK
}
