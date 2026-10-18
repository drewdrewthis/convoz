package cli

func init() {
	Register(Command{Name: "status", Summary: "Tell the owner what you are doing.", Example: "convoz status --as code-review --state working --doing \"Fixing #412\"", Order: 53, Run: Status,
		Usage: "convoz status --state idle|working|blocked|waiting [--doing D] [--next N]"})
}
