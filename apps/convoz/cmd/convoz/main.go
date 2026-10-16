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
	case "login":
		cli.Version = version
		os.Exit(cli.Login(os.Args[2:], processIO()))
	case "whoami":
		os.Exit(cli.Whoami(os.Args[2:], processIO()))
	case "session":
		os.Exit(session(os.Args[2:]))
	case "post":
		os.Exit(cli.Post(os.Args[2:], processIO()))
	case "read":
		os.Exit(cli.Read(os.Args[2:], processIO()))
	case "inbox":
		os.Exit(cli.Inbox(os.Args[2:], processIO()))
	case "ack":
		os.Exit(cli.Ack(os.Args[2:], processIO()))
	case "watch":
		os.Exit(cli.Watch(os.Args[2:], processIO()))
	case "version":
		fmt.Printf("convoz %s (schema %d)\n", version, platform.LatestVersion())
	default:
		usage()
	}
}

func processIO() cli.IO {
	return cli.IO{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv}
}

// session dispatches `convoz session start|end`.
func session(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "start":
			return cli.SessionStart(args[1:], processIO())
		case "end":
			return cli.SessionEnd(args[1:], processIO())
		}
	}
	fmt.Fprintln(os.Stderr, "usage: convoz session start --as HANDLE [--create --name NAME] [--label L] [--client-id C]\n       convoz session end [--sid SID]")
	return exitUsage
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: convoz serve --data-dir D --host NAME[:PORT] [--kek-file F] [--listen ADDR] [--admin-socket P] [--ready-file F] [--tailscale check|off] [--tailscale-bin B]\n"+
		"       convoz admin bootstrap-link [--admin-socket P]\n"+
		"       convoz login --server URL [--name N] [--store file|keychain|auto] [--stdin]\n"+
		"       convoz whoami [--sid SID | --as HANDLE] [--json]\n"+
		"       convoz session start|end ...\n"+
		"       convoz post [--format F] [--client-id C] <conv> <text|->\n"+
		"       convoz read [--since ID] [--limit N] <conv>\n"+
		"       convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]\n"+
		"       convoz ack <id:token>...\n"+
		"       convoz watch [--json]\n"+
		"       (post, read, inbox, ack and watch also take --sid SID | --as HANDLE, --json and --timeout D)\n"+
		"       convoz version")
	os.Exit(exitUsage)
}
