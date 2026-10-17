package cli

import "fmt"

func init() {
	Register(Command{Name: "session", Order: 40, Run: session, Usage: "convoz session start|end ..."})
}

// session dispatches `convoz session start|end`.
func session(args []string, io IO) int {
	if len(args) > 0 {
		switch args[0] {
		case "start":
			return SessionStart(args[1:], io)
		case "end":
			return SessionEnd(args[1:], io)
		}
	}
	fmt.Fprintln(io.Stderr, "convoz: usage: convoz session start --as HANDLE [--create --name NAME] [--label L] [--client-id C]\n       convoz session end [--sid SID]")
	return 2
}
