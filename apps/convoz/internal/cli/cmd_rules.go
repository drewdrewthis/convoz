package cli

import (
	"context"
	"flag"
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func init() {
	Register(Command{Name: "rules", Summary: "Print the rules of Convoz, from the server. Run it first.", Example: "convoz rules", Order: 29, Run: Rules,
		Usage: "convoz rules [--as HANDLE]"})
}

// Rules runs `convoz rules`: the rules text the server holds, so the skill file never has to change when a rule does.
func Rules(args []string, io IO) int {
	fs := flag.NewFlagSet("rules", flag.ContinueOnError)
	fs.String("as", io.Getenv("CONVOZ_AS"), "accepted and not used: the rules are the same for every agent")
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	server := credentialsServer(dir)
	if server == "" {
		return fail(io, errNotLoggedIn)
	}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	var out wire.RulesResponse
	if err := newClient(server).call(ctx, "GET", wire.RouteRules, "", nil, &out); err != nil {
		return fail(io, err)
	}
	fmt.Fprintln(io.Stdout, strings.TrimRight(out.Text, "\n"))
	return ExitOK
}
