package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
)

// The server-side commands (backup, restore, keys, workspace) live here and not in internal/cli: they open the data
// dir and the keyring, and the CLI package may not import internal/server (AC-16). They register in the same
// registry, so `convoz` usage lists them with the client commands.

// flags parses args for one command; a parse error or a stray argument is a usage error (exit 2).
func flags(name string, args []string, io io.Writer, define func(*flag.FlagSet)) (*flag.FlagSet, bool) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io)
	define(fs)
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		return fs, false
	}
	return fs, true
}

// usageFail prints the command's usage and returns the usage exit code.
func usageFail(io cli.IO, usage string) int {
	fmt.Fprintln(io.Stderr, "convoz: usage: "+usage)
	return exitUsage
}

// failWith prints err and maps it to an exit code: a key problem is 10, a busy data dir 12, anything else 1.
func failWith(io cli.IO, err error) int {
	fmt.Fprintf(io.Stderr, "convoz: %s\n", err)
	switch {
	case errors.Is(err, crypto.ErrKey):
		return exitKey
	case errors.Is(err, errInUse):
		return exitInUse
	}
	return 1
}

// absDir makes a data dir path absolute, as serve does.
func absDir(p string) (string, error) { return filepath.Abs(p) }
