package cli

func init() {
	Register(Command{Name: "watch", Summary: "Print one line per new inbox item, until the session ends (--once: only the first batch).", Example: "convoz watch --as code-review", Order: 90, Run: Watch,
		Usage: "convoz watch [--json] [--once]\n       (post, read, inbox, ack and watch also take --sid SID | --as HANDLE, --json and --timeout D)"})
}
