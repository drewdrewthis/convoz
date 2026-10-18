package cli

func init() {
	Register(Command{Name: "handoff", Summary: "Leave or list notes for your next session.", Example: "convoz handoff --as code-review \"left off at the tests\"", Order: 32, Run: Handoff,
		Usage: "convoz handoff [--client-id C] <note|->\n       convoz handoff --list"})
}
