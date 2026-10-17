package cli

import (
	"fmt"
	"sort"
)

// Command is one `convoz <name>` subcommand of the CLI.
type Command struct {
	Name string
	// Usage is the usage line(s) without the leading "convoz: usage: ".
	Usage string
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
	commands[c.Name] = c
}

// Lookup finds a registered command.
func Lookup(name string) (Command, bool) {
	c, ok := commands[name]
	return c, ok
}

// Usages lists every command's usage, in Order.
func Usages() []string {
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
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.Usage)
	}
	return out
}
