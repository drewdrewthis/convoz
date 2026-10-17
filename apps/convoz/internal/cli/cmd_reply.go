package cli

func init() {
	Register(Command{Name: "reply", Order: 51, Run: Reply,
		Usage: "convoz reply [--broadcast] [--format F] [--app FILE] [--client-id C] <conv> <message> <text|->"})
}
