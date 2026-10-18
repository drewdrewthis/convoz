package cli

func init() {
	Register(Command{Name: "rename", Summary: "Rename a conversation.", Example: "convoz rename --as code-review 41 \"Ship search filters\"", Order: 63, Run: Rename,
		Usage: "convoz rename <conv> <title|->"})
}
