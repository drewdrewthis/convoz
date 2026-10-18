// Command convoz is the Convoz server and CLI.
package main

import (
	"fmt"
	"os"
	"strings"

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
	case "version":
		fmt.Printf("convoz %s (schema %d)\n", version, platform.LatestVersion())
	default:
		// every client command comes from the CLI registry (internal/cli/cmd_<name>.go)
		cmd, ok := cli.Lookup(os.Args[1])
		if !ok {
			usage()
		}
		cli.Version = version
		os.Exit(cmd.Run(os.Args[2:], processIO()))
	}
}

func processIO() cli.IO {
	return cli.IO{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv}
}

func usage() {
	lines := append([]string{"convoz serve --data-dir D --host NAME[:PORT] [--kek-file F] [--listen ADDR] [--admin-socket P] [--ready-file F] [--tailscale check|off] [--tailscale-bin B] [--transcribe auto|none]"},
		cli.Usages()...)
	fmt.Fprintln(os.Stderr, "convoz: usage: "+strings.Join(append(lines, "convoz version"), "\n       "))
	os.Exit(exitUsage)
}
