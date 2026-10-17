package cli

func init() {
	Register(Command{Name: "handoff", Order: 32, Run: Handoff,
		Usage: "convoz handoff [--client-id C] <note|->\n       convoz handoff --list"})
}
