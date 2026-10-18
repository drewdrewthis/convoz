package cli

import (
	"fmt"
	stdio "io"
	"sort"
	"strings"
)

// Command is one `convoz <name>` subcommand of the CLI.
type Command struct {
	Name string
	// Usage is the usage line(s) without the leading "convoz: usage: ".
	Usage string
	// Summary is the one line `convoz help` shows for the command.
	Summary string
	// Example is one command line that works, shown at the end of `convoz <name> --help`.
	Example string
	// Subs are the words a command splits on (`session start|end`); help shows the flags of each.
	Subs []string
	// Order places the line in `convoz` usage (lower first); commands of later slices take higher numbers.
	Order int
	Run   func(args []string, io IO) int
}

var commands = map[string]Command{}

// Register adds a command. Each command registers itself from its own cmd_<name>.go in an init function, so a new
// command never edits a shared table. Two commands with one name is a build defect.
func Register(c Command) {
	if _, taken := commands[c.Name]; taken {
		panic(fmt.Sprintf("cli: command %q registered twice", c.Name))
	}
	run := c.Run
	c.Run = func(args []string, io IO) int {
		if !wantsHelp(args) {
			return run(args, io)
		}
		return printHelp(c, run, io)
	}
	commands[c.Name] = c
}

// wantsHelp is true when -h, -help or --help stands among the flags (before any "--").
func wantsHelp(args []string) bool {
	for _, a := range args {
		switch a {
		case "--":
			return false
		case "-h", "-help", "--help":
			return true
		}
	}
	return false
}

// printHelp prints a command's usage to stdout and exits 0. The flags are the command's own: its flag set prints them when run with
// -h, so this text cannot drift from what the command parses.
func printHelp(c Command, run func([]string, IO) int, io IO) int {
	fmt.Fprintf(io.Stdout, "convoz %s: %s\n\nUsage:\n  %s\n", c.Name, c.Summary, strings.ReplaceAll(c.Usage, "\n", "\n  "))
	quiet := io
	quiet.Stderr = stdio.Discard
	if len(c.Subs) == 0 {
		fmt.Fprintln(io.Stdout, "\nFlags:")
		run([]string{"-h"}, quiet)
	}
	for _, sub := range c.Subs {
		fmt.Fprintf(io.Stdout, "\nFlags of %s %s:\n", c.Name, sub)
		run([]string{sub, "-h"}, quiet)
	}
	fmt.Fprintf(io.Stdout, "\nExample:\n  %s\n", c.Example)
	return ExitOK
}

// Overview lists every command with its summary, one line each, in Order.
func Overview() []string {
	out := []string{}
	for _, c := range sorted() {
		out = append(out, fmt.Sprintf("%-8s %s", c.Name, c.Summary))
	}
	return out
}

// Lookup finds a registered command.
func Lookup(name string) (Command, bool) {
	c, ok := commands[name]
	return c, ok
}

// Usages lists every command's usage, in Order.
func Usages() []string {
	out := make([]string, 0, len(commands))
	for _, c := range sorted() {
		out = append(out, c.Usage)
	}
	return out
}

func sorted() []Command {
	list := make([]Command, 0, len(commands))
	for _, c := range commands {
		list = append(list, c)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Order != list[j].Order {
			return list[i].Order < list[j].Order
		}
		return list[i].Name < list[j].Name
	})
	return list
}
