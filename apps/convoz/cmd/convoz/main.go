// Command convoz is the Convoz server and CLI.
package main

import (
	"fmt"
	"os"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// Exit codes (design §13.2).
const (
	exitUsage  = 2
	exitKey    = 10
	exitSchema = 11
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
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: convoz serve --data-dir D [--kek-file F] [--listen ADDR] [--ready-file F] | convoz version")
	os.Exit(exitUsage)
}
