package cli

func init() {
	Register(Command{Name: "inbox", Summary: "List or claim the items waiting for you.", Example: "convoz inbox --as code-review --peek", Order: 70, Run: Inbox,
		Usage: "convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]"})
}
