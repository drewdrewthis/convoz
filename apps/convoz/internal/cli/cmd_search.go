package cli

func init() {
	Register(Command{Name: "search", Summary: "Search messages.", Example: "convoz search --as code-review --in 41 build", Order: 65, Run: Search,
		Usage: "convoz search [--in CONV] [--from @HANDLE] [--limit N] <text...>"})
}
