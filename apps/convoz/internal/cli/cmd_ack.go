package cli

func init() {
	Register(Command{Name: "ack", Order: 80, Run: Ack,
		Usage: "convoz ack <id:token>..."})
}
