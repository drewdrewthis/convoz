package cli

func init() {
	Register(Command{Name: "waiting", Summary: "What waits on the owner in every conversation (needs a triage agent).", Example: "convoz waiting --as triage --json", Order: 66, Run: Waiting,
		Usage: "convoz waiting [--json]"})
}
