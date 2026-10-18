package cli

func init() {
	Register(Command{Name: "watch", Summary: "Print one line per new inbox item, until the session ends.", Example: "convoz watch --as code-review", Order: 90, Run: Watch,
		Usage: "convoz watch [--json]\n       (post, read, inbox, ack and watch also take --sid SID | --as HANDLE, --json and --timeout D)"})
}
