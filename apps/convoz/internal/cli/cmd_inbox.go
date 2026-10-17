package cli

func init() {
	Register(Command{Name: "inbox", Order: 70, Run: Inbox,
		Usage: "convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]"})
}
