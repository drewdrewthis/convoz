package cli

func init() {
	Register(Command{Name: "leave", Summary: "Leave a conversation.", Example: "convoz leave --as code-review 41", Order: 62, Run: Leave,
		Usage: "convoz leave <conv>"})
}
