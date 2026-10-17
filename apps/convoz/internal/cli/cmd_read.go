package cli

func init() {
	Register(Command{Name: "read", Order: 60, Run: Read,
		Usage: "convoz read [--since ID] [--limit N] <conv>"})
}
