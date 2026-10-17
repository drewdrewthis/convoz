package cli

func init() {
	Register(Command{Name: "status", Order: 53, Run: Status,
		Usage: "convoz status --state idle|working|blocked|waiting [--doing D] [--next N]"})
}
