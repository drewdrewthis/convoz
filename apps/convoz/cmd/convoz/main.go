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
	cli.SetBuild(version)
	version = cli.Version
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "help", "-h", "--help", "-help":
		os.Exit(help(os.Args[2:]))
	case "serve":
		os.Exit(serve(os.Args[2:]))
	case "version":
		fmt.Printf("%s (schema %d)\n", cli.VersionLine(), platform.LatestVersion())
	default:
		// every client command comes from the CLI registry (internal/cli/cmd_<name>.go)
		cmd, ok := cli.Lookup(os.Args[1])
		if !ok {
			usage()
		}
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

// help prints the commands with one line each, or with a command name that command's usage. Both go to stdout and exit 0.
func help(args []string) int {
	if len(args) > 0 {
		if cmd, ok := cli.Lookup(args[0]); ok {
			return cmd.Run([]string{"--help"}, processIO())
		}
		fmt.Fprintf(os.Stderr, "convoz: unknown command %q; `convoz help` lists them\n", args[0])
		return exitUsage
	}
	fmt.Println("convoz: usage: convoz <command> [flags]   (convoz <command> --help shows one command)")
	fmt.Println()
	fmt.Printf("%-8s %s\n%-8s %s\n", "serve", "Run the Convoz server.", "version", "Print the version.")
	for _, line := range cli.Overview() {
		fmt.Println(line)
	}
	return 0
}
