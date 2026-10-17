package cli

func init() {
	Register(Command{Name: "brief", Order: 31, Run: Brief,
		Usage: "convoz brief [--max-bytes N] [--page N] [--json]"})
}
