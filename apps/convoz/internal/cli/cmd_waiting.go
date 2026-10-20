package cli

func init() {
	Register(Command{Name: "waiting", Summary: "What waits on the owner in every conversation (needs the read-all right).", Example: "convoz waiting --as triage --json", Order: 66, Run: Waiting,
		Usage: "convoz waiting [--json]"})
}
