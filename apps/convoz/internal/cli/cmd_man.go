package cli

import "fmt"

func init() {
	Register(Command{Name: "man", Summary: "Print the manual page of convoz, in man format.", Example: "convoz man | man -l -", Order: 95, Run: man,
		Usage: "convoz man"})
}

// man runs `convoz man`: the manual page on standard output, so `convoz man | man -l -` shows it and the installer can save it.
func man(args []string, io IO) int {
	if len(args) != 0 {
		return usageError(io, "usage: convoz man")
	}
	fmt.Fprint(io.Stdout, ManPage())
	return ExitOK
}
