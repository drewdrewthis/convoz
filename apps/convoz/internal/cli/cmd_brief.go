package cli

func init() {
	Register(Command{Name: "brief", Summary: "Print what you need to know before you start.", Example: "convoz brief --as code-review", Order: 31, Run: Brief,
		Usage: "convoz brief [--max-bytes N] [--page N] [--json]"})
}
