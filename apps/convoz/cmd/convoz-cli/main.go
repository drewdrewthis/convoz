// Command convoz-cli is the Convoz client without the server: the binary a server hands out at /cli. It carries the commands of
// internal/cli and `convoz mcp`, and nothing of the server, the database or the web app, so it builds for four platforms without cgo
// and stays small enough for a server to embed all four.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	_ "github.com/drewdrewthis/convoz/apps/convoz/internal/mcp" // registers `convoz mcp`
)

const exitUsage = 2

// version is set at link time; cli.SetBuild falls back to the source revision.
var version = "dev"

func main() {
	cli.SetBuild(version)
	cli.SetBuiltins(cli.Builtin{Name: "version", Summary: "Print the version.", Usage: "convoz version"})
	if len(os.Args) < 2 {
		usage()
	}
	io := cli.IO{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv}
	switch os.Args[1] {
	case "version":
		fmt.Println(cli.VersionLine())
	case "help", "-h", "--help", "-help":
		os.Exit(help(os.Args[2:], io))
	default:
		cmd, ok := cli.Lookup(os.Args[1])
		if !ok {
			usage()
		}
		os.Exit(cmd.Run(os.Args[2:], io))
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "convoz: usage: "+strings.Join(append(cli.Usages(), "convoz version"), "\n       "))
	os.Exit(exitUsage)
}

func help(args []string, io cli.IO) int {
	if len(args) > 0 {
		if cmd, ok := cli.Lookup(args[0]); ok {
			return cmd.Run([]string{"--help"}, io)
		}
		fmt.Fprintf(os.Stderr, "convoz: unknown command %q; `convoz help` lists them\n", args[0])
		return exitUsage
	}
	cli.WriteHelp(os.Stdout)
	return 0
}
