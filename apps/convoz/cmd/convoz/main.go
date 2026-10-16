// Command convoz is the Convoz server and CLI.
package main

import (
	"fmt"
	"os"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// Exit codes (design §13.2).
const (
	exitUsage  = 2
	exitKey    = 10
	exitSchema = 11
	exitInUse  = 12
	exitWall   = 13 // the tailnet wall would be open: non-loopback listen, no --host, funnel on, tailscale unreadable
	exitAdmin  = 14 // the admin socket cannot be created or secured
)

// version is set at link time; "dev" otherwise.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(serve(os.Args[2:]))
	case "admin":
		os.Exit(cli.Admin(os.Args[2:], os.Stdout, os.Stderr))
	case "version":
		fmt.Printf("convoz %s (schema %d)\n", version, platform.LatestVersion())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: convoz serve --data-dir D --host NAME [--kek-file F] [--listen ADDR] [--admin-socket P] [--ready-file F] [--tailscale check|off] [--tailscale-bin B]\n"+
		"       convoz admin bootstrap-link [--admin-socket P]\n"+
		"       convoz version")
	os.Exit(exitUsage)
}
