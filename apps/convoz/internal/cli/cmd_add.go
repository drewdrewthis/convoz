package cli

func init() {
	Register(Command{Name: "add", Order: 61, Run: Add,
		Usage: "convoz add <conv> @agent"})
}
