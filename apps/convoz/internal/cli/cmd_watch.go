package cli

func init() {
	Register(Command{Name: "watch", Order: 90, Run: Watch,
		Usage: "convoz watch [--json]\n       (post, read, inbox, ack and watch also take --sid SID | --as HANDLE, --json and --timeout D)"})
}
