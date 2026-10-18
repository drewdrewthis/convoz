package cli

func init() {
	Register(Command{Name: "whoami", Summary: "Show the machine, identity and session you act as.", Example: "convoz whoami --as code-review --json", Order: 30, Run: Whoami,
		Usage: "convoz whoami [--sid SID | --as HANDLE] [--json]"})
}
