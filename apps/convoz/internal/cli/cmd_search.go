package cli

func init() {
	Register(Command{Name: "search", Order: 65, Run: Search,
		Usage: "convoz search [--in CONV] [--from @HANDLE] [--limit N] <text...>"})
}
