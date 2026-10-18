package cli

func init() {
	Register(Command{Name: "read", Summary: "Read a conversation.", Example: "convoz read --as code-review 41", Order: 60, Run: Read,
		Usage: "convoz read [--since ID] [--limit N] [--thread ID] <conv>"})
}
